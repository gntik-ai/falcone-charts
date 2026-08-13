/**
 * Public black-box contracts for the 0.4.18 OpenBao self-token policy repair.
 * Only rendered Helm resources and the offline recovery CLI surface are used.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'

import {
  assertSuccess,
  combined,
  render,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'
import {
  revision24SelfTokenPolicyContract,
  runRevision24SelfTokenPolicyRecovery,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const platformPolicyTemplate =
  'charts/openbao/templates/openbao-policies/platform-policy.hcl.yaml'
const authReconcileTemplate = 'charts/openbao/templates/openbao-auth-reconcile-job.yaml'
const authReconcilerRbacTemplate =
  'charts/openbao/templates/openbao-auth-reconciler-rbac.yaml'
const initTemplate = 'charts/openbao/templates/openbao-init-job.yaml'

function publicChartVersion() {
  const result = run('helm', ['show', 'chart', umbrellaChart])
  assertSuccess(result, 'helm show chart charts/in-falcone')
  const documents = yamlDocuments(result.stdout)
  assert.equal(documents.length, 1, 'public chart metadata must be one YAML document')
  return documents[0].version
}

function oneObject(objects, kind, name) {
  const matches = objects.filter((object) =>
    object?.kind === kind && object?.metadata?.name === name
  )
  assert.equal(matches.length, 1, `expected exactly one ${kind}/${name}`)
  return matches[0]
}

function shellScript(container) {
  assert.ok(container, 'expected public container was not rendered')
  return (container.args ?? []).join('\n')
}

function policyBlocks(hcl, prefix) {
  return [...hcl.matchAll(/path\s+"([^"]+)"\s*\{([\s\S]*?)\}/g)]
    .map((match) => {
      const capabilities = match[2].match(/capabilities\s*=\s*\[([^\]]*)\]/)?.[1] ?? ''
      return {
        path: match[1],
        capabilities: [...capabilities.matchAll(/"([^"]+)"/g)]
          .map((entry) => entry[1])
          .sort(),
      }
    })
    .filter((block) => block.path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function traceLines(result) {
  return result.trace.split('\n').filter(Boolean)
}

function createdAuthJobs(result) {
  return traceLines(result).flatMap((line, index) => {
    const match = line.match(
      /^kubectl create auth-reconcile-job ref=(\S+) generateName=(\S+) chart=(\S+) digest=(\S+) sourceRevision=(\S+) allowRecoveryRoot=(\S+)$/,
    )
    return match ? [{
      index,
      line,
      ref: match[1],
      generateName: match[2],
      chart: match[3],
      digest: match[4],
      sourceRevision: match[5],
      allowRecoveryRoot: match[6],
    }] : []
  })
}

function assertFresh018Job(job, context) {
  assert.ok(job, `${context} did not create a fresh recovery Job`)
  assert.match(job.ref, new RegExp(
    `^${revision24SelfTokenPolicyContract.jobPrefix.replaceAll('.', '\\.')}[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`,
  ))
  assert.equal(
    job.generateName,
    revision24SelfTokenPolicyContract.jobPrefix.replace(/^job\.batch\//, ''),
  )
  assert.equal(job.chart, 'in-falcone-0.4.18')
  assert.equal(job.digest, revision24SelfTokenPolicyContract.packageDigest)
  assert.equal(job.sourceRevision, '24')
  assert.equal(job.allowRecoveryRoot, 'true')
}

function assertNoMutation(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded`)
  assert.equal(result.mutations, '', `${context} mutated:\n${result.mutations}`)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m)
  assert.doesNotMatch(result.trace, /kubectl .*\b(?:apply|create|delete|patch|replace)\b/)
  assert.doesNotMatch(result.trace, /kubectl .*\bget (?:secret|secrets)(?:\s|$)/)
}

// bbx-repair-staging-073 | fn-openbao-platform-self-token-policy | OpenSpec #### Scenario: Platform policy grants only OpenBao token self-service capabilities
test('platform policy grants only exact lookup-self and revoke-self capabilities', () => {
  const { objects } = render(umbrellaChart, [
    '--show-only', platformPolicyTemplate,
  ])
  const configMap = oneObject(objects, 'ConfigMap', 'openbao-policy-platform')
  const hcl = configMap.data?.['platform.hcl'] ?? ''
  const tokenBlocks = policyBlocks(hcl, 'auth/token/')

  assert.deepEqual(tokenBlocks, [
    {path: 'auth/token/lookup-self', capabilities: ['read']},
    {path: 'auth/token/revoke-self', capabilities: ['update']},
  ])
  assert.doesNotMatch(hcl, /path\s+"auth\/token\/(?:\*|lookup|revoke|create|renew|roles?)"/)
  assert.doesNotMatch(hcl, /\bdefault\b/i)
  assert.equal(publicChartVersion(), '0.4.18', 'the corrected public package must be 0.4.18')
})

// bbx-repair-staging-074 | fn-openbao-platform-policy-recovery-bootstrap | OpenSpec #### Scenario: Auth reconciliation installs the platform policy before no-default canary validation
test('recovery-root auth reconciliation applies platform policy before the no-default canary', () => {
  const { objects } = render(umbrellaChart, [
    '--is-upgrade',
    '-f', stagingValues,
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-self-token-policy',
    '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
    '--set', 'openbao.openbao.authReconcile.allowRecoveryRoot=true',
    '--set', 'openbao.openbao.authReconcile.forceRecoveryRoot=true',
    '--show-only', authReconcileTemplate,
  ])
  const job = oneObject(objects, 'Job', 'openbao-auth-reconcile')
  const podSpec = job.spec?.template?.spec
  const reconciler = podSpec?.containers?.find(
    (container) => container.name === 'auth-metadata-reconciler',
  )
  const script = shellScript(reconciler)
  const platformVolume = podSpec?.volumes?.find((volume) => volume.name === 'platform-policy')
  assert.deepEqual(platformVolume?.emptyDir, {},
    'recovery Job must materialize the package policy into emptyDir')
  assert.equal(
    podSpec?.volumes?.some((volume) => volume.configMap?.name === 'openbao-policy-platform'),
    false,
    'recovery Job must not consume the same-name live ConfigMap',
  )
  const platformMount = reconciler.volumeMounts?.find(
    (mount) => mount.name === platformVolume.name,
  )
  assert.equal(platformMount?.mountPath, '/openbao-platform')

  const rootStart = script.indexOf('if [ "$auth_source" = "recovery_root" ]; then')
  const rootEnd = script.indexOf('\nfi', rootStart)
  const policyWrite = script.indexOf('bao policy write platform')
  const roleWrite = script.indexOf('bao write "auth/kubernetes/role/$role"')
  const canaryLogin = script.indexOf('role="$role" jwt="$(cat /canary/token)"')
  assert.ok(rootStart !== -1 && policyWrite > rootStart && policyWrite < rootEnd,
    'platform policy write must be limited to the explicitly authorized recovery-root block')
  assert.equal((script.match(/bao policy write platform/g) ?? []).length, 1)
  assert.match(
    script.slice(policyWrite, policyWrite + 180),
    new RegExp(platformMount.mountPath.replaceAll('/', '\\/') + '/platform\\.hcl'),
  )
  assert.ok(policyWrite < roleWrite, 'platform policy must precede the no-default ESO role write')
  assert.ok(policyWrite < canaryLogin, 'platform policy must precede the no-default canary login')
  assert.equal(publicChartVersion(), '0.4.18', 'the corrected public package must be 0.4.18')
})

// bbx-repair-staging-075 | fn-openbao-platform-policy-install-and-least-privilege | OpenSpec #### Scenario: Auth reconciliation installs the platform policy before no-default canary validation
test('fresh install writes platform policy while routine reconciler retains no policy-write privilege', () => {
  const fresh = render(umbrellaChart, [
    '-f', stagingValues,
    '--show-only', initTemplate,
  ])
  const initJob = oneObject(fresh.objects, 'Job', 'openbao-init')
  const initPod = initJob.spec?.template?.spec
  const init = initPod?.containers?.find((container) => container.name === 'openbao-init')
  const initScript = shellScript(init)
  const policiesVolume = initPod?.volumes?.find((volume) =>
    volume.projected?.sources?.some(
      (source) => source.configMap?.name === 'openbao-policy-platform',
    )
  )
  assert.ok(policiesVolume, 'fresh install must project openbao-policy-platform')
  const policiesMount = init.volumeMounts?.find((mount) => mount.name === policiesVolume.name)
  assert.ok(policiesMount?.readOnly, 'fresh-install policy projection must be read-only')
  assert.match(initScript, /for policy in init platform tenant functions gateway iam auth-reconcile; do/)
  assert.match(initScript, /bao policy write "\$policy" "\/config\/policies\/\$\{policy\}\.hcl"/)
  assert.ok(
    initScript.indexOf('bao policy write "$policy"') <
      initScript.indexOf('bao write auth/kubernetes/role/eso-role'),
    'fresh install must write platform policy before creating the ESO role',
  )

  const routine = render(umbrellaChart, [
    '-f', stagingValues,
    '--show-only', authReconcilerRbacTemplate,
  ])
  const routinePolicy = oneObject(
    routine.objects,
    'ConfigMap',
    'openbao-policy-auth-reconcile',
  ).data?.['auth-reconcile.hcl'] ?? ''
  assert.deepEqual(policyBlocks(routinePolicy, 'sys/policies/'), [
    {path: 'sys/policies/acl', capabilities: ['list']},
  ])
  assert.doesNotMatch(
    routinePolicy,
    /path\s+"sys\/policies[^"}]*"[\s\S]*?capabilities\s*=\s*\[[^\]]*"(?:create|update|delete|patch|sudo)"/,
  )
  assert.equal(publicChartVersion(), '0.4.18', 'the corrected public package must be 0.4.18')
})

// bbx-repair-staging-076 | fn-revision24-self-token-policy-recovery | OpenSpec #### Scenario: Revision-24 recovery admits only the exact 0.4.14 self-token policy failure
test('r24 fail-forward admits the exact published 0.4.14 lookup-self 403 precursor', () => {
  const version = publicChartVersion()
  const result = runRevision24SelfTokenPolicyRecovery({targetVersion: version})
  assert.equal(
    result.status,
    0,
    `exact self-token precursor was not recovered:\n${combined(result)}\n${result.trace}`,
  )
  assert.match(result.stdout, /revision24-global-wait-recovery=validated/)
  assert.match(result.stdout, /chart=in-falcone-0\.4\.11/)
  const creations = createdAuthJobs(result)
  assert.equal(creations.length, 1)
  assertFresh018Job(creations[0], 'exact self-token precursor')
  assert.doesNotMatch(result.trace, /kubectl .*\bpatch clustersecretstore/,
    'already desired ClusterSecretStore must not be patched again')
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedPartialJobRef.replaceAll('.', '\\.')}`),
  )
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedFailedJobRef.replaceAll('.', '\\.')}`),
  )
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedFailed017JobRef.replaceAll('.', '\\.')}`),
  )
  const upgrades = traceLines(result).filter((line) => line.startsWith('helm upgrade '))
  assert.equal(upgrades.length, 2)
  assert.ok(upgrades.every((line) => /(?:^|\s)--version 0\.4\.18(?:\s|$)/.test(line)))
  assert.equal(version, '0.4.18', 'the recovery target must be public chart 0.4.18')
})

// bbx-repair-staging-077 | fn-revision24-self-token-policy-precursor-gate | OpenSpec #### Scenario: Revision-24 recovery admits only the exact 0.4.14 self-token policy failure
test('r24 rejects every self-token precursor drift before mutation', async (t) => {
  const version = publicChartVersion()
  const cases = [
    ['lookup URL/path', (fixture) => {
      fixture.authBlockedStore.store.status.conditions[0].message =
        fixture.authBlockedStore.store.status.conditions[0].message
          .replace('/v1/auth/token/lookup-self', '/v1/auth/token/lookup')
    }, /kubectl .*\bget clustersecretstore/],
    ['HTTP code', (fixture) => {
      fixture.authBlockedStore.store.status.conditions[0].message =
        fixture.authBlockedStore.store.status.conditions[0].message.replace('Code: 403', 'Code: 401')
    }, /kubectl .*\bget clustersecretstore/],
    ['reason', (fixture) => {
      fixture.authBlockedStore.store.status.conditions[0].reason = 'InvalidProviderConfig'
    }, /kubectl .*\bget clustersecretstore/],
    ['message', (fixture) => {
      fixture.authBlockedStore.store.status.conditions[0].message =
        fixture.authBlockedStore.store.status.conditions[0].message.replace('permission denied', 'access denied')
    }, /kubectl .*\bget clustersecretstore/],
    ['provider spec', (fixture) => {
      fixture.authBlockedStore.store.spec.provider.vault.auth.kubernetes.role = 'unexpected-role'
    }, /kubectl .*\bget clustersecretstore/],
    ['store cardinality', (fixture) => {
      fixture.legacyStoreHandoff.extraStores = [structuredClone(fixture.authBlockedStore.store)]
      fixture.legacyStoreHandoff.extraStores[0].metadata.uid = 'duplicate-store-uid'
    }, /kubectl .*\bget clustersecretstores/],
    ['reconcile annotation', (fixture) => {
      fixture.authBlockedStore.store.metadata.annotations['in-falcone.io/reconcile-request'] =
        'unexpected-request'
    }, /kubectl .*\bget clustersecretstore/],
    ['store UID', (fixture) => {
      fixture.authBlockedStore.store.metadata.uid = 'unexpected-store-uid'
    }, /kubectl .*\bget clustersecretstore/],
    ['ExternalSecret cardinality', (fixture) => {
      fixture.externalSecretNames.pop()
    }, /kubectl .*\bget externalsecrets/],
    ['ExternalSecret readiness', (fixture) => {
      fixture.authBlockedStore.externalSecretFailureName = fixture.externalSecretNames[0]
    }, /kubectl .*\bget externalsecrets/],
  ]

  for (const [name, mutatePrecursor, evidence] of cases) {
    await t.test(name, () => {
      const result = runRevision24SelfTokenPolicyRecovery({
        targetVersion: version,
        mutatePrecursor,
      })
      assertNoMutation(result, name)
      assert.match(result.trace, evidence, `${name} was not rejected from public evidence`)
      assert.match(combined(result), /(?:DRIFT|MISMATCH|REQUIRED)/)
    })
  }
})

// bbx-repair-staging-078 | fn-revision24-self-token-policy-retry-identity | OpenSpec #### Scenario: Revision-24 recovery admits only the exact 0.4.14 self-token policy failure
test('r24 retry retains the 0.4.14, 0.4.16, and 0.4.17 failed Jobs and creates a new 0.4.18 identity per attempt', () => {
  const version = publicChartVersion()
  const result = runRevision24SelfTokenPolicyRecovery({
    targetVersion: version,
    attemptCount: 2,
    waitFailures: 1,
  })
  assert.equal(result.attempts.length, 2)
  assert.notEqual(result.attempts[0].status, 0)
  assert.match(combined(result.attempts[0]), /REVISION24_AUTH_RECONCILE_INCOMPLETE/)
  assert.equal(result.attempts[1].status, 0, combined(result.attempts[1]))
  const creations = createdAuthJobs(result)
  assert.equal(creations.length, 2)
  creations.forEach((creation) => assertFresh018Job(creation, 'self-token retry'))
  assert.notEqual(creations[0].ref, creations[1].ref)
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedPartialJobRef.replaceAll('.', '\\.')}`),
  )
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedFailedJobRef.replaceAll('.', '\\.')}`),
  )
  assert.doesNotMatch(
    result.trace,
    new RegExp(`kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24SelfTokenPolicyContract.publishedFailed017JobRef.replaceAll('.', '\\.')}`),
  )
  assert.doesNotMatch(result.trace, /kubectl .*\bdelete\b.*openbao-auth-reconcile/)
  assert.equal(version, '0.4.18', 'the retry target must be public chart 0.4.18')
})
