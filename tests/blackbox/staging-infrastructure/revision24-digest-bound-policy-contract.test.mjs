/**
 * Public black-box contracts for the 0.4.18 revision-24 package-bound policy repair.
 * The tests inspect only Helm-rendered resources and execute the distributed recovery CLI.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
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
  render,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'
import {
  makeRevision24Failed018RetryJob,
  revision24DigestBoundPolicyContract,
  runRevision24DigestBoundPolicyRecovery,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const authReconcileTemplate = 'charts/openbao/templates/openbao-auth-reconcile-job.yaml'
const fakeBin = resolve(
  repoRoot,
  'tests/blackbox/fixtures/staging-infrastructure/fake-bin',
)
const renderEvidence = [
  '-f', stagingValues,
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-digest-bound-policy',
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
]

function publicChartVersion() {
  const result = run('helm', ['show', 'chart', umbrellaChart])
  assertSuccess(result, 'helm show chart charts/in-falcone')
  const documents = yamlDocuments(result.stdout)
  assert.equal(documents.length, 1)
  return documents[0].version
}

function renderAuthJob({ allowRecoveryRoot, forceRecoveryRoot }) {
  const args = [
    '--is-upgrade',
    ...renderEvidence,
    '--set', `openbao.openbao.authReconcile.allowRecoveryRoot=${allowRecoveryRoot}`,
  ]
  if (forceRecoveryRoot) {
    args.push('--set', 'openbao.openbao.authReconcile.forceRecoveryRoot=true')
  }
  args.push('--show-only', authReconcileTemplate)
  const { objects } = render(umbrellaChart, args)
  const jobs = objects.filter((object) =>
    object?.apiVersion === 'batch/v1' &&
    object?.kind === 'Job' &&
    object?.metadata?.name === 'openbao-auth-reconcile'
  )
  assert.equal(jobs.length, 1, 'expected exactly one public auth reconcile Job')
  return jobs[0]
}

function canonicalPolicies() {
  const { objects } = render(umbrellaChart, renderEvidence)
  const configMap = (name) => {
    const matches = objects.filter((object) =>
      object?.apiVersion === 'v1' && object?.kind === 'ConfigMap' && object?.metadata?.name === name
    )
    assert.equal(matches.length, 1, `expected one public ${name} ConfigMap`)
    return matches[0]
  }
  return {
    platform: configMap('openbao-policy-platform').data?.['platform.hcl'],
    authReconcile: configMap('openbao-policy-auth-reconcile').data?.['auth-reconcile.hcl'],
  }
}

function reconciler(job) {
  const container = job.spec?.template?.spec?.containers?.find(
    (candidate) => candidate.name === 'auth-metadata-reconciler',
  )
  assert.ok(container, 'rendered Job lacks its public reconciler container')
  return container
}

function scalarStrings(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((item) => scalarStrings(item, output))
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => scalarStrings(item, output))
  }
  return output
}

function runRenderedReconciler(script) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-digest-policy-bbx-'))
  const state = resolve(work, 'state')
  const serviceAccount = resolve(work, 'serviceaccount')
  const canary = resolve(work, 'canary')
  const tls = resolve(work, 'tls')
  const recovery = resolve(work, 'recovery')
  const platform = resolve(work, 'platform')
  const authReconcile = resolve(work, 'auth-reconcile')
  for (const directory of [state, serviceAccount, canary, tls, recovery, platform, authReconcile]) {
    mkdirSync(directory)
  }
  writeFileSync(resolve(serviceAccount, 'token'), 'synthetic-dedicated-jwt')
  writeFileSync(resolve(canary, 'token'), 'synthetic-canary-jwt')
  writeFileSync(resolve(tls, 'ca.crt'), 'synthetic-ca')
  writeFileSync(resolve(recovery, 'root-token'), 'synthetic-recovery-root')
  writeFileSync(resolve(platform, 'platform.hcl'), 'path "auth/token/*" { capabilities = ["sudo"] }\n')
  writeFileSync(
    resolve(authReconcile, 'auth-reconcile.hcl'),
    'path "secret/data/*" { capabilities = ["read"] }\n',
  )
  const log = resolve(work, 'bao.log')
  const executable = script
    .replaceAll('/var/run/secrets/kubernetes.io/serviceaccount/token', resolve(serviceAccount, 'token'))
    .replaceAll('/canary/token', resolve(canary, 'token'))
    .replaceAll('/openbao/tls/ca.crt', resolve(tls, 'ca.crt'))
    .replaceAll('/openbao-recovery/root-token', resolve(recovery, 'root-token'))
    .replaceAll('/openbao-platform/platform.hcl', resolve(platform, 'platform.hcl'))
    .replaceAll('/openbao-auth-reconcile/auth-reconcile.hcl', resolve(authReconcile, 'auth-reconcile.hcl'))
  const result = run('/bin/sh', ['-ec', executable], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FALCONE_OPENBAO_LOG: log,
      FALCONE_OPENBAO_STATE_DIR: state,
      FALCONE_OPENBAO_SCENARIO: 'matching',
    },
    timeout: 30_000,
  })
  const capturedPolicy = (name) => {
    const path = resolve(state, `policy-${name}.hcl`)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return {
    result,
    calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    platform: capturedPolicy('platform'),
    authReconcile: capturedPolicy('auth-reconcile'),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
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
  assert.ok(job, `${context} did not create a fresh 0.4.18 Job`)
  assert.match(job.ref, new RegExp(
    `^${revision24DigestBoundPolicyContract.jobPrefix.replaceAll('.', '\\.')}[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`,
  ))
  assert.equal(
    job.generateName,
    revision24DigestBoundPolicyContract.jobPrefix.replace(/^job\.batch\//, ''),
  )
  assert.equal(job.chart, 'in-falcone-0.4.18')
  assert.equal(job.digest, revision24DigestBoundPolicyContract.packageDigest)
  assert.equal(job.sourceRevision, '24')
  assert.equal(job.allowRecoveryRoot, 'true')
}

function assertRetainedHistoryRejected(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded`)
  assert.equal(result.mutations, '', `${context} mutated:\n${result.mutations}`)
  assert.match(combined(result), /REVISION24_AUTH_RECONCILE_HISTORY_DRIFT/)
  assert.match(result.trace, /^kubectl -n secret-store get jobs\.batch -o json$/m)
  assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m)
}

// bbx-repair-staging-086 | fn-revision24-package-bound-policy-snapshots | OpenSpec #### Scenario: Forced revision-24 reconciliation uses package-bound policy snapshots
test('forced r24 Job embeds exact policy snapshots and does not mount canonical policy ConfigMaps', () => {
  const policies = canonicalPolicies()
  const job = renderAuthJob({ allowRecoveryRoot: true, forceRecoveryRoot: true })
  const strings = scalarStrings(job)
  assert.ok(strings.some((value) => value.includes(policies.platform)),
    'forced Job does not carry the package-rendered platform HCL bytes')
  assert.ok(strings.some((value) => value.includes(policies.authReconcile)),
    'forced Job does not carry the package-rendered auth-reconcile HCL bytes')

  assert.match(policies.platform, /path "auth\/token\/lookup-self"\s*\{\s*capabilities = \["read"\]\s*\}/)
  assert.match(policies.platform, /path "auth\/token\/revoke-self"\s*\{\s*capabilities = \["update"\]\s*\}/)
  assert.doesNotMatch(policies.platform, /path "auth\/token\/(?:\*|[^"\n]*token[^"\n]*)"/)

  const configMapNames = (job.spec?.template?.spec?.volumes ?? [])
    .map((volume) => volume.configMap?.name)
    .filter(Boolean)
  assert.equal(configMapNames.includes('openbao-policy-platform'), false)
  assert.equal(configMapNames.includes('openbao-policy-auth-reconcile'), false)
})

// bbx-repair-staging-087 | fn-revision24-package-bound-policy-order | OpenSpec #### Scenario: Forced revision-24 reconciliation writes policy snapshots before roles and canary
test('forced r24 execution ignores poisoned live policy ConfigMaps and writes package bytes first', () => {
  const policies = canonicalPolicies()
  const job = renderAuthJob({ allowRecoveryRoot: true, forceRecoveryRoot: true })
  const script = (reconciler(job).args ?? []).join('\n')
  const invocation = runRenderedReconciler(script)
  try {
    assert.equal(invocation.result.status, 0,
      `forced reconciler failed:\n${combined(invocation.result)}\n${invocation.calls.join('\n')}`)
    assert.equal(invocation.platform, policies.platform,
      'forced recovery consumed the live platform ConfigMap instead of package bytes')
    assert.equal(invocation.authReconcile, policies.authReconcile,
      'forced recovery consumed the live auth-reconcile ConfigMap instead of package bytes')

    const platformWrite = invocation.calls.findIndex((line) => /^policy write platform\b/.test(line))
    const reconcilerWrite = invocation.calls.findIndex((line) => /^policy write auth-reconcile\b/.test(line))
    const firstRoleWrite = invocation.calls.findIndex((line) => /write auth\/kubernetes\/role\//.test(line))
    const canary = invocation.calls.findIndex((line) =>
      /write -format=json auth\/kubernetes\/login.*role=eso-role/.test(line)
    )
    assert.ok(platformWrite >= 0 && reconcilerWrite > platformWrite)
    assert.ok(firstRoleWrite > reconcilerWrite, 'role mutation preceded package policy writes')
    assert.ok(canary > firstRoleWrite, 'canary preceded policy and role convergence')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-088 | fn-revision24-terminal-diagnostics-retention | OpenSpec #### Scenario: Forced revision-24 reconciliation retains terminal failure diagnostics
test('forced r24 Job makes one Pod attempt and retains its terminal diagnostic log', () => {
  const job = renderAuthJob({ allowRecoveryRoot: true, forceRecoveryRoot: true })
  assert.equal(job.spec?.backoffLimit, 0, 'forced recovery Job must not create a replacement Pod attempt')
  assert.equal(job.spec?.template?.spec?.restartPolicy, 'Never',
    'forced recovery Pod must retain the failing container log')
})

// bbx-repair-staging-089 | fn-openbao-routine-package-isolation | OpenSpec #### Scenario: Routine OpenBao reconciliation remains dedicated-only and cannot consume recovery snapshots
test('routine upgrade remains dedicated-only without recovery credentials or policy snapshots', () => {
  const policies = canonicalPolicies()
  const job = renderAuthJob({ allowRecoveryRoot: false, forceRecoveryRoot: false })
  const podSpec = job.spec?.template?.spec
  const container = reconciler(job)
  const script = (container.args ?? []).join('\n')
  assert.match(script, /role=openbao-auth-reconcile-role/)
  assert.doesNotMatch(script, /auth_source=recovery_root result=accepted/)
  assert.doesNotMatch(script, /\bpolicy write\b/)
  assert.equal(
    podSpec?.volumes?.some((volume) => volume.secret?.secretName === 'openbao-recovery'),
    false,
  )
  const strings = scalarStrings(job)
  assert.equal(strings.some((value) => value.includes(policies.platform)), false)
  assert.equal(strings.some((value) => value.includes(policies.authReconcile)), false)
})

// bbx-repair-staging-090 | fn-revision24-digest-bound-policy-history | OpenSpec #### Scenario: Revision-24 recovery admits only the exact retained 0.4.14, 0.4.16, and 0.4.17 failure chain
test('r24 requires exact .14/.16/.17 anchors, permits exact .18 failures, and targets only .18', async (t) => {
  await t.test('exact anchors with no prior .18 attempt create one fresh digest-bound Job', () => {
    const result = runRevision24DigestBoundPolicyRecovery()
    assert.equal(result.status, 0, `exact 0.4.18 recovery failed:\n${combined(result)}\n${result.trace}`)
    const jobs = createdAuthJobs(result)
    assert.equal(jobs.length, 1)
    assertFresh018Job(jobs[0], 'exact retained chain')
    const historyRead = traceLines(result).findIndex((line) =>
      line === 'kubectl -n secret-store get jobs.batch -o json'
    )
    assert.ok(historyRead >= 0 && jobs[0].index > historyRead)
    for (const retained of [
      revision24DigestBoundPolicyContract.publishedPartial014JobRef,
      revision24DigestBoundPolicyContract.publishedFailed016JobRef,
      revision24DigestBoundPolicyContract.publishedFailed017JobRef,
    ]) {
      assert.notEqual(jobs[0].ref, retained)
      assert.doesNotMatch(
        result.trace,
        new RegExp(`kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${retained.replaceAll('.', '\\.')}\\b`),
      )
    }
  })

  await t.test('zero to many exact failed .18 Jobs are retained and never reused', () => {
    const prior = [
      makeRevision24Failed018RetryJob({
        suffix: 'prior1',
        uid: '00000000-0000-4000-8000-000000000118',
      }),
      makeRevision24Failed018RetryJob({
        suffix: 'prior2',
        uid: '00000000-0000-4000-8000-000000000218',
      }),
    ]
    const result = runRevision24DigestBoundPolicyRecovery({
      mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(...structuredClone(prior)),
    })
    assert.equal(result.status, 0, `exact 0.4.18 retry history failed:\n${combined(result)}\n${result.trace}`)
    const [fresh] = createdAuthJobs(result)
    assertFresh018Job(fresh, '0.4.18 retry')
    for (const retained of prior) {
      assert.notEqual(fresh.ref, retained.ref)
      assert.doesNotMatch(
        result.trace,
        new RegExp(`kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${retained.ref.replaceAll('.', '\\.')}\\b`),
      )
    }
  })

  const historyDrifts = [
    ['missing 0.4.17 anchor', (fixture) => fixture.authRecovery.staleJobs.splice(2, 1)],
    ['0.4.17 UID', (fixture) => {
      fixture.authRecovery.staleJobs[2].object.metadata.uid =
        '11111111-2222-4333-8444-555555555555'
    }],
    ['0.4.17 digest', (fixture) => {
      fixture.authRecovery.staleJobs[2].object.metadata.annotations[
        'in-falcone.io/recovery-package-digest'
      ] = `sha256:${'dead'.repeat(16)}`
    }],
    ['0.4.17 terminal condition', (fixture) => {
      fixture.authRecovery.staleJobs[2].object.status.conditions[0].reason = 'DeadlineExceeded'
    }],
    ['0.4.18 name', (fixture) => {
      fixture.authRecovery.staleJobs.push(makeRevision24Failed018RetryJob({ suffix: 'bad_suffix' }))
    }],
    ['0.4.18 UID', (fixture) => {
      fixture.authRecovery.staleJobs.push(makeRevision24Failed018RetryJob({ uid: 'not-a-uuid' }))
    }],
    ['0.4.18 digest', (fixture) => {
      const retry = makeRevision24Failed018RetryJob()
      retry.object.metadata.annotations['in-falcone.io/recovery-package-digest'] =
        `sha256:${'dead'.repeat(16)}`
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 status', (fixture) => {
      const retry = makeRevision24Failed018RetryJob()
      retry.object.status.failed = 2
      fixture.authRecovery.staleJobs.push(retry)
    }],
  ]
  for (const [name, mutatePrecursor] of historyDrifts) {
    await t.test(`rejects ${name} drift before mutation`, () => {
      const result = runRevision24DigestBoundPolicyRecovery({ mutatePrecursor })
      assertRetainedHistoryRejected(result, name)
    })
  }

  await t.test('published failed target 0.4.17 is rejected before mutation', () => {
    const result = runRevision24DigestBoundPolicyRecovery({
      targetVersion: '0.4.17',
      packageDigest: revision24DigestBoundPolicyContract.publishedFailed017Digest,
    })
    assert.notEqual(result.status, 0, '0.4.17 unexpectedly remained an accepted target')
    assert.equal(result.mutations, '', `0.4.17 target mutated:\n${result.mutations}`)
    assert.match(combined(result), /JIT_TARGET_CONFIRMATION_REQUIRED/)
    assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
  })

  assert.equal(publicChartVersion(), '0.4.18', 'the corrected public package target must be 0.4.18')
})
