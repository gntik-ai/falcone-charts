/**
 * Public black-box contracts for the 0.4.18 revision-24 forced-root repair.
 * The tests use only rendered Helm resources and the distributed recovery CLI.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  makeRevision24FailedRetryJob,
  revision24ForcedRecoveryRootContract,
  runRevision24ForcedRecoveryRoot,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const authReconcileTemplate = 'charts/openbao/templates/openbao-auth-reconcile-job.yaml'
const fakeBin = resolve(
  repoRoot,
  'tests/blackbox/fixtures/staging-infrastructure/fake-bin',
)

function publicChartVersion() {
  const result = run('helm', ['show', 'chart', umbrellaChart])
  assertSuccess(result, 'helm show chart charts/in-falcone')
  const documents = yamlDocuments(result.stdout)
  assert.equal(documents.length, 1, 'public chart metadata must be one YAML document')
  return documents[0].version
}

function renderAuthJob({ allowRecoveryRoot, forceRecoveryRoot }) {
  const args = [
    '--is-upgrade',
    '-f', stagingValues,
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-force-root',
    '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
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
  assert.equal(jobs.length, 1, 'expected one public OpenBao auth reconcile Job')
  return jobs[0]
}

function reconciler(job) {
  const container = job.spec?.template?.spec?.containers?.find(
    (candidate) => candidate.name === 'auth-metadata-reconciler',
  )
  assert.ok(container, 'rendered Job lacks its public reconciler container')
  return container
}

function runRenderedReconciler(script) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-force-root-bbx-'))
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
  writeFileSync(resolve(platform, 'platform.hcl'), 'path "auth/token/lookup-self" {}\n')
  writeFileSync(resolve(authReconcile, 'auth-reconcile.hcl'), 'path "auth/kubernetes/config" {}\n')
  const log = resolve(work, 'bao.log')
  const executable = script
    .replaceAll('/var/run/secrets/kubernetes.io/serviceaccount/token', resolve(serviceAccount, 'token'))
    .replaceAll('/canary/token', resolve(canary, 'token'))
    .replaceAll('/openbao/tls/ca.crt', resolve(tls, 'ca.crt'))
    .replaceAll('/openbao-recovery/root-token', resolve(recovery, 'root-token'))
    .replaceAll('/openbao-platform/platform.hcl', resolve(platform, 'platform.hcl'))
    .replaceAll(
      '/openbao-auth-reconcile/auth-reconcile.hcl',
      resolve(authReconcile, 'auth-reconcile.hcl'),
    )
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
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return {
    result,
    calls,
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
  assert.ok(job, `${context} did not create a fresh recovery Job`)
  assert.match(job.ref, new RegExp(
    `^${revision24ForcedRecoveryRootContract.jobPrefix.replaceAll('.', '\\.')}[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`,
  ))
  assert.equal(
    job.generateName,
    revision24ForcedRecoveryRootContract.jobPrefix.replace(/^job\.batch\//, ''),
  )
  assert.equal(job.chart, 'in-falcone-0.4.18')
  assert.equal(job.digest, revision24ForcedRecoveryRootContract.packageDigest)
  assert.equal(job.sourceRevision, '24')
  assert.equal(job.allowRecoveryRoot, 'true')
}

function assertSecretSafe(result, context) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bget (?:secret|secrets)(?:\s|$)/,
    `${context} read a Kubernetes Secret`,
  )
  assert.doesNotMatch(combined(result), /synthetic-recovery-root|"client_token"\s*:|BAO_TOKEN=\S+/)
}

function assertFailClosedBeforeHelm(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded`)
  assert.match(combined(result), /FORWARD_RECOVERY_REQUIRED/)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m, `${context} reached Helm`)
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\b(?:patch|wait)\b.*(?:clustersecretstore|externalsecret)/,
    `${context} reached ESO handoff/readiness`,
  )
  assertSecretSafe(result, context)
}

function assertRetainedHistoryRejectedBeforeMutation(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded`)
  assert.equal(result.mutations, '', `${context} mutated:\n${result.mutations}`)
  assert.match(combined(result), /REVISION24_AUTH_RECONCILE_HISTORY_DRIFT/)
  assert.match(
    result.trace,
    /^kubectl -n secret-store get jobs\.batch -o json$/m,
    `${context} was not rejected from the public retained-Job inventory`,
  )
  assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m)
  assertSecretSafe(result, context)
}

// bbx-repair-staging-082 | fn-revision24-force-recovery-root | OpenSpec #### Scenario: Revision-24 recovery forces recovery-root authentication before the pre-handoff canary
test('isolated r24 recovery forces root even when the dedicated login would succeed', () => {
  const job = renderAuthJob({ allowRecoveryRoot: true, forceRecoveryRoot: true })
  const podSpec = job.spec?.template?.spec
  const container = reconciler(job)
  const script = (container.args ?? []).join('\n')
  assert.equal(publicChartVersion(), '0.4.18', 'the corrected public package must be 0.4.18')
  assert.match(script, /force_recovery_root=(?:"true"|true)/)
  assert.ok(
    podSpec?.volumes?.some((volume) => volume.secret?.secretName === 'openbao-recovery'),
    'forced recovery render must mount the recovery Secret',
  )

  const invocation = runRenderedReconciler(script)
  try {
    assert.equal(
      invocation.result.status,
      0,
      `forced-root reconciler failed:\n${combined(invocation.result)}\n${invocation.calls.join('\n')}`,
    )
    assert.match(invocation.result.stdout, /^auth_source=recovery_root result=accepted$/m)
    assert.match(
      invocation.result.stdout,
      /^result=(?:changed|unchanged) code=AUTH_METADATA_(?:CONVERGED|MATCHED) canary=passed$/m,
    )
    assert.equal(
      invocation.calls.some((line) =>
        /auth\/kubernetes\/login.*role=openbao-auth-reconcile-role/.test(line)
      ),
      false,
      'forced-root recovery must not attempt the dedicated login as its effective source',
    )
    const platformWrite = invocation.calls.findIndex((line) => /^policy write platform\b/.test(line))
    const esoRole = invocation.calls.findIndex((line) =>
      /write auth\/kubernetes\/role\/eso-role\b/.test(line)
    )
    const canary = invocation.calls.findIndex((line) =>
      /write -format=json auth\/kubernetes\/login.*role=eso-role/.test(line)
    )
    assert.ok(platformWrite !== -1, 'forced-root recovery did not write platform policy')
    assert.ok(esoRole === -1 || platformWrite < esoRole, 'platform policy followed the ESO role write')
    assert.ok(canary !== -1 && platformWrite < canary, 'platform policy followed the canary login')
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-083 | fn-openbao-routine-dedicated-auth | OpenSpec #### Scenario: Routine OpenBao reconciliation remains dedicated-only and cannot write policies
test('routine auth reconciliation stays dedicated-only and normal upgrades never force root', () => {
  const job = renderAuthJob({ allowRecoveryRoot: false, forceRecoveryRoot: false })
  const podSpec = job.spec?.template?.spec
  const script = (reconciler(job).args ?? []).join('\n')
  assert.match(script, /role=openbao-auth-reconcile-role/)
  assert.doesNotMatch(script, /force_recovery_root=(?:"true"|true)/)
  assert.doesNotMatch(script, /auth_source=recovery_root result=accepted/)
  assert.doesNotMatch(script, /bao policy write/)
  assert.equal(
    podSpec?.volumes?.some((volume) => volume.secret?.secretName === 'openbao-recovery'),
    false,
    'routine Job mounted the recovery Secret',
  )
  assert.equal(
    reconciler(job).volumeMounts?.some((mount) => mount.mountPath === '/openbao-recovery'),
    false,
    'routine Job mounted recovery credentials',
  )
})

// bbx-repair-staging-084 | fn-revision24-forced-root-job-evidence | OpenSpec #### Scenario: Revision-24 recovery binds forced-root evidence to a fresh 0.4.18 Job
test('r24 binds forced-root evidence to one fresh 0.4.18 Job and fails closed on bad evidence', async (t) => {
  await t.test('exact marker and terminal success complete recovery', () => {
    const result = runRevision24ForcedRecoveryRoot()
    assert.equal(result.status, 0, `exact forced-root recovery failed:\n${combined(result)}\n${result.trace}`)
    const jobs = createdAuthJobs(result)
    assert.equal(jobs.length, 1)
    assertFresh018Job(jobs[0], 'exact forced-root recovery')
    const renderCalls = traceLines(result).filter((line) =>
      /^helm template\b/.test(line) && /openbao-auth-reconcile-job\.yaml/.test(line)
    )
    assert.equal(renderCalls.length, 1)
    assert.match(renderCalls[0], /openbao\.openbao\.authReconcile\.allowRecoveryRoot=true/)
    assert.match(renderCalls[0], /openbao\.openbao\.authReconcile\.forceRecoveryRoot=true/)
    assertSecretSafe(result, 'exact forced-root recovery')
  })

  for (const [name, options] of [
    ['missing forced-root marker', {
      preflightLog: 'result=changed code=AUTH_METADATA_CONVERGED canary=passed',
    }],
    ['dedicated marker', {
      preflightLog: 'auth_source=dedicated result=accepted\n' +
        'result=changed code=AUTH_METADATA_CONVERGED canary=passed',
    }],
    ['Job timeout', { waitFailures: 1 }],
  ]) {
    await t.test(name, () => {
      const result = runRevision24ForcedRecoveryRoot(options)
      assertFailClosedBeforeHelm(result, name)
    })
  }
})

// bbx-repair-staging-085 | fn-revision24-retained-auth-failure-chain | OpenSpec #### Scenario: Revision-24 recovery admits only the exact retained 0.4.14, 0.4.16, and 0.4.17 failure chain
test('r24 preserves the retained failed Jobs and targets only 0.4.18', async (t) => {
  await t.test('exact retained 0.4.14, 0.4.16, and 0.4.17 failure chain creates a new identity', () => {
    const result = runRevision24ForcedRecoveryRoot()
    assert.equal(result.status, 0, `exact retained chain failed:\n${combined(result)}\n${result.trace}`)
    const [fresh] = createdAuthJobs(result)
    assertFresh018Job(fresh, 'retained failure chain')
    const lines = traceLines(result)
    const historyRead = lines.findIndex((line) =>
      line === 'kubectl -n secret-store get jobs.batch -o json'
    )
    const create = lines.findIndex((line) =>
      /kubectl -n secret-store create -f \S+ -o name(?:\s|$)/.test(line)
    )
    assert.ok(historyRead !== -1, 'recovery did not inventory retained Jobs through kubectl')
    assert.ok(create > historyRead, 'recovery created a Job before validating retained history')
    for (const retained of [
      revision24ForcedRecoveryRootContract.publishedPartial014JobRef,
      revision24ForcedRecoveryRootContract.publishedFailed016JobRef,
      revision24ForcedRecoveryRootContract.publishedFailed017JobRef,
    ]) {
      assert.notEqual(fresh.ref, retained)
      assert.doesNotMatch(
        result.trace,
        new RegExp(
          `kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${retained.replaceAll('.', '\\.')}\\b`,
        ),
        `recovery reused or mutated retained evidence ${retained}`,
      )
    }
    assert.match(result.stdout, /revision24-global-wait-recovery=validated chart=in-falcone-0\.4\.11/)
    assert.doesNotMatch(result.trace, /kubectl .*\bpatch clustersecretstore/)
    assert.match(result.trace, /kubectl .*\bget externalsecrets(?:\.external-secrets\.io)?\b/)
    const upgrades = traceLines(result).filter((line) => line.startsWith('helm upgrade '))
    assert.equal(upgrades.length, 2)
    assert.ok(upgrades.every((line) => /(?:^|\s)--version 0\.4\.18(?:\s|$)/.test(line)))
  })

  await t.test('exact prior 0.4.18 failures remain evidence while a fresh identity runs', () => {
    const priorJobs = [
      makeRevision24FailedRetryJob({
        suffix: 'prior1',
        uid: '00000000-0000-4000-8000-000000000117',
      }),
      makeRevision24FailedRetryJob({
        suffix: 'prior2',
        uid: '00000000-0000-4000-8000-000000000217',
      }),
    ]
    const result = runRevision24ForcedRecoveryRoot({
      mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(
        ...structuredClone(priorJobs),
      ),
    })
    assert.equal(
      result.status,
      0,
      `exact prior 0.4.18 failures were rejected:\n${combined(result)}\n${result.trace}`,
    )
    const [fresh] = createdAuthJobs(result)
    assertFresh018Job(fresh, 'retry-safe retained chain')
    for (const prior of priorJobs) {
      assert.notEqual(fresh.ref, prior.ref, `fresh recovery reused ${prior.ref}`)
      assert.doesNotMatch(
        result.trace,
        new RegExp(
          `kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${prior.ref.replaceAll('.', '\\.')}\\b`,
        ),
        `recovery reused or mutated prior 0.4.18 evidence ${prior.ref}`,
      )
    }
  })

  const historyDrifts = [
    ['one retained Job', (fixture) => {
      fixture.authRecovery.staleJobs.pop()
    }],
    ['unrecognized third retained Job', (fixture) => {
      const extra = structuredClone(fixture.authRecovery.staleJobs[0])
      extra.ref = 'job.batch/openbao-auth-reconcile-r24-unexpected-extra'
      extra.object.metadata.name = 'openbao-auth-reconcile-r24-unexpected-extra'
      extra.object.metadata.uid = '11111111-2222-4333-8444-555555555555'
      fixture.authRecovery.staleJobs.push(extra)
    }],
    ['0.4.14 UID', (fixture) => {
      fixture.authRecovery.staleJobs[0].object.metadata.uid =
        '11111111-2222-4333-8444-555555555555'
    }],
    ['0.4.14 package digest', (fixture) => {
      fixture.authRecovery.staleJobs[0].object.metadata.annotations[
        'in-falcone.io/recovery-package-digest'
      ] = `sha256:${'dead'.repeat(16)}`
    }],
    ['0.4.16 target chart', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.metadata.annotations[
        'in-falcone.io/recovery-target-chart'
      ] = 'in-falcone-0.4.15'
    }],
    ['0.4.16 failed count', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.failed = 2
    }],
    ['0.4.16 missing terminal condition', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.conditions.pop()
    }],
    ['0.4.16 extra terminal condition', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.conditions.push({
        type: 'Complete',
        status: 'False',
        reason: 'BackoffLimitExceeded',
      })
    }],
    ['0.4.16 condition type', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.conditions[0].type =
        'FailurePending'
    }],
    ['0.4.16 condition reason', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.conditions[0].reason =
        'DeadlineExceeded'
    }],
    ['0.4.16 condition status', (fixture) => {
      fixture.authRecovery.staleJobs[1].object.status.conditions[1].status = 'False'
    }],
    ['0.4.18 bad name suffix', (fixture) => {
      fixture.authRecovery.staleJobs.push(makeRevision24FailedRetryJob({suffix: 'bad_suffix'}))
    }],
    ['0.4.18 missing UID', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      delete retry.object.metadata.uid
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 invalid UID', (fixture) => {
      fixture.authRecovery.staleJobs.push(makeRevision24FailedRetryJob({uid: 'not-a-uuid'}))
    }],
    ['0.4.18 duplicate UID', (fixture) => {
      fixture.authRecovery.staleJobs.push(makeRevision24FailedRetryJob({
        uid: fixture.authRecovery.staleJobs[1].object.metadata.uid,
      }))
    }],
    ['0.4.18 package digest', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      retry.object.metadata.annotations['in-falcone.io/recovery-package-digest'] =
        `sha256:${'dead'.repeat(16)}`
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 target chart', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      retry.object.metadata.annotations['in-falcone.io/recovery-target-chart'] =
        'in-falcone-0.4.17'
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 missing hook annotation', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      delete retry.object.metadata.annotations['helm.sh/hook-weight']
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 failed count', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      retry.object.status.failed = 2
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 terminal conditions', (fixture) => {
      const retry = makeRevision24FailedRetryJob()
      retry.object.status.conditions[0].type = 'FailurePending'
      fixture.authRecovery.staleJobs.push(retry)
    }],
    ['0.4.18 duplicate name', (fixture) => {
      fixture.authRecovery.staleJobs.push(
        makeRevision24FailedRetryJob({
          suffix: 'duplicate1',
          uid: '00000000-0000-4000-8000-000000000317',
        }),
        makeRevision24FailedRetryJob({
          suffix: 'duplicate1',
          uid: '00000000-0000-4000-8000-000000000417',
        }),
      )
    }],
  ]
  for (const [name, mutatePrecursor] of historyDrifts) {
    await t.test(`rejects ${name} drift before mutation`, () => {
      const result = runRevision24ForcedRecoveryRoot({ mutatePrecursor })
      assertRetainedHistoryRejectedBeforeMutation(result, name)
    })
  }

  await t.test('published 0.4.16 is rejected before mutation', () => {
    const result = runRevision24ForcedRecoveryRoot({
      targetVersion: revision24ForcedRecoveryRootContract.publishedFailed016Version,
      packageDigest: `sha256:${'0416'.repeat(16)}`,
    })
    assert.notEqual(result.status, 0, '0.4.16 unexpectedly remained an accepted target')
    assert.equal(result.mutations, '', `0.4.16 target mutated:\n${result.mutations}`)
    assert.match(combined(result), /JIT_TARGET_CONFIRMATION_REQUIRED/)
    assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
    assertSecretSafe(result, 'published 0.4.16 target')
  })

  await t.test('published failed 0.4.17 is rejected before mutation', () => {
    const result = runRevision24ForcedRecoveryRoot({
      targetVersion: revision24ForcedRecoveryRootContract.publishedFailed017Version,
      packageDigest:
        'sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328',
    })
    assert.notEqual(result.status, 0, '0.4.17 unexpectedly remained an accepted target')
    assert.equal(result.mutations, '', `0.4.17 target mutated:\n${result.mutations}`)
    assert.match(combined(result), /JIT_TARGET_CONFIRMATION_REQUIRED/)
    assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
    assertSecretSafe(result, 'published failed 0.4.17 target')
  })
})
