/**
 * Black-box regression contracts for fail-forward recovery from the exact
 * failed Helm revision 22 produced by the 0.4.8 Phase-A apply. The migration
 * CLIs are exercised only through their public shell interface against
 * offline Helm and Kubernetes executables; fixtures expose metadata/spec only.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  repoRoot,
  run,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'

const fixtureRoot = resolve(repoRoot, 'tests/blackbox/fixtures/staging-infrastructure')
const fakeBin = resolve(fixtureRoot, 'fake-bin')
const repairTool = resolve(umbrellaChart, 'migrations/revision-20-repair.sh')
const recoveryTool = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')
const externalSecretsFixture = resolve(fixtureRoot, 'external-secrets-ready.json')
const revision20Manifest = resolve(fixtureRoot, 'revision-20-ownership-manifest.json')
const backupTemplate = resolve(fixtureRoot, 'backup-attestation.template.json')
const parityTemplate = resolve(fixtureRoot, 'parity-attestation.template.json')
const repairVersion = '0.4.19'
const repairChart = `in-falcone-${repairVersion}`
const repairDigest = 'sha256:0419041904190419041904190419041904190419041904190419041904190419'
const r22Confirmation = `default/in-falcone-staging/falcone@22/in-falcone-0.4.8->${repairChart}/${repairDigest}`

const preservationValues = new Map([
  ['documentdb.persistence.storageClass', 'local-path'],
  ['documentdb.persistence.size', '10Gi'],
  ['kafka.persistence.storageClass', 'local-path'],
  ['kafka.persistence.size', '10Gi'],
  ['observability.persistence.storageClass', 'local-path'],
  ['observability.persistence.size', '10Gi'],
  ['postgresql.persistence.storageClass', 'local-path'],
  ['postgresql.persistence.size', '10Gi'],
  ['seaweedfs.filer.data.storageClass', 'hcloud-volumes'],
  ['seaweedfs.filer.data.size', '10Gi'],
  ['seaweedfs.master.data.storageClass', 'hcloud-volumes'],
  ['seaweedfs.master.data.size', '10Gi'],
])

const standalonePvcs = [
  'falcone-documentdb-data',
  'falcone-kafka-data',
  'falcone-observability-data',
  'falcone-postgresql-data',
]
const seaweedStatefulSets = [
  'falcone-seaweedfs-filer',
  'falcone-seaweedfs-master',
]
const seaweedChildPvcs = [
  'data-filer-falcone-seaweedfs-filer-0',
  'data-in-falcone-staging-falcone-seaweedfs-master-0',
]

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function materializeAttestation(template, work, filename) {
  const document = JSON.parse(readFileSync(template, 'utf8'))
  const now = Date.now()
  document.evidence.observedAt = new Date(now - 60_000).toISOString()
  document.evidence.validUntil = new Date(now + 10 * 60_000).toISOString()
  document.repair.chart = repairChart
  document.repair.packageDigest = repairDigest
  const path = resolve(work, filename)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  return path
}

function r22Args(work, tool) {
  const action = tool === repairTool ? ['--phase-a', '--apply'] : ['--apply']
  return [
    ...action,
    '--confirm-target', r22Confirmation,
    '--backup-attestation', materializeAttestation(backupTemplate, work, 'backup.json'),
    '--parity-attestation', materializeAttestation(parityTemplate, work, 'parity.json'),
  ]
}

function invoke(tool, scenario) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-r22-immutable-bbx-'))
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const operationLog = resolve(work, 'operations.log')
  const stateFile = resolve(work, 'pvc-state')
  const helmState = resolve(work, 'helm-state')
  const realHelm = run('/bin/sh', ['-c', 'command -v helm'])
  assertSuccess(realHelm, 'locating Helm')
  const result = run('/bin/bash', [tool, ...r22Args(work, tool)], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FALCONE_STAGING_SCENARIO: scenario,
      FALCONE_STAGING_REAL_HELM: realHelm.stdout.trim(),
      FALCONE_STAGING_HELM_DELEGATE: realHelm.stdout.trim(),
      FALCONE_STAGING_PACKAGED_CHART_SOURCE: umbrellaChart,
      FALCONE_STAGING_REPAIR_VERSION: repairVersion,
      FALCONE_STAGING_REPAIR_PACKAGE_DIGEST: repairDigest,
      FALCONE_STAGING_HELM_LOG: helmLog,
      FALCONE_STAGING_KUBECTL_LOG: kubectlLog,
      FALCONE_STAGING_OPERATION_LOG: operationLog,
      FALCONE_STAGING_STATE_FILE: stateFile,
      FALCONE_STAGING_HELM_STATE_FILE: helmState,
      FALCONE_STAGING_ASSUME_APPROVED_RENDER: 'true',
      FALCONE_STAGING_EXTERNAL_SECRETS_FIXTURE: externalSecretsFixture,
      FALCONE_STAGING_REVISION20_MANIFEST: revision20Manifest,
    },
    timeout: 60_000,
  })
  return {
    result,
    helmCalls: readLines(helmLog),
    kubectlCalls: readLines(kubectlLog),
    operations: readLines(operationLog),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function helmMutations(invocation) {
  return invocation.helmCalls.filter((call) => /^(?:install|rollback|uninstall|upgrade)(?:\s|$)/.test(call))
}

function kubectlMutations(invocation) {
  return invocation.kubectlCalls.filter((call) => (
    call.split(/\s+/).some((word) => ['apply', 'create', 'delete', 'patch', 'replace', 'scale', 'set'].includes(word))
  ))
}

function assertPublicMetadataBoundary(invocation, label) {
  const helmText = invocation.helmCalls.join('\n')
  const kubectlText = invocation.kubectlCalls.join('\n')
  assert.doesNotMatch(helmText, /(?:^|\s)--reuse-values(?:\s|$)/,
    `${label} implicitly reused the failed release values`)
  assert.ok(!invocation.helmCalls.some((call) => /^get manifest(?:\s|$)/.test(call)),
    `${label} read the secret-bearing Helm manifest`)
  assert.doesNotMatch(kubectlText, /(?:^|\s)get\s+secrets?(?:\/|\s|$)/i,
    `${label} read Kubernetes Secret data`)
  assert.ok(!invocation.helmCalls.some((call) => /^rollback(?:\s|$)/.test(call)),
    `${label} used rollback from the failed revision`)
  assert.ok(!invocation.helmCalls.some((call) => /(?:^|\s)--atomic(?:\s|$)/.test(call)),
    `${label} enabled Helm's implicit rollback`)
}

function assertLiveImmutableMetadataWasRead(invocation, label) {
  const calls = invocation.kubectlCalls.join('\n')
  for (const pvc of [...standalonePvcs, ...seaweedChildPvcs]) {
    assert.match(calls, new RegExp(`get pvc(?:s)?(?:\\s+${pvc})?\\s+-o\\s+json`),
      `${label} did not read public PVC metadata/spec for ${pvc}`)
  }
  for (const statefulSet of seaweedStatefulSets) {
    assert.match(calls, new RegExp(`get statefulsets?(?:\\.apps)?(?:\\s+${statefulSet})?\\s+-o\\s+json`),
      `${label} did not read the immutable StatefulSet contract for ${statefulSet}`)
  }
}

function assertExplicitPreservation(invocation, label) {
  const targetCalls = invocation.helmCalls.filter((call) => /^(?:template|diff upgrade|upgrade)(?:\s|$)/.test(call))
  assert.ok(targetCalls.length > 0, `${label} did not render or apply the recovery chart`)
  for (const call of targetCalls) {
    assert.match(call, /(?:^|\s)--version 0\.4\.19(?:\s|$)/,
      `${label} did not select the 0.4.19 recovery chart in:\n${call}`)
    for (const [key, value] of preservationValues) {
      assert.match(call, new RegExp(`(?:^|\\s)${key.replaceAll('.', '\\.') }=${value}(?:\\s|$)`),
        `${label} omitted explicit live value ${key}=${value} from:\n${call}`)
    }
  }
}

function assertSafeR22Apply(invocation, label) {
  assertSuccess(invocation.result, label)
  assertPublicMetadataBoundary(invocation, label)
  assertLiveImmutableMetadataWasRead(invocation, label)
  assertExplicitPreservation(invocation, label)
  assert.equal(helmMutations(invocation).length, 2,
    `${label} must perform the recovery-root apply and the final no-root apply`)
  for (const apply of helmMutations(invocation)) {
    assert.match(apply, /^upgrade falcone .*--namespace in-falcone-staging/)
  }
  assert.ok(!invocation.kubectlCalls.some((call) => /(?:^|\s)delete\s+pvc(?:\s|$)/.test(call)),
    `${label} crossed the Phase-B/JIT PVC deletion boundary`)
}

// bbx-repair-staging-046 | fn-revision22-phase-a-resume | OpenSpec #### Scenario: Phase A encounters the admitted revision-22 immutable-field failure
test('Phase A resumes only the exact failed r22/0.4.8 immutable-field incident with explicit live contracts', () => {
  const invocation = invoke(repairTool, 'r22-immutable-exact')
  try {
    assertSafeR22Apply(invocation, 'revision-22 Phase-A resume')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-047 | fn-revision22-forward-recovery | OpenSpec #### Scenario: Phase A encounters the admitted revision-22 immutable-field failure
test('forward recovery delegates the exact failed r22 anchor to Phase A without fabricating a Phase-A attestation', () => {
  const invocation = invoke(recoveryTool, 'r22-immutable-exact')
  try {
    assertSafeR22Apply(invocation, 'revision-22 forward recovery')
    assert.doesNotMatch(invocation.operations.join('\n'), /phase-a-attestation/i,
      'failed Phase A cannot have a successful Phase-A attestation')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-048 | fn-revision22-failed-anchor-gate | OpenSpec #### Scenario: Phase A encounters the admitted revision-22 immutable-field failure
test('r22 chart, failed status, and all six immutable rejection identities must match before mutation', async (t) => {
  for (const [label, scenario] of [
    ['status', 'r22-immutable-status-drift'],
    ['chart', 'r22-immutable-chart-drift'],
    ['description', 'r22-immutable-description-drift'],
  ]) {
    await t.test(`${label} drift`, () => {
      const invocation = invoke(repairTool, scenario)
      try {
        assert.notEqual(invocation.result.status, 0, `${label} drift unexpectedly resumed`)
        assert.ok(invocation.helmCalls.some((call) => /^(?:list|history falcone)(?:\s|$)/.test(call)),
          `${label} drift was not checked against public Helm release metadata`)
        assert.deepEqual(helmMutations(invocation), [], `${label} drift reached Helm mutation`)
        assert.deepEqual(kubectlMutations(invocation), [], `${label} drift reached Kubernetes mutation`)
        assertPublicMetadataBoundary(invocation, `${label} drift rejection`)
      } finally {
        invocation.cleanup()
      }
    })
  }
})

// bbx-repair-staging-049 | fn-revision22-live-storage-gate | OpenSpec #### Scenario: Phase A encounters the admitted revision-22 immutable-field failure
test('standalone PVC, SeaweedFS VCT, and historical child-PVC drift fails before any mutation', async (t) => {
  for (const [label, scenario, expectedRead] of [
    ['standalone PVC storageClass', 'r22-immutable-pvc-storage-drift', 'falcone-documentdb-data'],
    ['standalone PVC size', 'r22-immutable-pvc-size-drift', 'falcone-kafka-data'],
    ['SeaweedFS immutable VCT', 'r22-immutable-vct-drift', 'falcone-seaweedfs-filer'],
    ['SeaweedFS child PVC', 'r22-immutable-child-pvc-drift', 'data-in-falcone-staging-falcone-seaweedfs-master-0'],
  ]) {
    await t.test(label, () => {
      const invocation = invoke(repairTool, scenario)
      try {
        assert.notEqual(invocation.result.status, 0, `${label} drift unexpectedly applied`)
        assert.match(invocation.kubectlCalls.join('\n'), new RegExp(expectedRead),
          `${label} drift did not reach its public live-resource gate`)
        assert.deepEqual(helmMutations(invocation), [], `${label} drift reached Helm mutation`)
        assert.deepEqual(kubectlMutations(invocation), [], `${label} drift reached Kubernetes mutation`)
        assert.ok(!invocation.kubectlCalls.some((call) => /(?:^|\s)delete\s+pvc(?:\s|$)/.test(call)),
          `${label} drift crossed the Phase-B/JIT deletion gate`)
        assertPublicMetadataBoundary(invocation, `${label} drift rejection`)
      } finally {
        invocation.cleanup()
      }
    })
  }
})
