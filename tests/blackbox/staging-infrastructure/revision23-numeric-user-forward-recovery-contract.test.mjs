import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import {
  allContainers,
  assertSuccess,
  repoRoot,
  render,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

import { registerRevision23PartialManualRecoveryContract } from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'
import { registerRevision23PhaseAVectorPendingProgressContract } from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'
import { registerLegacyClusterSecretStoreHandoffContract } from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'
import { registerRevision24GlobalWaitRecoveryContract } from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const namedUserImages = [
  {
    component: 'apisix',
    repository: 'docker.io/apache/apisix',
    tag: '3.10.0-debian',
    uid: 636,
    gid: 636,
  },
  {
    component: 'observability',
    repository: 'docker.io/prom/prometheus',
    tag: 'v3.2.1',
    uid: 65534,
    gid: 65534,
  },
]

const repairDigest = 'sha256:0417041704170417041704170417041704170417041704170417041704170417'
const stagingFixtureDir = resolve(repoRoot, 'tests/blackbox/fixtures/staging-infrastructure')
const stagingFakeBin = resolve(stagingFixtureDir, 'fake-bin')
const recoveryCli = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')

function logLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
}

function materializeAttestation(templateName, destination) {
  const observedAt = new Date(Date.now() - 60_000).toISOString()
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString()
  const document = readFileSync(resolve(stagingFixtureDir, templateName), 'utf8')
    .replace('__OBSERVED_AT__', observedAt)
    .replace('__VALID_UNTIL__', validUntil)
  writeFileSync(destination, document)
}

