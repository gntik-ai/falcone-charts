/**
 * Black-box regression contract for revision-20 ExternalSecret adoption.
 * The migration CLIs are exercised only through their public command surface
 * against offline Helm/Kubernetes executables; no cluster or Secret payload is
 * available to these tests.
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
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const fixtureRoot = resolve(repoRoot, 'tests/blackbox/fixtures/staging-infrastructure')
const adoptionFakeBin = resolve(repoRoot, 'tests/blackbox/fixtures/staging-helm-adoption/fake-bin')
const baseFakeBin = resolve(fixtureRoot, 'fake-bin')
const repairTool = resolve(umbrellaChart, 'migrations/revision-20-repair.sh')
const recoveryTool = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')
const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const externalSecretsFixture = resolve(fixtureRoot, 'external-secrets-ready.json')
const revision20Manifest = resolve(fixtureRoot, 'revision-20-ownership-manifest.json')
const backupTemplate = resolve(fixtureRoot, 'backup-attestation.template.json')
const parityTemplate = resolve(fixtureRoot, 'parity-attestation.template.json')
const phaseATemplate = resolve(fixtureRoot, 'phase-a-attestation.template.json')
const repairDigest = 'sha256:0480480480480480480480480480480480480480480480480480480480480480'
const repairVersion = readFileSync(resolve(umbrellaChart, 'Chart.yaml'), 'utf8')
  .match(/^version:\s*([^\s]+)\s*$/m)?.[1]
assert.ok(repairVersion, 'public umbrella chart has no unique top-level version')
const repairChart = `in-falcone-${repairVersion}`
const phaseAConfirmation = `default/in-falcone-staging/falcone@20/in-falcone-0.4.1->${repairChart}/${repairDigest}`
const forwardConfirmation = `default/in-falcone-staging/falcone@23/${repairChart}/${repairDigest}`
const exactNames = JSON.parse(readFileSync(revision20Manifest, 'utf8'))
  .falconeIntegrationResources
  .filter((resource) => resource.kind === 'ExternalSecret' && resource.namespace === 'in-falcone-staging')
  .map((resource) => resource.name)
  .sort()

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function readJsonLines(path) {
  return readLines(path).map((line) => JSON.parse(line))
}

function materializeAttestation(template, work, filename) {
  const document = JSON.parse(readFileSync(template, 'utf8'))
  const now = Date.now()
  document.evidence.observedAt = new Date(now - 60_000).toISOString()
  document.evidence.validUntil = new Date(now + 10 * 60_000).toISOString()
  if (document.repair) document.repair.chart = repairChart
  if (document.result) document.result.chart = repairChart
  if (document.repair) document.repair.packageDigest = repairDigest
  if (document.result) document.result.packageDigest = repairDigest
  const path = resolve(work, filename)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  return path
}

function renderedExternalSecrets() {
  const render = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    '--is-upgrade', '-f', stagingValues,
    '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-non-secret-evidence',
  ])
  assertSuccess(render, `rendering the public ${repairVersion} staging upgrade contract`)
  const items = yamlDocuments(render.stdout)
    .filter((object) => object.kind === 'ExternalSecret'
      && object.metadata?.namespace === 'in-falcone-staging')
    .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name))
  assert.deepEqual(items.map((item) => item.metadata.name), exactNames)
  return items
}

function liveDefaultedItem(rendered, index) {
  const item = structuredClone(rendered)
  item.metadata = {
    ...item.metadata,
    uid: `bbx-external-secret-${String(index + 1).padStart(2, '0')}`,
    resourceVersion: String(1000 + index),
    labels: { ...(item.metadata?.labels ?? {}) },
    annotations: { ...(item.metadata?.annotations ?? {}) },
  }
  delete item.metadata.labels['app.kubernetes.io/managed-by']
  delete item.metadata.annotations['meta.helm.sh/release-name']
  delete item.metadata.annotations['meta.helm.sh/release-namespace']
  item.spec.target = {
    ...(item.spec.target ?? {}),
    deletionPolicy: item.spec.target?.deletionPolicy ?? 'Retain',
  }
  for (const datum of item.spec.data ?? []) {
    datum.remoteRef = {
      ...datum.remoteRef,
      conversionStrategy: datum.remoteRef?.conversionStrategy ?? 'Default',
      decodingStrategy: datum.remoteRef?.decodingStrategy ?? 'None',
      metadataPolicy: datum.remoteRef?.metadataPolicy ?? 'None',
    }
  }
  item.status = {
    conditions: [{ type: 'Ready', status: 'True', reason: 'SecretSynced' }],
  }
  return item
}

function setExactOwner(item) {
  item.metadata.labels = {
    ...(item.metadata.labels ?? {}),
    'app.kubernetes.io/managed-by': 'Helm',
  }
  item.metadata.annotations = {
    ...(item.metadata.annotations ?? {}),
    'meta.helm.sh/release-name': 'falcone',
    'meta.helm.sh/release-namespace': 'in-falcone-staging',
  }
}

function initialState(scenario) {
  const items = renderedExternalSecrets().map(liveDefaultedItem)
  if (scenario === 'already-owned') {
    for (const item of items) setExactOwner(item)
  } else if (scenario === 'partial-owner-markers') {
    items[0].metadata.labels['app.kubernetes.io/managed-by'] = 'Helm'
  } else if (scenario === 'foreign-owner') {
    items[0].metadata.labels['app.kubernetes.io/managed-by'] = 'Helm'
    items[0].metadata.annotations['meta.helm.sh/release-name'] = 'another-release'
    items[0].metadata.annotations['meta.helm.sh/release-namespace'] = 'another-namespace'
  } else if (scenario === 'spec-mismatch') {
    items[0].spec.refreshInterval = '999h'
  } else if (scenario === 'extra-object') {
    const extra = structuredClone(items[0])
    extra.metadata.name = 'rogue-unlisted-external-secret'
    extra.metadata.uid = 'bbx-rogue-external-secret'
    extra.metadata.resourceVersion = '2000'
    items.push(extra)
  }
  return {
    expectedNames: exactNames,
    items,
    readNames: [],
    adoptionWrites: [],
    mutationStarted: false,
    failureInjected: false,
    driftInjected: false,
  }
}

function createHarness(scenario) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-staging-adoption-bbx-'))
  const statePath = resolve(work, 'adoption-state.json')
  const apiLog = resolve(work, 'api.jsonl')
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const operationLog = resolve(work, 'operations.log')
  const pvcState = resolve(work, 'pvc-state')
  const helmState = resolve(work, 'helm-state')
  writeFileSync(statePath, `${JSON.stringify(initialState(scenario), null, 2)}\n`)
  const backup = materializeAttestation(backupTemplate, work, 'backup.json')
  const parity = materializeAttestation(parityTemplate, work, 'parity.json')
  const phaseA = materializeAttestation(phaseATemplate, work, 'phase-a.json')
  const realHelm = run('/bin/sh', ['-c', 'command -v helm'])
  assertSuccess(realHelm, 'locating Helm')

  const baseEnv = {
    ...process.env,
    PATH: `${adoptionFakeBin}:${process.env.PATH}`,
    FALCONE_ADOPTION_BASE_FAKE_BIN: baseFakeBin,
    FALCONE_ADOPTION_STATE: statePath,
    FALCONE_ADOPTION_API_LOG: apiLog,
    FALCONE_ADOPTION_SCENARIO: scenario,
    FALCONE_ADOPTION_REPAIR_VERSION: repairVersion,
    FALCONE_STAGING_REAL_HELM: realHelm.stdout.trim(),
    FALCONE_STAGING_HELM_DELEGATE: realHelm.stdout.trim(),
    FALCONE_STAGING_PACKAGED_CHART_SOURCE: umbrellaChart,
    FALCONE_STAGING_REPAIR_PACKAGE_DIGEST: repairDigest,
    FALCONE_STAGING_HELM_LOG: helmLog,
    FALCONE_STAGING_KUBECTL_LOG: kubectlLog,
    FALCONE_STAGING_OPERATION_LOG: operationLog,
    FALCONE_STAGING_STATE_FILE: pvcState,
    FALCONE_STAGING_HELM_STATE_FILE: helmState,
    FALCONE_STAGING_EXTERNAL_SECRETS_FIXTURE: externalSecretsFixture,
    FALCONE_STAGING_REVISION20_MANIFEST: revision20Manifest,
  }

  function invoke(tool, args, baseScenario = 'safe') {
    const result = run('/bin/bash', [tool, ...args], {
      env: { ...baseEnv, FALCONE_STAGING_SCENARIO: baseScenario },
      timeout: 30_000,
    })
    return {
      result,
      apiCalls: readJsonLines(apiLog),
      helmCalls: readLines(helmLog),
      kubectlCalls: readLines(kubectlLog),
      state: JSON.parse(readFileSync(statePath, 'utf8')),
    }
  }

  return {
    phaseAArgs: [
      '--phase-a', '--apply', '--confirm-target', phaseAConfirmation,
      '--backup-attestation', backup, '--parity-attestation', parity,
    ],
    forwardArgs: [
      '--apply', '--confirm-target', forwardConfirmation,
      '--backup-attestation', backup, '--parity-attestation', parity,
      '--phase-a-attestation', phaseA,
    ],
    invoke,
    state: () => JSON.parse(readFileSync(statePath, 'utf8')),
    resetHelmState: () => rmSync(helmState, { force: true }),
    apiLogSize: () => readJsonLines(apiLog).length,
    apiCallsSince: (offset) => readJsonLines(apiLog).slice(offset),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function adoptionPatches(calls) {
  return calls.filter((call) => call.command === 'kubectl' && call.args.includes('patch'))
}

function secretReads(calls) {
  return calls.filter((call) => {
    const get = call.args.indexOf('get')
    if (call.command !== 'kubectl' || get < 0) return false
    return /^secrets?(?:\.|\/|$)/i.test(call.args[get + 1] ?? '')
  })
}

function helmMutations(calls) {
  return calls.filter((call) => call.command === 'helm'
    && ['install', 'upgrade', 'rollback', 'uninstall'].includes(call.args[0]))
}

function assertNoBroadOwnership(invocation) {
  assert.deepEqual(secretReads(invocation.apiCalls), [], 'migration read a Secret payload surface')
  assert.ok(!invocation.helmCalls.some((call) => /(?:^|\s)--take-ownership(?:\s|$)/.test(call)),
    'migration delegated ownership safety to broad helm --take-ownership')
  assert.ok(!invocation.apiCalls.some((call) => call.command === 'kubectl'
    && ['patch', 'label', 'annotate'].some((verb) => call.args.includes(verb))
    && (call.args.includes('--all') || !call.args.includes('-n')
      || call.args[call.args.indexOf('-n') + 1] !== 'in-falcone-staging')),
  'migration attempted a broad or cross-namespace ownership mutation')
}

// bbx-repair-staging-032 | fn-revision20-falcone-integration-adoption | OpenSpec #### Scenario: External controller is reused
test('Phase A safely adopts exactly the 14 defaulted-live ExternalSecrets before Helm upgrade', () => {
  const harness = createHarness('safe-unowned')
  try {
    const invocation = harness.invoke(repairTool, harness.phaseAArgs)
    assertSuccess(invocation.result, 'revision-20 Phase A exact ExternalSecret adoption')
    assert.deepEqual(invocation.state.items.map((item) => item.metadata.name).sort(), exactNames)
    assert.deepEqual([...new Set(invocation.state.adoptionWrites)].sort(), exactNames)
    for (const item of invocation.state.items) {
      assert.equal(item.metadata.labels?.['app.kubernetes.io/managed-by'], 'Helm')
      assert.equal(item.metadata.annotations?.['meta.helm.sh/release-name'], 'falcone')
      assert.equal(item.metadata.annotations?.['meta.helm.sh/release-namespace'], 'in-falcone-staging')
    }
    assert.equal(adoptionPatches(invocation.apiCalls).length, 14,
      'each exact identity must be adopted once after all-14 prevalidation')
    assert.equal(invocation.helmCalls.filter((call) => /^upgrade(?:\s|$)/.test(call)).length, 2,
      'Phase A must complete both repaired-chart passes')
    assertNoBroadOwnership(invocation)
  } finally {
    harness.cleanup()
  }
})

// bbx-repair-staging-033 | fn-revision20-falcone-integration-adoption-validation | OpenSpec #### Scenario: External controller is reused
test('foreign/partial ownership, spec mismatch, extra identity, and external ESO drift fail before Helm mutation', () => {
  const scenarios = [
    'foreign-owner',
    'partial-owner-markers',
    'spec-mismatch',
    'extra-object',
    'external-eso-unowned',
  ]
  const violations = []
  for (const scenario of scenarios) {
    const harness = createHarness(scenario)
    try {
      const invocation = harness.invoke(repairTool, harness.phaseAArgs)
      if (invocation.result.status === 0) violations.push(`${scenario}:accepted`)
      if (helmMutations(invocation.apiCalls).length > 0
          || invocation.helmCalls.some((call) => /^upgrade(?:\s|$)/.test(call))) {
        violations.push(`${scenario}:helm-mutation-attempted`)
      }
      if (invocation.state.adoptionWrites.length > 0) violations.push(`${scenario}:adoption-mutated`)
      assertNoBroadOwnership(invocation)
    } finally {
      harness.cleanup()
    }
  }
  assert.deepEqual(violations, [])
})

// bbx-repair-staging-034 | fn-revision20-falcone-integration-adoption-preconditions | OpenSpec #### Scenario: External controller is reused
test('UID or resourceVersion drift is rejected by atomic JSON Patch tests before Helm mutation', () => {
  const violations = []
  for (const scenario of ['uid-drift', 'resource-version-drift']) {
    const harness = createHarness(scenario)
    try {
      const invocation = harness.invoke(repairTool, harness.phaseAArgs)
      if (invocation.result.status === 0) violations.push(`${scenario}:accepted`)
      if (invocation.state.adoptionWrites.length > 0) violations.push(`${scenario}:adoption-mutated`)
      if (invocation.helmCalls.some((call) => /^upgrade(?:\s|$)/.test(call))) {
        violations.push(`${scenario}:helm-mutation-attempted`)
      }
      const patches = adoptionPatches(invocation.apiCalls)
      if (patches.length !== 1) violations.push(`${scenario}:expected-one-conditional-patch:${patches.length}`)
      if (!/FORWARD_RECOVERY_REQUIRED/.test(combined(invocation.result))) {
        violations.push(`${scenario}:forward-recovery-instruction-missing`)
      }
      assertNoBroadOwnership(invocation)
    } finally {
      harness.cleanup()
    }
  }
  assert.deepEqual(violations, [])
})

// bbx-repair-staging-035 | fn-revision20-falcone-integration-adoption-retry | OpenSpec #### Scenario: Apply fails after deletion
test('a mid-adoption patch failure reports mutation_started and retry adopts only the remaining identities', () => {
  const harness = createHarness('patch-failure')
  try {
    const first = harness.invoke(repairTool, harness.phaseAArgs)
    assert.notEqual(first.result.status, 0, 'synthetic third-object patch failure unexpectedly succeeded')
    assert.equal(first.state.adoptionWrites.length, 2)
    assert.ok(first.state.mutationStarted)
    assert.match(combined(first.result), /mutation_started=true/i)
    assert.match(combined(first.result), /FORWARD_RECOVERY_REQUIRED/)
    assert.ok(!first.helmCalls.some((call) => /^upgrade(?:\s|$)/.test(call)),
      'Helm mutation began after a partial adoption failure')
    const beforeRetry = harness.apiLogSize()

    const retry = harness.invoke(repairTool, harness.phaseAArgs)
    assertSuccess(retry.result, 'idempotent Phase A adoption retry')
    assert.deepEqual([...new Set(retry.state.adoptionWrites)].sort(), exactNames)
    const retryPatches = adoptionPatches(harness.apiCallsSince(beforeRetry))
    assert.equal(retryPatches.length, 12, 'retry must not patch the two already exactly-owned identities')
    assertNoBroadOwnership(retry)
  } finally {
    harness.cleanup()
  }
})

// bbx-repair-staging-036 | fn-revision20-falcone-integration-adoption-idempotency | OpenSpec #### Scenario: External controller is reused
test('forward recovery accepts an exact already-owned set without repeating adoption', () => {
  const harness = createHarness('already-owned')
  try {
    const invocation = harness.invoke(recoveryTool, harness.forwardArgs, 'forward-complete')
    assertSuccess(invocation.result, 'forward recovery with exact Helm-owned ExternalSecrets')
    assert.deepEqual(invocation.state.adoptionWrites, [])
    assert.deepEqual(adoptionPatches(invocation.apiCalls), [])
    assert.equal(invocation.helmCalls.filter((call) => /^upgrade(?:\s|$)/.test(call)).length, 1)
    assertNoBroadOwnership(invocation)
  } finally {
    harness.cleanup()
  }
})
