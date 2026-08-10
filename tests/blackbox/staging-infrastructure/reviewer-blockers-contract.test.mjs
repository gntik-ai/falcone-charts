/**
 * Black-box TDD for the independent reviewer blockers on the revision-20
 * staging repair. All lifecycle executions use offline fake Helm/Kubernetes
 * surfaces; OpenBao behavior runs in an isolated bubblewrap sandbox.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  readYaml,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const fixtureRoot = resolve(repoRoot, 'tests/blackbox/fixtures/staging-infrastructure')
const fakeBin = resolve(fixtureRoot, 'fake-bin')
const repairTool = resolve(umbrellaChart, 'migrations/revision-20-repair.sh')
const recoveryTool = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')
const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const externalSecretsFixture = resolve(fixtureRoot, 'external-secrets-ready.json')
const revision20Manifest = resolve(fixtureRoot, 'revision-20-ownership-manifest.json')
const phaseAAttestationTemplate = resolve(fixtureRoot, 'phase-a-attestation.template.json')
const backupTemplate = resolve(fixtureRoot, 'backup-attestation.template.json')
const parityTemplate = resolve(fixtureRoot, 'parity-attestation.template.json')
const repairDigest = 'sha256:0411041104110411041104110411041104110411041104110411041104110411'
const phaseAConfirmation = `default/in-falcone-staging/falcone@20/in-falcone-0.4.1->in-falcone-0.4.11/${repairDigest}`
const phaseBConfirmation = `default/in-falcone-staging/falcone@25/in-falcone-0.4.11/${repairDigest}`
const upgradeEvidenceArgs = [
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-non-secret-evidence',
]
const exactExternalSecretNames = readYaml(externalSecretsFixture).items.map((item) => item.metadata.name).sort()

const legacyPhaseAArgs = [
  '--phase-a', '--apply',
  '--confirm-target', 'default/in-falcone-staging/falcone@20',
  '--backup-reference', 'bbx-legacy-evidence',
]
const legacyPhaseBArgs = [
  '--phase-b', '--apply',
  '--confirm-target', 'default/in-falcone-staging/falcone@20',
  '--pvc-uid', 'bbx-pvc-uid',
  '--confirm-pvc', 'falcone-postgresql-vector-data/bbx-pvc-uid',
  '--backup-reference', 'bbx-legacy-evidence',
]
const repairHelpOutput = combined(run('/bin/bash', [repairTool, '--help']))
const structuredEvidenceCliAvailable = /--backup-attestation FILE/.test(repairHelpOutput)

function phaseAArgs(work) {
  const backup = materializeAttestation(backupTemplate, work, 'backup.json')
  const parity = materializeAttestation(parityTemplate, work, 'parity.json')
  if (!structuredEvidenceCliAvailable) return legacyPhaseAArgs
  return [
    '--phase-a', '--apply', '--confirm-target', phaseAConfirmation,
    '--backup-attestation', backup, '--parity-attestation', parity,
  ]
}

function phaseBArgs(work) {
  return phaseBArgsWithConfirmation(work, phaseBConfirmation)
}

function phaseBArgsWithConfirmation(work, confirmation) {
  const backup = materializeAttestation(backupTemplate, work, 'backup.json')
  const parity = materializeAttestation(parityTemplate, work, 'parity.json')
  const phaseA = materializeAttestation(phaseAAttestationTemplate, work, 'phase-a.json')
  if (!structuredEvidenceCliAvailable) return legacyPhaseBArgs
  return [
    '--phase-b', '--apply', '--confirm-target', confirmation,
    '--backup-attestation', backup, '--parity-attestation', parity,
    '--phase-a-attestation', phaseA,
    '--pvc-uid', 'bbx-pvc-uid', '--confirm-pvc', 'falcone-postgresql-vector-data/bbx-pvc-uid',
  ]
}

function forwardArgs(work, confirmation = phaseBConfirmation) {
  const backup = materializeAttestation(backupTemplate, work, 'backup.json')
  const parity = materializeAttestation(parityTemplate, work, 'parity.json')
  const phaseA = materializeAttestation(phaseAAttestationTemplate, work, 'phase-a.json')
  return [
    '--apply', '--confirm-target', confirmation,
    '--backup-attestation', backup, '--parity-attestation', parity,
    '--phase-a-attestation', phaseA,
  ]
}

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function materializeAttestation(template, work, filename, mutate = () => {}) {
  const document = JSON.parse(readFileSync(template, 'utf8'))
  const now = Date.now()
  document.evidence.observedAt = new Date(now - 60_000).toISOString()
  document.evidence.validUntil = new Date(now + 10 * 60_000).toISOString()
  if (document.repair) {
    document.repair.chart = 'in-falcone-0.4.11'
    document.repair.packageDigest = repairDigest
  }
  if (document.result) {
    document.result.chart = 'in-falcone-0.4.11'
    document.result.packageDigest = repairDigest
  }
  mutate(document)
  const path = resolve(work, filename)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  return path
}

function invokeMigration(tool, argsOrBuilder, scenario = 'safe', extraEnv = {}) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-reviewer-bbx-'))
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const operationLog = resolve(work, 'operations.log')
  const stateFile = resolve(work, 'pvc-state')
  const realHelm = run('/bin/sh', ['-c', 'command -v helm'])
  assertSuccess(realHelm, 'locating Helm')
  const args = typeof argsOrBuilder === 'function' ? argsOrBuilder(work) : argsOrBuilder
  const result = run('/bin/bash', [tool, ...args], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FALCONE_STAGING_REAL_HELM: realHelm.stdout.trim(),
      FALCONE_STAGING_HELM_LOG: helmLog,
      FALCONE_STAGING_KUBECTL_LOG: kubectlLog,
      FALCONE_STAGING_OPERATION_LOG: operationLog,
      FALCONE_STAGING_STATE_FILE: stateFile,
      FALCONE_STAGING_SCENARIO: scenario,
      FALCONE_STAGING_EXTERNAL_SECRETS_FIXTURE: externalSecretsFixture,
      FALCONE_STAGING_REVISION20_MANIFEST: revision20Manifest,
      FALCONE_STAGING_HELM_DELEGATE: realHelm.stdout.trim(),
      FALCONE_STAGING_PACKAGED_CHART_SOURCE: umbrellaChart,
      FALCONE_STAGING_REPAIR_PACKAGE_DIGEST: repairDigest,
      ...extraEnv,
    },
    timeout: 30_000,
  })
  const helmCalls = readLines(helmLog)
  const kubectlCalls = readLines(kubectlLog)
  return {
    result,
    helmCalls,
    kubectlCalls,
    operations: readLines(operationLog),
    helmMutations: helmCalls.filter((line) => /^(?:install|rollback|uninstall|upgrade)(?:\s|$)/.test(line)),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function assertSecretSuppressedSemanticDiff(invocation, label) {
  const diffCalls = invocation.helmCalls.filter((line) => /^diff upgrade(?:\s|$)/.test(line))
  assert.ok(diffCalls.length > 0, `${label} did not execute the semantic diff gate`)
  for (const call of diffCalls) assert.match(call, /(?:^|\s)--suppress-secrets(?:\s|$)/)
  assert.ok(!invocation.helmCalls.some((line) => /^get manifest(?:\s|$)/.test(line)),
    `${label} read a potentially secret-bearing live Helm manifest`)
  assert.doesNotMatch(combined(invocation.result), /(?:^|\n)kind:\s*Secret(?:\s|$)|(?:^|\n)(?:data|stringData):/,
    `${label} exposed a Secret payload surface`)
}

function renderUpgrade() {
  const result = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    '--is-upgrade', '-f', stagingValues,
    ...upgradeEvidenceArgs,
  ])
  assertSuccess(result, 'rendering repaired upgrade')
  return yamlDocuments(result.stdout)
}

function named(objects, kind, name, namespace) {
  return objects.find((object) => object?.kind === kind
    && object?.metadata?.name === name
    && (namespace === undefined || object?.metadata?.namespace === namespace))
}

function networkNamespaceState() {
  const readNamespace = (path) => {
    try {
      return { path, identity: readlinkSync(path), error: null }
    } catch (error) {
      return {
        path,
        identity: null,
        error: { name: error.name, message: error.message, code: error.code },
      }
    }
  }
  const self = readNamespace('/proc/self/ns/net')
  const init = readNamespace('/proc/1/ns/net')
  return {
    self,
    init,
    comparable: self.identity !== null && init.identity !== null,
    outerIsolated: self.identity !== null && init.identity !== null && self.identity !== init.identity,
  }
}

function runOpenBaoReconciler(script, scenario) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-openbao-bbx-'))
  const state = resolve(work, 'state')
  mkdirSync(state)
  const serviceAccount = resolve(work, 'serviceaccount')
  const canary = resolve(work, 'canary')
  const tls = resolve(work, 'tls')
  mkdirSync(serviceAccount)
  mkdirSync(canary)
  mkdirSync(tls)
  writeFileSync(resolve(serviceAccount, 'token'), 'synthetic-bbx-input')
  writeFileSync(resolve(canary, 'token'), 'synthetic-bbx-canary')
  writeFileSync(resolve(tls, 'ca.crt'), 'synthetic-bbx-ca')
  const log = resolve(work, 'bao.log')
  const networkNamespace = networkNamespaceState()
  let executionMode
  let result
  if (networkNamespace.outerIsolated) {
    executionMode = 'outer-network-namespace'
    const directScript = script
      .replaceAll('/canary/token', resolve(canary, 'token'))
      .replaceAll('/openbao/tls/ca.crt', resolve(tls, 'ca.crt'))
      .replaceAll('/var/run/secrets/kubernetes.io/serviceaccount/token', resolve(serviceAccount, 'token'))
    result = run('/bin/sh', ['-ec', directScript], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        FALCONE_OPENBAO_LOG: log,
        FALCONE_OPENBAO_STATE_DIR: state,
        FALCONE_OPENBAO_SCENARIO: scenario,
      },
      timeout: 30_000,
    })
  } else {
    executionMode = 'bubblewrap'
    const isolatedScript = script
      .replaceAll('/canary/token', '/tmp/work/canary/token')
      .replaceAll('/openbao/tls/ca.crt', '/tmp/work/tls/ca.crt')
      .replaceAll('/var/run/secrets/kubernetes.io/serviceaccount/token', '/tmp/work/serviceaccount/token')
    result = run('bwrap', [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      '--dir', '/tmp/work',
      '--bind', work, '/tmp/work',
      '--setenv', 'PATH', `${fakeBin}:${process.env.PATH}`,
      '--setenv', 'FALCONE_OPENBAO_LOG', '/tmp/work/bao.log',
      '--setenv', 'FALCONE_OPENBAO_STATE_DIR', '/tmp/work/state',
      '--setenv', 'FALCONE_OPENBAO_SCENARIO', scenario,
      '/bin/sh', '-ec', isolatedScript,
    ], { timeout: 30_000 })
    if (result.status !== 0 && /No permissions to create a new namespace|non-privileged user namespaces/.test(combined(result))) {
      executionMode = 'offline-fixture-after-bubblewrap-unavailable'
      const offlineScript = script
        .replaceAll('/canary/token', resolve(canary, 'token'))
        .replaceAll('/openbao/tls/ca.crt', resolve(tls, 'ca.crt'))
        .replaceAll('/var/run/secrets/kubernetes.io/serviceaccount/token', resolve(serviceAccount, 'token'))
      result = run('/bin/sh', ['-ec', offlineScript], {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          KUBECONFIG: resolve(repoRoot, 'tests/blackbox/fixtures/offline-kubeconfig.yaml'),
          HTTP_PROXY: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: 'localhost,127.0.0.1',
          FALCONE_OPENBAO_LOG: log,
          FALCONE_OPENBAO_STATE_DIR: state,
          FALCONE_OPENBAO_SCENARIO: scenario,
        },
        timeout: 30_000,
      })
    }
  }
  return {
    result,
    calls: readLines(log),
    executionMode,
    networkNamespace,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function reconcilerProcessDiagnostics(invocation) {
  const error = invocation.result.error
  return {
    executionMode: invocation.executionMode,
    networkNamespace: invocation.networkNamespace,
    status: invocation.result.status,
    signal: invocation.result.signal ?? null,
    error: error ? {
      name: error.name,
      message: error.message,
      code: error.code,
      errno: error.errno,
      syscall: error.syscall,
      path: error.path,
    } : null,
    output: combined(invocation.result),
    calls: invocation.calls,
  }
}

// bbx-repair-staging-015 | fn-forward-only-recovery | OpenSpec #### Scenario: Apply fails after deletion
test('all mutation paths fail forward without implicit or explicit Helm rollback', () => {
  const cases = [
    ['phase-a', repairTool, legacyPhaseAArgs, 'phase-a-helm-failure'],
    ['phase-b', repairTool, legacyPhaseBArgs, 'phase-b-post-delete-helm-failure'],
    ['forward-recovery', recoveryTool, [
      '--apply', '--confirm-target', 'default/in-falcone-staging/falcone',
      '--backup-reference', 'bbx-legacy-evidence',
    ], 'forward-helm-failure'],
  ]
  const violations = []
  for (const [label, tool, args, scenario] of cases) {
    const invocation = invokeMigration(tool, args, scenario)
    try {
      assert.notEqual(invocation.result.status, 0, `${label} failure unexpectedly succeeded`)
      const apply = invocation.helmCalls.find((line) => /^upgrade(?:\s|$)/.test(line)) ?? ''
      if (/--atomic(?:\s|$)/.test(apply)) violations.push(`${label}:implicit-rollback`)
      if (invocation.helmCalls.some((line) => /^rollback(?:\s|$)/.test(line))) violations.push(`${label}:explicit-rollback`)
      if (!/FORWARD_RECOVERY_REQUIRED/.test(combined(invocation.result))) violations.push(`${label}:missing-forward-instruction`)
      if (label === 'phase-b') {
        const deletion = invocation.operations.findIndex((line) => /kubectl .*delete pvc falcone-postgresql-vector-data/.test(line))
        const failedApply = invocation.operations.findIndex((line) => /helm upgrade falcone/.test(line))
        assert.ok(deletion >= 0 && failedApply > deletion, 'failure injection did not occur after exact PVC deletion')
      }
    } finally {
      invocation.cleanup()
    }
  }
  assert.deepEqual(violations, [])
})

// bbx-repair-staging-016 | fn-revision20-source-gate | OpenSpec #### Scenario: PVC state changes
test('Phase A rejects revision 20 unless its actual starting chart is exactly in-falcone-0.4.1', () => {
  const invocation = invokeMigration(repairTool, legacyPhaseAArgs, 'wrong-start-chart')
  try {
    assert.notEqual(invocation.result.status, 0)
    assert.match(combined(invocation.result), /STARTING_CHART_MISMATCH expected=in-falcone-0\.4\.1 actual=in-falcone-0\.4\.2/)
    assert.deepEqual(invocation.helmMutations, [])
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-017 | fn-repair-evidence-cli | OpenSpec #### Scenario: PVC state changes
test('repair CLI exposes separate backup, parity, phase-A attestation, and package-bound confirmation inputs', () => {
  const help = run('/bin/bash', [repairTool, '--help'])
  assertSuccess(help, 'revision-20 repair help')
  const output = combined(help)
  assert.match(output, /--backup-attestation FILE/)
  assert.match(output, /--parity-attestation FILE/)
  assert.match(output, /--phase-a-attestation FILE/)
  assert.match(output, /CURRENT_REVISION\/CHART\/PACKAGE_DIGEST/)

  const forwardHelp = run('/bin/bash', [recoveryTool, '--help'])
  assertSuccess(forwardHelp, 'forward-recovery help')
  assert.match(combined(forwardHelp), /--phase-a-attestation FILE/)
  assert.match(combined(forwardHelp), /--backup-attestation FILE/)
  assert.match(combined(forwardHelp), /--parity-attestation FILE/)
})

// bbx-repair-staging-018 | fn-repair-evidence-validation | OpenSpec #### Scenario: PVC state changes
test('opaque, expired, and target-mismatched backup/parity evidence is rejected before mutation', () => {
  const invalid = []
  const opaque = invokeMigration(repairTool, legacyPhaseAArgs)
  try {
    if (opaque.result.status === 0 || opaque.helmMutations.length > 0) invalid.push('opaque-single-reference')
  } finally {
    opaque.cleanup()
  }

  const stale = invokeMigration(repairTool, (work) => {
    const backup = materializeAttestation(backupTemplate, work, 'backup.json', (document) => {
      document.evidence.validUntil = new Date(Date.now() - 60_000).toISOString()
    })
    const parity = materializeAttestation(parityTemplate, work, 'parity.json')
    return [
      '--phase-a', '--apply', '--confirm-target', phaseAConfirmation,
      '--backup-attestation', backup, '--parity-attestation', parity,
    ]
  })
  try {
    if (!/EVIDENCE_EXPIRED kind=Revision20BackupEvidence/.test(combined(stale.result))) invalid.push('expired-backup')
    if (stale.helmMutations.length > 0) invalid.push('expired-backup-mutated')
  } finally {
    stale.cleanup()
  }

  const mismatched = invokeMigration(repairTool, (work) => {
    const backup = materializeAttestation(backupTemplate, work, 'backup.json')
    const parity = materializeAttestation(parityTemplate, work, 'parity.json', (document) => {
      document.target.namespace = 'somewhere-else'
    })
    return [
      '--phase-a', '--apply', '--confirm-target', phaseAConfirmation,
      '--backup-attestation', backup, '--parity-attestation', parity,
    ]
  })
  try {
    if (!/EVIDENCE_TARGET_MISMATCH kind=Revision20ParityEvidence/.test(combined(mismatched.result))) invalid.push('mismatched-parity')
    if (mismatched.helmMutations.length > 0) invalid.push('mismatched-parity-mutated')
  } finally {
    mismatched.cleanup()
  }
  assert.deepEqual(invalid, [])
})

// bbx-repair-staging-019 | fn-phase-a-attestation-gate | OpenSpec #### Scenario: PVC state changes
test('Phase B rejects missing, stale, or live-revision-mismatched Phase-A attestation and hard-coded revision-20 confirmation', () => {
  const invalid = []
  const missing = invokeMigration(repairTool, legacyPhaseBArgs, 'phase-a-complete')
  try {
    if (missing.result.status === 0 || missing.helmMutations.length > 0) invalid.push('missing-attestation-accepted')
    if (!/PHASE_A_ATTESTATION_REQUIRED/.test(combined(missing.result))) invalid.push('missing-attestation-code')
  } finally {
    missing.cleanup()
  }

  for (const [label, mutate, code] of [
    ['stale', (document) => { document.evidence.validUntil = new Date(Date.now() - 60_000).toISOString() }, 'PHASE_A_ATTESTATION_STALE'],
    ['revision-mismatch', (document) => { document.result.revision = '21' }, 'PHASE_A_ATTESTATION_MISMATCH'],
  ]) {
    const invocation = invokeMigration(repairTool, (work) => {
      const phaseA = materializeAttestation(phaseAAttestationTemplate, work, 'phase-a.json', mutate)
      return [
        '--phase-b', '--apply', '--confirm-target', phaseBConfirmation,
        '--phase-a-attestation', phaseA,
        '--pvc-uid', 'bbx-pvc-uid', '--confirm-pvc', 'falcone-postgresql-vector-data/bbx-pvc-uid',
      ]
    }, 'phase-a-complete')
    try {
      if (!new RegExp(code).test(combined(invocation.result))) invalid.push(`${label}-code`)
      if (invocation.helmMutations.length > 0) invalid.push(`${label}-mutated`)
    } finally {
      invocation.cleanup()
    }
  }
  assert.deepEqual(invalid, [])
})

// bbx-repair-staging-020 | fn-vector-pvc-real-topology | OpenSpec #### Scenario: PVC state changes
test('initial Pending StatefulSet Pod is allowed, then exact scale-to-zero and wait precede final evidence reread and delete', () => {
  const invocation = invokeMigration(repairTool, phaseBArgs, 'initial-pending-vector-pod')
  try {
    assertSuccess(invocation.result, 'Phase B with the actual initial Pending vector Pod topology')
    const scale = invocation.operations.findIndex((line) => /kubectl -n in-falcone-staging scale statefulset falcone-postgresql-vector --replicas=0/.test(line))
    const wait = invocation.operations.findIndex((line) => /kubectl -n in-falcone-staging wait .*postgresql-vector/.test(line))
    const deletion = invocation.operations.findIndex((line) => /kubectl -n in-falcone-staging delete pvc falcone-postgresql-vector-data/.test(line))
    const finalPodRead = invocation.operations.map((line, index) => [line, index])
      .filter(([line, index]) => index > scale && /kubectl -n in-falcone-staging get pods .* -o json/.test(line))
      .at(-1)?.[1] ?? -1
    assert.ok(scale >= 0, 'exact vector StatefulSet was not scaled down')
    assert.ok(wait > scale, 'scale-to-zero was not followed by a bounded Pod termination wait')
    assert.ok(finalPodRead > wait, 'final Pod evidence was not reread after the scale/wait boundary')
    assert.ok(deletion > finalPodRead, 'PVC deletion preceded final post-confirmation evidence')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-021 | fn-external-secret-exact-health | OpenSpec #### Scenario: External controller is reused
test('Phase A accepts only the exact fourteen named ExternalSecrets with Ready=True', () => {
  const unsafe = []
  for (const scenario of ['external-secrets-zero', 'external-secrets-partial', 'external-secrets-duplicate', 'external-secrets-notready']) {
    const invocation = invokeMigration(repairTool, phaseAArgs, scenario)
    try {
      if (invocation.result.status === 0 || invocation.helmMutations.length > 1) unsafe.push(scenario)
    } finally {
      invocation.cleanup()
    }
  }
  assert.deepEqual(unsafe, [])

  const ready = invokeMigration(repairTool, phaseAArgs)
  try {
    assertSuccess(ready.result, 'Phase A with the exact fourteen Ready ExternalSecrets')
  } finally {
    ready.cleanup()
  }

  assert.equal(exactExternalSecretNames.length, 14)
  assert.equal(new Set(exactExternalSecretNames).size, 14)
})

// bbx-repair-staging-022 | fn-phase-a-final-health | OpenSpec #### Scenario: Metadata already matches
test('the no-root Phase-A pass reruns owner, image, auth-unchanged, store, fourteen-secret, FerretDB, and endpoint gates', () => {
  const invocation = invokeMigration(repairTool, phaseAArgs, 'post-no-root-health-regression')
  try {
    assert.notEqual(invocation.result.status, 0, 'post-no-root health regression was reported as successful Phase A')
    assert.match(combined(invocation.result), /FINAL_HEALTH_GATE_FAILED/)
    assert.ok(invocation.kubectlCalls.filter((line) => line === '-n in-falcone-staging get externalsecrets.external-secrets.io -o json').length >= 2)
    assert.ok(invocation.kubectlCalls.filter((line) => /wait --for=condition=Ready clustersecretstore\/openbao-backend/.test(line)).length >= 2)
    assert.ok(invocation.kubectlCalls.filter((line) => /deployment\/falcone-ferretdb/.test(line)).length >= 2)
    assert.ok(invocation.kubectlCalls.some((line) => line === '-n secret-store logs job/openbao-auth-reconcile'))
    assert.ok(invocation.kubectlCalls.filter((line) => line === '-n external-secrets get deployment external-secrets -o json').length >= 2)
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-023 | fn-revision20-owner-topology | OpenSpec #### Scenario: External controller is reused
test('sanitized revision-20 fixture preserves the real bundled topology while canonical render keeps only Falcone integration resources', () => {
  const fixture = JSON.parse(readFileSync(revision20Manifest, 'utf8'))
  assert.deepEqual(fixture.source, {
    commit: '7c2775f4d845',
    chart: 'in-falcone-0.4.1',
    release: 'falcone',
    revision: '20',
    namespace: 'in-falcone-staging',
    sanitized: true,
  })
  assert.equal(fixture.bundledOperatorResources.length, 30)
  assert.equal(fixture.liveExternalOwnerResources.length, 21)
  assert.equal(fixture.liveExternalOwnerNamespace.helmAnnotated, false)
  assert.equal(fixture.falconeIntegrationResources.length, 15)

  const render = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging', '--include-crds', '-f', stagingValues,
  ])
  assertSuccess(render, 'canonical external-ESO staging render')
  const objects = yamlDocuments(render.stdout)
  const integrations = objects.filter((object) => object.kind === 'ClusterSecretStore' || object.kind === 'ExternalSecret')
    .map((object) => `${object.kind}/${object.metadata?.namespace ?? 'in-falcone-staging'}/${object.metadata?.name}`)
    .sort()
  const expected = fixture.falconeIntegrationResources
    .map((object) => `${object.kind}/${object.namespace ?? 'in-falcone-staging'}/${object.name}`)
    .sort()
  assert.deepEqual(integrations, expected)
  assert.equal(objects.filter((object) => object.kind === 'ExternalSecret').length, 14)
  assert.ok(!objects.some((object) => object.metadata?.namespace === 'external-secrets'))
})

// bbx-repair-staging-024 | fn-external-owner-semantic-diff | OpenSpec #### Scenario: External controller is reused
test('semantic owner gate rejects cluster-scoped and namespaced external-owner create, update, or removal', () => {
  const unsafe = []
  for (const scenario of ['external-owner-cluster-create', 'external-owner-namespaced-update', 'external-owner-cluster-remove']) {
    const invocation = invokeMigration(repairTool, phaseAArgs, scenario)
    try {
      if (invocation.result.status === 0 || invocation.helmMutations.length > 0) unsafe.push(scenario)
      if (!/EXTERNAL_ESO_SEMANTIC_DIFF/.test(combined(invocation.result))) unsafe.push(`${scenario}:semantic-diff-code-missing`)
      if (invocation.helmCalls.some((line) => /^get manifest(?:\s|$)/.test(line))) unsafe.push(`${scenario}:secret-bearing-live-manifest-read`)
    } finally {
      invocation.cleanup()
    }
  }
  assert.deepEqual(unsafe, [])
})

// bbx-repair-staging-030 | fn-external-owner-semantic-boundary | OpenSpec #### Scenario: External controller is reused
test('repair and forward allow exact Falcone integration migration but reject every external ESO owner object', () => {
  const fixture = JSON.parse(readFileSync(revision20Manifest, 'utf8'))
  assert.equal(fixture.falconeIntegrationResources.length, 15)
  assert.equal(fixture.liveExternalOwnerResources.length, 21)
  assert.ok(fixture.liveExternalOwnerResources.some((resource) => resource.namespace !== null),
    'external ESO owner fixture lacks namespaced resources')
  assert.ok(fixture.liveExternalOwnerResources.some((resource) => resource.namespace === null),
    'external ESO owner fixture lacks cluster-scoped resources')
  const violations = []
  const executables = [
    ['repair', repairTool, phaseAArgs, 'safe'],
    ['forward-recovery', recoveryTool, forwardArgs, 'forward-complete'],
  ]

  for (const [label, tool, args, baseScenario] of executables) {
    const allowed = invokeMigration(tool, args, 'falcone-integration-and-legacy-sa-migration', {
      FALCONE_STAGING_EXTERNAL_OWNER_BASE_SCENARIO: baseScenario,
    })
    try {
      assertSecretSuppressedSemanticDiff(allowed, `${label} allowed migration`)
      if (allowed.result.status !== 0) {
        const code = /EXTERNAL_ESO_SEMANTIC_DIFF/.test(combined(allowed.result))
          ? 'EXTERNAL_ESO_SEMANTIC_DIFF'
          : 'unexpected-error'
        violations.push(`${label}:known-falcone-migration-rejected:${code}`)
      }
    } finally {
      allowed.cleanup()
    }

    for (const resource of fixture.liveExternalOwnerResources) {
      const identity = `${resource.kind}/${resource.namespace ?? '<cluster>'}/${resource.name}`
      const invocation = invokeMigration(tool, args, 'external-owner-exact-resource', {
        FALCONE_STAGING_EXTERNAL_OWNER_API_VERSION: resource.apiVersion,
        FALCONE_STAGING_EXTERNAL_OWNER_KIND: resource.kind,
        FALCONE_STAGING_EXTERNAL_OWNER_NAME: resource.name,
        FALCONE_STAGING_EXTERNAL_OWNER_NAMESPACE: resource.namespace ?? '',
        FALCONE_STAGING_EXTERNAL_OWNER_BASE_SCENARIO: baseScenario,
      })
      try {
        assertSecretSuppressedSemanticDiff(invocation, `${label} ${identity}`)
        if (invocation.result.status === 0) violations.push(`${label}:${identity}:accepted`)
        if (!/EXTERNAL_ESO_SEMANTIC_DIFF/.test(combined(invocation.result))) {
          violations.push(`${label}:${identity}:failure-code-missing`)
        }
        if (invocation.helmMutations.length > 0) violations.push(`${label}:${identity}:mutated`)
      } finally {
        invocation.cleanup()
      }
    }
  }
  assert.deepEqual(violations, [])
})

// bbx-repair-staging-025 | fn-external-owner-before-after | OpenSpec #### Scenario: External controller is reused
test('external ESO owner metadata is identical before and after each repaired-chart pass', () => {
  const invocation = invokeMigration(repairTool, phaseAArgs, 'external-owner-changed-after-apply')
  try {
    assert.notEqual(invocation.result.status, 0, 'external owner transfer after apply was not detected')
    assert.match(combined(invocation.result), /EXTERNAL_ESO_OWNER_METADATA_CHANGED/)
    const inventoryReads = invocation.kubectlCalls.filter((line) => line === '-n external-secrets get deployment external-secrets -o json')
    assert.ok(inventoryReads.length >= 2, 'external owner metadata was not captured before and after apply')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-026 | fn-openbao-dedicated-reconciler | OpenSpec #### Scenario: Static reviewer credential is present
test('OpenBao auth reconciliation uses dedicated least-privilege identities and retains failed Job evidence', () => {
  const objects = renderUpgrade()
  const job = named(objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  const violations = []
  if (job?.spec?.template?.spec?.serviceAccountName !== 'openbao-auth-reconciler') violations.push('shared-service-account')
  if (/hook-failed/.test(job?.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? '')) violations.push('failed-job-deleted')
  if (job?.spec?.ttlSecondsAfterFinished !== undefined) violations.push('failed-job-ttl-present')

  const reconcilerSa = named(objects, 'ServiceAccount', 'openbao-auth-reconciler', 'secret-store')
  if (!reconcilerSa) violations.push('dedicated-service-account-missing')
  const tokenRequest = named(objects, 'RoleBinding', 'eso-openbao-token-request', 'eso-system')
  if (!tokenRequest?.subjects?.some((subject) => subject.kind === 'ServiceAccount'
    && subject.namespace === 'secret-store' && subject.name === 'openbao-auth-reconciler')) violations.push('token-request-rbac-missing')
  if (tokenRequest?.subjects?.some((subject) => subject.kind === 'ServiceAccount'
    && subject.namespace === 'secret-store' && subject.name === 'openbao')) violations.push('shared-service-account-retains-token-rbac')

  const policy = named(objects, 'ConfigMap', 'openbao-policy-auth-reconcile', 'secret-store')
  if (!policy) violations.push('dedicated-openbao-policy-missing')
  const body = Object.values(policy?.data ?? {}).join('\n')
  for (const required of [/auth\/kubernetes\/config/, /auth\/kubernetes\/role\/eso-role/, /auth\/token\/(?:lookup-self|revoke-self)/]) {
    if (!required.test(body)) violations.push(`policy-path-missing:${required.source}`)
  }
  if (/secret\/(?:data|metadata)|sys\/mounts|sys\/audit/.test(body)) violations.push('policy-reaches-secret-mount-or-audit-data')
  const policyStanzas = [...body.matchAll(/path\s+"([^"]+)"\s*\{([^}]*)\}/gs)]
  for (const [, path, stanza] of policyStanzas) {
    const capabilities = [...stanza.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]).sort()
    if (path === 'sys/policies/acl' && (capabilities.length !== 1 || capabilities[0] !== 'list')) {
      violations.push('policy-name-inventory-is-not-list-only')
    }
    if (path.startsWith('sys/policies/acl/')) violations.push('policy-document-access-present')
  }

  const script = job?.spec?.template?.spec?.containers?.find((container) => container.name === 'auth-metadata-reconciler')?.args?.[0] ?? ''
  if (!/role=openbao-auth-reconcile-role/.test(script)) violations.push('dedicated-openbao-login-role-missing')
  if (/role=openbao-init-role/.test(script)) violations.push('bootstrap-login-role-reused')
  assert.deepEqual(violations, [])
})

// bbx-repair-staging-027 | fn-openbao-semantic-reconcile | OpenSpec #### Scenario: Static reviewer credential is present + #### Scenario: Metadata already matches + #### Scenario: Matching role remains denied
test('executable OpenBao reconciliation omits static reviewer fields, rereads config, normalizes token fields, and validates canary metadata', () => {
  const objects = renderUpgrade()
  const job = named(objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  const script = job?.spec?.template?.spec?.containers?.find((container) => container.name === 'auth-metadata-reconciler')?.args?.[0] ?? ''
  const violations = []
  const diagnostics = {}
  const captureProcess = (label, invocation) => {
    const processState = reconcilerProcessDiagnostics(invocation)
    diagnostics[label] = processState
    if (processState.status === null) violations.push(`${label}-process-status-null`)
    if (processState.signal !== null) violations.push(`${label}-process-signal:${processState.signal}`)
    if (processState.error !== null) violations.push(`${label}-process-error:${processState.error.code ?? processState.error.name}`)
  }

  const config = runOpenBaoReconciler(script, 'config-remains-static')
  try {
    captureProcess('config', config)
    if (config.result.status === 0) violations.push('config-not-reread')
    const configReads = config.calls.filter((line) => /-field=(?:kubernetes_host|disable_local_ca_jwt|token_reviewer_jwt_set) auth\/kubernetes\/config/.test(line))
    if (configReads.length < 6) violations.push('config-fields-not-reread-after-write')
    const write = config.calls.find((line) => /^write auth\/kubernetes\/config/.test(line)) ?? ''
    if (!write) violations.push('config-write-not-observed')
    if (/token_reviewer_jwt=|kubernetes_ca_cert=/.test(write)) violations.push('static-reviewer-fields-not-omitted')
    if (!/AUTH_CONFIG_VERIFY_FAILED/.test(combined(config.result))) violations.push('config-verify-code-missing')
  } finally {
    config.cleanup()
  }

  const role = runOpenBaoReconciler(script, 'role-token-field-drift')
  try {
    captureProcess('role', role)
    if (role.result.status !== 0 || !/result=changed/.test(combined(role.result))) violations.push('security-token-field-drift-ignored')
    for (const field of ['token_max_ttl', 'token_explicit_max_ttl', 'token_period', 'token_num_uses', 'token_no_default_policy', 'token_type']) {
      if (!role.calls.some((line) => line.includes(`-field=${field}`))) violations.push(`role-field-not-normalized:${field}`)
    }
  } finally {
    role.cleanup()
  }

  const lookup = runOpenBaoReconciler(script, 'lookup-invalid')
  try {
    captureProcess('lookup', lookup)
    if (lookup.result.status === 0) violations.push('invalid-lookup-metadata-accepted')
    if (!/AUTH_CANARY_METADATA_INVALID/.test(combined(lookup.result))) violations.push('lookup-validation-code-missing')
  } finally {
    lookup.cleanup()
  }
  assert.deepEqual(violations, [], JSON.stringify(diagnostics, null, 2))
})

// bbx-repair-staging-028 | fn-ferretdb-openshift-restricted-v2 | OpenSpec #### Scenario: Replacement never becomes Ready
test('OpenShift strips every fixed FerretDB UID/GID at pod, main, and init scope while retaining hardening', () => {
  const render = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    '-f', resolve(umbrellaChart, 'values/platform-openshift.yaml'),
  ])
  assertSuccess(render, 'OpenShift render')
  const objects = yamlDocuments(render.stdout)
  const deployment = named(objects, 'Deployment', 'falcone-bbx-ferretdb')
  const pod = deployment?.spec?.template?.spec
  const main = pod?.containers?.find((container) => container.name === 'ferretdb')
  const gate = pod?.initContainers?.find((container) => container.name === 'wait-for-documentdb')
  for (const [scope, security] of [['pod', pod?.securityContext], ['main', main?.securityContext], ['init', gate?.securityContext]]) {
    assert.equal(security?.runAsUser, undefined, `${scope} retains fixed runAsUser`)
    assert.equal(security?.runAsGroup, undefined, `${scope} retains fixed runAsGroup`)
    assert.equal(security?.fsGroup, undefined, `${scope} retains fixed fsGroup`)
    assert.equal(security?.runAsNonRoot, true, `${scope} lost runAsNonRoot`)
  }
  assert.equal(pod?.securityContext?.seccompProfile?.type, 'RuntimeDefault')
  for (const container of [main, gate]) {
    assert.equal(container?.securityContext?.allowPrivilegeEscalation, false)
    assert.deepEqual(container?.securityContext?.capabilities?.drop, ['ALL'])
  }
  assert.equal(gate?.securityContext?.readOnlyRootFilesystem, true)
})

// bbx-repair-staging-029 | fn-repair-chart-version | OpenSpec #### Scenario: PVC state changes
test('repair and forward-recovery pin chart 0.4.11 and reject 0.4.9 through 0.4.3 target confirmations', () => {
  for (const [label, tool, args, scenario] of [
    ['repair', repairTool, phaseAArgs, 'safe'],
    ['forward-recovery', recoveryTool, forwardArgs, 'forward-complete'],
  ]) {
    const invocation = invokeMigration(tool, args, scenario)
    try {
      assertSuccess(invocation.result, `${label} with the immutable 0.4.11 repair package`)
      const chartCalls = invocation.helmCalls.filter((line) => /^(?:template|diff upgrade|upgrade)(?:\s|$)/.test(line))
      assert.ok(chartCalls.some((line) => /^template(?:\s|$)/.test(line)), `${label} did not render the repair chart`)
      assert.ok(chartCalls.some((line) => /^diff upgrade(?:\s|$)/.test(line)), `${label} did not diff the repair chart`)
      assert.ok(chartCalls.some((line) => /^upgrade(?:\s|$)/.test(line)), `${label} did not apply the repair chart`)
      for (const call of chartCalls) {
        assert.match(call, /(?:^|\s)--version 0\.4\.11(?:\s|$)/, `${label} did not select chart 0.4.11`)
        assert.doesNotMatch(call, /(?:^|\s)--version 0\.4\.[3456789](?:\s|$)/,
          `${label} selected a historical immutable chart`)
      }
    } finally {
      invocation.cleanup()
    }
  }

  for (const historicalVersion of ['0.4.9', '0.4.8', '0.4.7', '0.4.6', '0.4.5', '0.4.4', '0.4.3']) {
    const obsoleteConfirmation = phaseBConfirmation.replace('in-falcone-0.4.11', `in-falcone-${historicalVersion}`)
    for (const [label, tool, args, scenario] of [
      ['repair', repairTool, (work) => phaseBArgsWithConfirmation(work, obsoleteConfirmation), 'phase-a-complete'],
      ['forward-recovery', recoveryTool, (work) => forwardArgs(work, obsoleteConfirmation), 'forward-complete'],
    ]) {
      const invocation = invokeMigration(tool, args, scenario)
      try {
        assert.notEqual(invocation.result.status, 0,
          `${label} accepted historical chart ${historicalVersion} target confirmation`)
        assert.match(combined(invocation.result), /JIT_TARGET_CONFIRMATION_REQUIRED/)
        assert.match(combined(invocation.result), /in-falcone-0\.4\.11/)
        assert.deepEqual(invocation.helmMutations, [], `${label} mutated before rejecting the mismatched chart`)
      } finally {
        invocation.cleanup()
      }
    }
  }
})

// bbx-repair-staging-031 | fn-repair-package-version | OpenSpec #### Scenario: Evidence is opaque, stale, or targets another package
test('repair and forward use the packaged chart top-level version and reject a wrong top-level version before mutation', () => {
  const violations = []
  for (const [label, tool, args, baseScenario] of [
    ['repair', repairTool, phaseAArgs, 'safe'],
    ['forward-recovery', recoveryTool, forwardArgs, 'forward-complete'],
  ]) {
    const valid = invokeMigration(tool, args, 'packaged-chart-version-order', {
      FALCONE_STAGING_REAL_HELM: '',
      FALCONE_STAGING_EXTERNAL_OWNER_BASE_SCENARIO: baseScenario,
    })
    try {
      if (!valid.helmCalls.some((line) => /^pull(?:\s|$)/.test(line))) {
        violations.push(`${label}:package-not-pulled`)
      }
      if (!valid.helmCalls.includes('fixture-package first-version=0.2.2 top-level-version=0.4.11')) {
        violations.push(`${label}:dependency-first-package-not-proven`)
      }
      if (valid.result.status !== 0) {
        const output = combined(valid.result)
        const version = /REPAIR_PACKAGE_VERSION_MISMATCH actual=([^\s]+)/.exec(output)?.[1]
        const code = /\b[A-Z][A-Z_]{3,}(?: [^\n]*)?/.exec(output)?.[0] ?? `exit=${valid.result.status}`
        violations.push(`${label}:valid-top-level-rejected:${version ? `actual=${version}` : code}`)
      }
    } finally {
      valid.cleanup()
    }

    const invalid = invokeMigration(tool, args, 'packaged-chart-version-order', {
      FALCONE_STAGING_REAL_HELM: '',
      FALCONE_STAGING_EXTERNAL_OWNER_BASE_SCENARIO: baseScenario,
      FALCONE_STAGING_PACKAGED_TOP_LEVEL_VERSION: '9.9.9',
    })
    try {
      if (!invalid.helmCalls.includes('fixture-package first-version=0.2.2 top-level-version=9.9.9')) {
        violations.push(`${label}:wrong-top-level-package-not-proven`)
      }
      if (invalid.result.status === 0) violations.push(`${label}:wrong-top-level-accepted`)
      if (!/REPAIR_PACKAGE_VERSION_MISMATCH actual=9\.9\.9/.test(combined(invalid.result))) {
        violations.push(`${label}:wrong-top-level-code-missing`)
      }
      if (invalid.helmMutations.length > 0) violations.push(`${label}:wrong-top-level-mutated`)
      if (invalid.operations.some((line) => /^kubectl .* (?:apply|create|delete|patch|scale)(?:\s|$)/.test(line))) {
        violations.push(`${label}:wrong-top-level-kubernetes-mutated`)
      }
    } finally {
      invalid.cleanup()
    }
  }
  assert.deepEqual(violations, [])
})