function invokeRecovery(scenario, options = {}) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-r23-recovery-bbx-'))
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const operationLog = resolve(work, 'operations.log')
  const stateFile = resolve(work, 'state')
  const realHelm = run('sh', ['-c', 'command -v helm']).stdout.trim()
  const backupAttestation = resolve(work, 'backup-attestation.json')
  const parityAttestation = resolve(work, 'parity-attestation.json')
  materializeAttestation('revision23-backup-attestation.template.json', backupAttestation)
  materializeAttestation('revision23-parity-attestation.template.json', parityAttestation)
  const exactConfirmation = `default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.17/${repairDigest}`
  const args = options.apply
    ? [
        '--apply',
        '--confirm-target', options.confirmation ?? exactConfirmation,
        '--backup-attestation', backupAttestation,
        '--parity-attestation', parityAttestation,
      ]
    : []
  const result = run('bash', [recoveryCli, ...args], {
    env: {
      ...process.env,
      PATH: `${stagingFakeBin}:${process.env.PATH}`,
      KUBECONFIG: resolve(repoRoot, 'tests/blackbox/fixtures/offline-kubeconfig.yaml'),
      FALCONE_STAGING_SCENARIO: scenario,
      FALCONE_STAGING_HELM_LOG: helmLog,
      FALCONE_STAGING_KUBECTL_LOG: kubectlLog,
      FALCONE_STAGING_OPERATION_LOG: operationLog,
      FALCONE_STAGING_STATE_FILE: stateFile,
      FALCONE_STAGING_REAL_HELM: realHelm,
      FALCONE_STAGING_HELM_DELEGATE: realHelm,
      FALCONE_STAGING_REPAIR_VERSION: '0.4.17',
      FALCONE_STAGING_REPAIR_PACKAGE_DIGEST: repairDigest,
      FALCONE_STAGING_PACKAGED_CHART_SOURCE: umbrellaChart,
      FALCONE_STAGING_REVISION20_MANIFEST: resolve(stagingFixtureDir, 'revision-20-ownership-manifest.json'),
      FALCONE_STAGING_EXTERNAL_SECRETS_FIXTURE: resolve(stagingFixtureDir, 'external-secrets-ready.json'),
    },
  })
  return {
    result,
    args,
    helmCalls: logLines(helmLog),
    kubectlCalls: logLines(kubectlLog),
    operationCalls: logLines(operationLog),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

function assertNoMutation(invocation, context) {
  const mutations = invocation.operationCalls.filter((call) => (
    /^helm (?:upgrade|rollback|uninstall)\b/.test(call)
    || (
      /^kubectl .*\b(?:apply|create|delete|patch|replace|rollout|scale|set)\b/.test(call)
      && !/\bcreate --dry-run=client\b/.test(call)
    )
  ))
  assert.deepEqual(mutations, [], `${context} must fail before mutation; observed: ${mutations.join('; ')}`)
}

function publicValues() {
  const result = run('helm', ['show', 'values', umbrellaChart])
  assertSuccess(result, 'helm show values')
  const documents = yamlDocuments(result.stdout)
  assert.equal(documents.length, 1, 'public chart values must be one YAML document')
  return documents[0]
}

function targetContainers(objects) {
  const containers = allContainers(objects)
  return namedUserImages.map((expected) => {
    const matches = containers.filter(({ container }) => {
      const image = container.image ?? ''
      return image.startsWith(`${expected.repository}:`) || image.startsWith(`${expected.repository}@`)
    })
    assert.equal(matches.length, 1, `render must contain exactly one ${expected.component} image container`)
    return { expected, ...matches[0] }
  })
}

// bbx-repair-staging-050 | fn-revision23-numeric-image-users | OpenSpec #### Scenario: Vanilla Kubernetes starts images that declare named users
test('0.4.17 public values and vanilla render pin the verified numeric identities while remaining non-root', () => {
  const chartResult = run('helm', ['show', 'chart', umbrellaChart])
  assertSuccess(chartResult, 'helm show chart')
  const [chart] = yamlDocuments(chartResult.stdout)
  assert.equal(chart.version, '0.4.17', 'the repaired chart must be published as immutable version 0.4.17')

  const values = publicValues()
  const { objects } = render(umbrellaChart)

  for (const expected of namedUserImages) {
    const component = values[expected.component]
    assert.equal(component?.image?.repository, expected.repository)
    assert.equal(component?.image?.tag, expected.tag)
    assert.equal(component?.securityContext?.runAsUser, expected.uid, `${expected.component} values must publish its verified numeric UID`)
    assert.equal(component?.securityContext?.runAsGroup, expected.gid, `${expected.component} values must publish its verified numeric GID`)
    assert.equal(component?.securityContext?.runAsNonRoot, true, `${expected.component} values must retain runAsNonRoot`)
  }

  for (const { expected, podSpec, container } of targetContainers(objects)) {
    assert.equal(container.securityContext?.runAsUser, expected.uid, `${expected.component} render must set its numeric UID`)
    assert.equal(container.securityContext?.runAsGroup, expected.gid, `${expected.component} render must set its numeric GID`)
    assert.equal(container.securityContext?.runAsNonRoot ?? podSpec.securityContext?.runAsNonRoot, true, `${expected.component} render must remain non-root`)
  }
})

// bbx-repair-staging-055 | fn-revision23-jit-forward-recovery | OpenSpec #### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure
test('exact r23 apply uses fresh 0.4.17 evidence, delegates fail-forward, and performs exactly two non-atomic upgrades', (t) => {
  const invocation = invokeRecovery('r23-nonnumeric-safe', { apply: true })
  t.after(invocation.cleanup)

  assertSuccess(invocation.result, 'revision-23 fail-forward apply')
  assert.equal(invocation.args.includes('--phase-a-attestation'), false, 'r23 forward recovery must not require a Phase-A attestation for the failed Phase-A attempt')

  const upgrades = invocation.helmCalls.filter((call) => /^upgrade falcone\b/.test(call))
  assert.equal(upgrades.length, 2, `fail-forward must perform the two Phase-A upgrades, observed ${upgrades.length}:\n${upgrades.join('\n')}`)
  for (const call of upgrades) {
    assert.match(call, /(?:^| )--version 0\.4\.17(?: |$)/)
    assert.doesNotMatch(call, /(?:^| )--atomic(?: |$)/)
    assert.doesNotMatch(call, /(?:^| )--reuse-values(?: |$)/)
  }
  assert.equal(invocation.helmCalls.some((call) => /^rollback\b/.test(call)), false, 'fail-forward recovery must never roll back')
  assert.equal(invocation.kubectlCalls.some((call) => /\bdelete pvc\b/.test(call)), false, 'r23 recovery must never delete a PVC')
})

// bbx-repair-staging-056 | fn-revision23-jit-confirmation-gate | OpenSpec #### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure
test('inexact r23 apply confirmation fails before every mutation', (t) => {
  const wrongConfirmation = `default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.17/sha256:${'9'.repeat(64)}`
  const invocation = invokeRecovery('r23-nonnumeric-safe', { apply: true, confirmation: wrongConfirmation })
  t.after(invocation.cleanup)

  assert.notEqual(invocation.result.status, 0, `inexact confirmation unexpectedly passed:\n${invocation.result.stdout}\n${invocation.result.stderr}`)
  assertNoMutation(invocation, 'inexact r23 confirmation')
})

// bbx-repair-staging-051 | fn-openshift-arbitrary-image-users | OpenSpec #### Scenario: OpenShift retains arbitrary UID assignment
test('OpenShift overlay removes the vanilla fixed UID and GID from both named-user containers', () => {
  const openshiftOverlay = resolve(umbrellaChart, 'values/platform-openshift.yaml')
  const { objects } = render(umbrellaChart, ['-f', openshiftOverlay])

  for (const { expected, podSpec, container } of targetContainers(objects)) {
    assert.equal(container.securityContext?.runAsUser, undefined, `${expected.component} OpenShift render must not fix runAsUser`)
    assert.equal(container.securityContext?.runAsGroup, undefined, `${expected.component} OpenShift render must not fix runAsGroup`)
    assert.equal(podSpec.securityContext?.runAsUser, undefined, `${expected.component} OpenShift pod must retain arbitrary UID assignment`)
    assert.equal(podSpec.securityContext?.runAsGroup, undefined, `${expected.component} OpenShift pod must retain arbitrary GID assignment`)
  }
})

// bbx-repair-staging-052 | fn-revision23-phase-a-resume | OpenSpec #### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure
test('recovery dry-run admits only the exact r20/r22/r23 chain plus the two live non-numeric rollout failures', (t) => {
  const invocation = invokeRecovery('r23-nonnumeric-safe')
  t.after(invocation.cleanup)

  assertSuccess(invocation.result, 'revision-23 forward-recovery preflight')
  assert.match(invocation.result.stdout, /dry-run=true|no mutation performed/i)
  assert.ok(invocation.helmCalls.some((call) => /^history falcone\b/.test(call)), 'preflight must query public Helm history')
  assert.ok(invocation.kubectlCalls.some((call) => /\bget pods\b.*(?:^|\s)-o\s+json(?:\s|$)/.test(call)), 'preflight must query public live Pod status')
  assert.ok(invocation.kubectlCalls.some((call) => /\bget deployments(?:\.apps)?\b.*(?:^|\s)-o\s+json(?:\s|$)|\bget deployment falcone-(?:apisix|observability)(?:\s|$).*?(?:^|\s)-o\s+json(?:\s|$)/.test(call)), 'preflight must verify preserved Deployment availability')

  for (const call of invocation.helmCalls.filter((line) => /^(?:template|diff upgrade|pull|upgrade)\b/.test(line))) {
    assert.match(call, /(?:^| )--version 0\.4\.17(?: |$)/, `recovery target must be immutable 0.4.17: ${call}`)
  }
  assertNoMutation(invocation, 'admitted dry-run')
})

const historyDrifts = [
  'r23-nonnumeric-r20-status-drift',
  'r23-nonnumeric-r20-chart-drift',
  'r23-nonnumeric-r20-description-drift',
  'r23-nonnumeric-r22-status-drift',
  'r23-nonnumeric-r22-chart-drift',
  'r23-nonnumeric-r22-description-drift',
  'r23-nonnumeric-r23-status-drift',
  'r23-nonnumeric-r23-chart-drift',
  'r23-nonnumeric-r23-description-drift',
]

// bbx-repair-staging-053 | fn-revision23-failed-anchor-gate | OpenSpec #### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure
test('recovery rejects every individual r20/r22/r23 anchor drift, including an arbitrary canceled r23', async (t) => {
  for (const scenario of historyDrifts) {
    await t.test(scenario, (t) => {
      const invocation = invokeRecovery(scenario)
      t.after(invocation.cleanup)
      assert.notEqual(invocation.result.status, 0, `${scenario} unexpectedly passed:\n${invocation.result.stdout}\n${invocation.result.stderr}`)
      assert.ok(invocation.helmCalls.some((call) => /^history falcone\b/.test(call)), `${scenario} must be rejected from public Helm history`)
      assertNoMutation(invocation, scenario)
    })
  }
})

const liveEvidenceDrifts = [
  'r23-nonnumeric-live-one',
  'r23-nonnumeric-live-extra',
  'r23-nonnumeric-live-reason-drift',
  'r23-nonnumeric-live-user-drift',
  'r23-nonnumeric-availability-drift',
]

// bbx-repair-staging-054 | fn-revision23-live-rollout-gate | OpenSpec #### Scenario: Phase A resumes the admitted revision-23 non-numeric image-user failure
test('recovery rejects incomplete, extra, changed, or unavailable live rollout evidence', async (t) => {
  for (const scenario of liveEvidenceDrifts) {
    await t.test(scenario, (t) => {
      const invocation = invokeRecovery(scenario)
      t.after(invocation.cleanup)
      assert.notEqual(invocation.result.status, 0, `${scenario} unexpectedly passed:\n${invocation.result.stdout}\n${invocation.result.stderr}`)
      assert.ok(invocation.helmCalls.some((call) => /^history falcone\b/.test(call)), `${scenario} must first prove exact Helm history`)
      assert.ok(invocation.kubectlCalls.some((call) => /\bget pods\b.*(?:^|\s)-o\s+json(?:\s|$)/.test(call)), `${scenario} must be rejected from public live Pod evidence`)
      assertNoMutation(invocation, scenario)
    })
  }
})

// bbx-repair-staging-057 | fn-revision23-partial-manual-recovery | OpenSpec #### Scenario: Phase A admits only the exact revision-23 partial manual recovery
registerRevision23PartialManualRecoveryContract()

// bbx-repair-staging-058 | fn-revision23-phase-a-vector-pending-progress | OpenSpec #### Scenario: Phase A does not wait globally for the intentionally Pending vector workload
registerRevision23PhaseAVectorPendingProgressContract()

// bbx-repair-staging-059 | fn-legacy-clustersecretstore-hook-handoff | OpenSpec #### Scenario: Legacy ClusterSecretStore hook is handed off before Phase A
registerLegacyClusterSecretStoreHandoffContract()

// bbx-repair-staging-060 | fn-revision24-global-wait-timeout-recovery | OpenSpec #### Scenario: Phase A resumes only the exact revision-24 global-wait timeout
registerRevision24GlobalWaitRecoveryContract()
