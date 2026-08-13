/**
 * Black-box regression contracts for revision-20 webhook signing-key custody
 * and the one admitted revision-21 failed-hook resumption. The repair CLIs are
 * invoked only through their public shell surface against offline Helm and
 * Kubernetes executables; the fixtures expose references and metadata only.
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
const phaseATemplate = resolve(fixtureRoot, 'phase-a-attestation.template.json')
const repairVersion = '0.4.17'
const repairChart = `in-falcone-${repairVersion}`
const repairDigest = 'sha256:0417041704170417041704170417041704170417041704170417041704170417'
const phaseAConfirmation = `default/in-falcone-staging/falcone@20/in-falcone-0.4.1->${repairChart}/${repairDigest}`
const failedResumeConfirmation = `default/in-falcone-staging/falcone@21/in-falcone-0.4.7->${repairChart}/${repairDigest}`
const postPhaseAConfirmation = `default/in-falcone-staging/falcone@25/${repairChart}/${repairDigest}`

const legacyCustodyOverrides = [
  '--set global.webhookSigningKey.create=false',
  '--set-string global.webhookSigningKey.secretName=falcone-webhook-signing-key-c25-legacy',
  '--set-string global.webhookSigningKey.secretKey=key',
  '--set-string global.webhookSigningKey.adoption.mode=legacy',
  '--set-string global.webhookSigningKey.adoption.requestId=c25-staging-adopt-20260723-01',
  '--set-string global.webhookSigningKey.rotation.action=none',
  '--set-string global.webhookSigningKey.rotation.requestId=',
  '--set-string global.webhookSigningKey.rotation.sourceSecretName=',
  '--set-string global.webhookSigningKey.rotation.sourceSecretKey=',
  '--set-string global.webhookSigningKey.rotation.rotationId=',
  '--set global.webhookSigningKey.rotation.recoveryWindowSeconds=604800',
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
  if (document.repair) {
    document.repair.chart = repairChart
    document.repair.packageDigest = repairDigest
  }
  if (document.result) {
    document.result.chart = repairChart
    document.result.packageDigest = repairDigest
  }
  const path = resolve(work, filename)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
  return path
}

function phaseAArgs(work, confirmation = phaseAConfirmation) {
  return [
    '--phase-a', '--apply', '--confirm-target', confirmation,
    '--backup-attestation', materializeAttestation(backupTemplate, work, 'backup.json'),
    '--parity-attestation', materializeAttestation(parityTemplate, work, 'parity.json'),
  ]
}

function phaseBArgs(work) {
  return [
    '--phase-b', '--apply', '--confirm-target', postPhaseAConfirmation,
    '--backup-attestation', materializeAttestation(backupTemplate, work, 'backup.json'),
    '--parity-attestation', materializeAttestation(parityTemplate, work, 'parity.json'),
    '--phase-a-attestation', materializeAttestation(phaseATemplate, work, 'phase-a.json'),
    '--pvc-uid', 'bbx-pvc-uid',
    '--confirm-pvc', 'falcone-postgresql-vector-data/bbx-pvc-uid',
  ]
}

function forwardArgs(work) {
  return [
    '--apply', '--confirm-target', postPhaseAConfirmation,
    '--backup-attestation', materializeAttestation(backupTemplate, work, 'backup.json'),
    '--parity-attestation', materializeAttestation(parityTemplate, work, 'parity.json'),
    '--phase-a-attestation', materializeAttestation(phaseATemplate, work, 'phase-a.json'),
  ]
}

function invoke(tool, argsOrBuilder, scenario = 'safe') {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-legacy-custody-bbx-'))
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const operationLog = resolve(work, 'operations.log')
  const stateFile = resolve(work, 'pvc-state')
  const helmState = resolve(work, 'helm-state')
  const realHelm = run('/bin/sh', ['-c', 'command -v helm'])
  assertSuccess(realHelm, 'locating Helm')
  const args = typeof argsOrBuilder === 'function' ? argsOrBuilder(work) : argsOrBuilder
  const result = run('/bin/bash', [tool, ...args], {
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
    args,
    helmCalls: readLines(helmLog),
    kubectlCalls: readLines(kubectlLog),
    operations: readLines(operationLog),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function assertNoSecretReadsOrReuse(invocation, label) {
  const helmText = invocation.helmCalls.join('\n')
  const kubectlText = invocation.kubectlCalls.join('\n')
  assert.doesNotMatch(helmText, /(?:^|\s)--reuse-values(?:\s|$)/,
    `${label} used Helm release values implicitly`)
  assert.ok(!invocation.helmCalls.some((call) => /^get manifest(?:\s|$)/.test(call)),
    `${label} read the secret-bearing Helm release manifest`)
  assert.doesNotMatch(kubectlText, /(?:^|\s)get\s+secrets?(?:\/|\s|$)/i,
    `${label} read Kubernetes Secret data`)
}

function assertLegacyCustodyEvidence(invocation, label) {
  assert.ok(invocation.helmCalls.some((call) => /^get values falcone(?:\s|$)/.test(call)
    && /(?:^|\s)--revision\s+20(?:\s|$)/.test(call)
    && /(?:^|\s)(?:-o|--output)\s+json(?:\s|$)/.test(call)),
  `${label} did not read the exact non-secret revision-20 values`)
  assert.ok(invocation.kubectlCalls.some((call) => (
    /(?:^|\s)-n\s+in-falcone-staging\s+get\s+deployment\s+falcone-control-plane(?:\s|$)/.test(call)
      && /(?:^|\s)(?:-o|--output)\s+json(?:\s|$)/.test(call)
  )), `${label} did not corroborate legacy/managed=false from the live Deployment`)
  assertNoSecretReadsOrReuse(invocation, label)
}

function relevantRenderAndUpgradeCalls(invocation) {
  return invocation.helmCalls.filter((call) => /^(?:template|diff upgrade|upgrade)(?:\s|$)/.test(call))
}

function assertExplicitLegacyCustody(invocation, label) {
  const calls = relevantRenderAndUpgradeCalls(invocation)
  assert.ok(calls.length > 0, `${label} exercised no public render or upgrade`)
  for (const call of calls) {
    for (const expected of legacyCustodyOverrides) {
      assert.ok(call.includes(expected), `${label} omitted ${expected} from:\n${call}`)
    }
  }
  assertNoSecretReadsOrReuse(invocation, label)
}

function mutationCalls(invocation) {
  return invocation.operations.filter((call) => (
    /^helm (?:install|rollback|uninstall|upgrade)(?:\s|$)/.test(call)
      || /^kubectl .*\b(?:apply|create|delete|patch|replace|scale|set)\b/.test(call)
  ))
}

// bbx-repair-staging-041 | fn-revision20-legacy-webhook-custody | OpenSpec #### Scenario: External legacy webhook-key custody is preserved
test('revision-20 legacy webhook-key custody is validated from public live metadata and passed explicitly', () => {
  const invocation = invoke(repairTool, ['--phase-a'], 'safe')
  try {
    assert.equal(invocation.result.status, 0,
      `revision-20 legacy custody dry-run failed:\n${combined(invocation.result)}\nhelm:\n${invocation.helmCalls.join('\n')}\nkubectl:\n${invocation.kubectlCalls.join('\n')}`)
    assertLegacyCustodyEvidence(invocation, 'Phase A dry-run')
    assertExplicitLegacyCustody(invocation, 'Phase A dry-run')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-042 | fn-revision20-legacy-webhook-custody | OpenSpec #### Scenario: External legacy webhook-key custody is preserved
test('missing or drifted live legacy custody fails closed before mutation', async (t) => {
  const cases = [
    ['revision-20 values absent', 'custody-values-missing'],
    ['managed creation enabled', 'custody-values-create-drift'],
    ['external Secret reference changed', 'custody-values-name-drift'],
    ['adoption mode changed', 'custody-values-adoption-drift'],
    ['rotation request is non-empty', 'custody-values-rotation-drift'],
    ['Deployment evidence absent', 'custody-deployment-missing'],
    ['Deployment mode changed', 'custody-deployment-mode-drift'],
    ['Deployment managed flag changed', 'custody-deployment-managed-drift'],
    ['Deployment Secret reference changed', 'custody-deployment-reference-drift'],
    ['Deployment key identity changed', 'custody-deployment-id-drift'],
  ]
  for (const [label, scenario] of cases) {
    await t.test(label, () => {
      const invocation = invoke(repairTool, ['--phase-a'], scenario)
      try {
        assert.notEqual(invocation.result.status, 0,
          `${label} unexpectedly passed:\n${combined(invocation.result)}`)
        assert.match(combined(invocation.result), /LEGACY_WEBHOOK_(?:CONTRACT|VALUES|DEPLOYMENT).*?(?:MISSING|DRIFT)/,
          `${label} did not return a stable custody error`)
        assert.deepEqual(mutationCalls(invocation), [], `${label} mutated public state`)
        assertNoSecretReadsOrReuse(invocation, label)
      } finally {
        invocation.cleanup()
      }
    })
  }
})

// bbx-repair-staging-043 | fn-revision20-legacy-webhook-custody | OpenSpec #### Scenario: External legacy webhook-key custody is preserved
test('Phase A, Phase B and forward recovery carry the same explicit minimal custody contract', async (t) => {
  const cases = [
    ['Phase A', repairTool, phaseAArgs, 'safe'],
    ['Phase B', repairTool, phaseBArgs, 'phase-a-complete'],
    ['forward recovery', recoveryTool, forwardArgs, 'forward-safe'],
  ]
  for (const [label, tool, args, scenario] of cases) {
    await t.test(label, () => {
      const invocation = invoke(tool, args, scenario)
      try {
        assert.equal(invocation.result.status, 0,
          `${label} failed:\n${combined(invocation.result)}\nhelm:\n${invocation.helmCalls.join('\n')}\nkubectl:\n${invocation.kubectlCalls.join('\n')}`)
        assertLegacyCustodyEvidence(invocation, label)
        assertExplicitLegacyCustody(invocation, label)
      } finally {
        invocation.cleanup()
      }
    })
  }
})

// bbx-repair-staging-044 | fn-revision21-failed-hook-resume | OpenSpec #### Scenario: Exact failed pre-hook revision is resumed
test('the exact revision-21 credential-hook failure resumes without rollback and completes both no-root passes', () => {
  const invocation = invoke(repairTool, (work) => phaseAArgs(work, failedResumeConfirmation), 'failed-resume-exact')
  try {
    assert.equal(invocation.result.status, 0,
      `exact failed-hook resume failed:\n${combined(invocation.result)}\nhelm:\n${invocation.helmCalls.join('\n')}\nkubectl:\n${invocation.kubectlCalls.join('\n')}`)
    assertLegacyCustodyEvidence(invocation, 'exact failed-hook resume')
    assertExplicitLegacyCustody(invocation, 'exact failed-hook resume')
    assert.ok(invocation.helmCalls.some((call) => /^history falcone(?:\s|$)/.test(call)
      && /(?:^|\s)(?:-o|--output)\s+json(?:\s|$)/.test(call)),
    'failed-hook resume did not validate exact Helm history')
    const upgrades = invocation.helmCalls.filter((call) => /^upgrade(?:\s|$)/.test(call))
    assert.equal(upgrades.length, 2, `failed-hook resume must perform two upgrades:\n${upgrades.join('\n')}`)
    for (const upgrade of upgrades) {
      assert.match(upgrade, /--set openbao\.openbao\.authReconcile\.allowRecoveryRoot=false/)
      assert.doesNotMatch(upgrade, /--set openbao\.openbao\.authReconcile\.allowRecoveryRoot=true/)
    }
    assert.ok(!invocation.helmCalls.some((call) => /^rollback(?:\s|$)/.test(call)),
      'failed-hook resume attempted rollback')
    assert.ok(!invocation.args.includes('--phase-a-attestation'),
      'failed-hook resume incorrectly required a Phase-A attestation')
    assert.match(combined(invocation.result), /phase-a=applied revision=23 chart=in-falcone-0\.4\.17/)
    assert.match(combined(invocation.result), /recovery-root(?:-allowance)?=(?:false|disabled)|no-root/i)
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-045 | fn-revision21-failed-hook-resume | OpenSpec #### Scenario: Exact failed pre-hook revision is resumed
test('every other failed revision, chart, status, description, history or confirmation is rejected', async (t) => {
  const cases = [
    ['list status drift', 'failed-resume-list-status-drift', failedResumeConfirmation],
    ['list revision drift', 'failed-resume-list-revision-drift', failedResumeConfirmation],
    ['list chart drift', 'failed-resume-list-chart-drift', failedResumeConfirmation],
    ['history revision drift', 'failed-resume-history-revision-drift', failedResumeConfirmation],
    ['history chart drift', 'failed-resume-history-chart-drift', failedResumeConfirmation],
    ['history status drift', 'failed-resume-history-status-drift', failedResumeConfirmation],
    ['history description drift', 'failed-resume-history-description-drift', failedResumeConfirmation],
    ['revision-20 history absent', 'failed-resume-history-source-missing', failedResumeConfirmation],
    ['revision-20 history status drift', 'failed-resume-history-source-status-drift', failedResumeConfirmation],
    ['revision-20 history chart drift', 'failed-resume-history-source-chart-drift', failedResumeConfirmation],
    ['stale revision-20 confirmation', 'failed-resume-exact', phaseAConfirmation],
  ]
  for (const [label, scenario, confirmation] of cases) {
    await t.test(label, () => {
      const invocation = invoke(repairTool, (work) => phaseAArgs(work, confirmation), scenario)
      try {
        assert.notEqual(invocation.result.status, 0,
          `${label} unexpectedly resumed:\n${combined(invocation.result)}`)
        assert.match(combined(invocation.result), /FAILED_RESUME|JIT_TARGET_CONFIRMATION_REQUIRED|REVISION_GATE_FAILED|STARTING_CHART_MISMATCH/,
          `${label} did not report a stable resume gate error`)
        assert.deepEqual(mutationCalls(invocation), [], `${label} mutated public state`)
        assertNoSecretReadsOrReuse(invocation, label)
      } finally {
        invocation.cleanup()
      }
    })
  }
})
