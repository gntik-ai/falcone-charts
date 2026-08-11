import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'

import {
  repoRoot,
  render,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'
import {
  revision24AuthRecoveryContract,
  runRevision24AuthRecovery,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

const stagingValues = resolve(repoRoot, 'charts/in-falcone/values/staging.yaml')
const authReconcileTemplate = 'charts/openbao/templates/openbao-auth-reconcile-job.yaml'
const authSuccessPattern = /result=(changed|unchanged) code=AUTH_METADATA_(CONVERGED|MATCHED) canary=passed/

function traceLines(result) {
  return result.trace.split('\n').filter(Boolean)
}

function matchingIndexes(lines, predicate) {
  return lines.flatMap((line, index) => predicate(line) ? [index] : [])
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function createdAuthJobs(lines) {
  return lines.flatMap((line, index) => {
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

function assertMaterializedAuthJob(creation, context) {
  assert.ok(creation, `${context} did not materialize an auth Job`)
  assert.ok(
    creation.ref.startsWith(revision24AuthRecoveryContract.jobPrefix) &&
      /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(
        creation.ref.slice(revision24AuthRecoveryContract.jobPrefix.length),
      ),
    `${context} returned an invalid generated Job ref: ${creation.ref}`,
  )
  assert.equal(
    creation.generateName,
    revision24AuthRecoveryContract.jobPrefix.replace(/^job\.batch\//, ''),
  )
  assert.equal(creation.chart, 'in-falcone-0.4.15')
  assert.equal(creation.digest, revision24AuthRecoveryContract.packageDigest)
  assert.equal(creation.sourceRevision, revision24AuthRecoveryContract.sourceRevision)
  assert.equal(creation.allowRecoveryRoot, 'true')
}

function assertFreshAuthExecution(lines, context, {expectLog = true} = {}) {
  const creations = createdAuthJobs(lines)
  assert.equal(creations.length, 1, `${context} must create exactly one fresh auth Job`)
  const creation = creations[0]
  assertMaterializedAuthJob(creation, context)

  const rawCreateIndex = lines.findIndex((line, index) =>
    index < creation.index &&
    /kubectl (?:-n|--namespace) secret-store create -f \S+ -o name(?:\s|$)/.test(line)
  )
  assert.ok(rawCreateIndex !== -1, `${context} must use kubectl create -f ... -o name`)
  assert.doesNotMatch(
    lines.slice(rawCreateIndex, creation.index + 1).join('\n'),
    /kubectl .*\b(?:apply|delete)\b.*openbao-auth-reconcile/,
    `${context} must neither apply nor delete an auth Job`,
  )

  const waitIndex = lines.findIndex((line, index) =>
    index > creation.index &&
    line.includes(creation.ref) &&
    /kubectl .*\bwait\b/.test(line) &&
    /--for=condition=(?:Complete|complete)(?:\s|$)/.test(line) &&
    /(?:^|\s)--timeout(?:=|\s+)5m(?:\s|$)/.test(line)
  )
  assert.ok(waitIndex !== -1, `${context} must wait five minutes on only ${creation.ref}`)
  const logIndex = lines.findIndex((line, index) =>
    index > waitIndex && line.includes(creation.ref) && /kubectl .*\blogs\b/.test(line)
  )
  if (expectLog) {
    assert.ok(logIndex !== -1, `${context} must read only the newly created Job log`)
  } else {
    assert.equal(logIndex, -1, `${context} must not read a Job log after incomplete wait`)
  }
  return {...creation, rawCreateIndex, waitIndex, logIndex}
}

function assertSecretSafe(result, context) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bget (?:secret|secrets)(?:\s|$)/,
    `${context} must not read Kubernetes Secret resources`,
  )
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.doesNotMatch(output, /"client_token"\s*:/, `${context} printed an OpenBao client token`)
  assert.doesNotMatch(output, /(?:^|\s)BAO_TOKEN=\S+/m, `${context} printed BAO_TOKEN`)
  assert.doesNotMatch(
    output,
    /eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}/,
    `${context} printed a JWT-like credential`,
  )
}

function assertRecoveryRootOnlyForAuthJob(lines, executionIndex, context) {
  const rootIndexes = matchingIndexes(
    lines,
    (line) => line.startsWith('helm ') &&
      line.includes('openbao.openbao.authReconcile.allowRecoveryRoot=true'),
  )
  assert.equal(
    rootIndexes.length,
    1,
    `${context} must enable allowRecoveryRoot in exactly one Helm materialization call`,
  )
  const rootCall = lines[rootIndexes[0]]
  assert.match(rootCall, /^helm template\b/)
  assert.match(rootCall, /(?:^|\s)--version 0\.4\.15(?:\s|$)/)
  assert.ok(rootIndexes[0] < executionIndex, `${context} must render before executing the recovery Job`)

  for (const line of lines.filter((candidate) => /^helm (?:diff |upgrade )/.test(candidate))) {
    assert.doesNotMatch(
      line,
      /openbao\.openbao\.authReconcile\.allowRecoveryRoot=true/,
      `${context} leaked recovery-root authorization into ${line}`,
    )
  }
}

function assertNoEsoOrHelmProgressAfterAuthFailure(result, context) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bpatch clustersecretstores?(?:\.external-secrets\.io)?\b/,
    `${context} reached the ClusterSecretStore handoff`,
  )
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bwait\b.*(?:clustersecretstore|externalsecret)/,
    `${context} reached ESO readiness waits`,
  )
  assert.doesNotMatch(result.trace, /^helm upgrade\b/m, `${context} reached Helm upgrade`)
  assert.equal(
    result.mutations.split('\n').filter((line) => /clustersecretstore|externalsecret|helm upgrade/.test(line)).length,
    0,
    `${context} performed a downstream ESO or Helm mutation`,
  )
  assertSecretSafe(result, context)
}

function assertCreateFailureBoundary(result, context, code, {materialized}) {
  assert.notEqual(result.status, 0, `${context} unexpectedly continued:\n${result.trace}`)
  assert.match(combinedOutput(result), new RegExp(`REVISION24_AUTH_RECONCILE_${code}`))
  assert.match(combinedOutput(result), /FORWARD_RECOVERY_REQUIRED/)
  assert.doesNotMatch(result.trace, /kubectl .*\bwait\b.*openbao-auth-reconcile-r24-/)
  assert.doesNotMatch(result.trace, /kubectl .*\blogs\b.*openbao-auth-reconcile-r24-/)
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bpatch clustersecretstores?(?:\.external-secrets\.io)?\b/,
    `${context} reached the ClusterSecretStore handoff`,
  )
  assert.doesNotMatch(result.trace, /kubectl .*\bwait\b.*(?:clustersecretstore|externalsecret)/)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m)
  assert.doesNotMatch(result.trace, /kubectl .*\bdelete\b.*openbao-auth-reconcile-r24-/)
  const creations = createdAuthJobs(traceLines(result))
  assert.equal(creations.length, materialized ? 1 : 0)
  const mutations = result.mutations.split('\n').filter(Boolean)
  assert.equal(mutations.length, materialized ? 1 : 0)
  if (materialized) {
    assert.equal(mutations[0], traceLines(result)[creations[0].index])
  }
  assertNoEsoOrHelmProgressAfterAuthFailure(result, context)
  return creations[0]
}

function assertReachabilityFailureBoundary(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly continued:\n${result.trace}`)
  assert.match(combinedOutput(result), /FORWARD_RECOVERY_REQUIRED/)
  const lines = traceLines(result)
  const auth = assertFreshAuthExecution(lines, context)
  const storePatches = matchingIndexes(
    lines,
    (line) => /kubectl .*\bpatch clustersecretstores?(?:\.external-secrets\.io)? openbao-backend\b/.test(line),
  )
  assert.equal(storePatches.length, 1, `${context} must reach exactly one guarded store CAS handoff`)
  assert.ok(auth.logIndex < storePatches[0], `${context} must complete auth before store CAS`)
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bpatch externalsecret(?:s)?(?:\.external-secrets\.io)?\b/,
    `${context} must not patch ExternalSecret owner metadata`,
  )
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m, `${context} reached Helm`)
  const forbiddenAdminMutations = result.mutations.split('\n').filter((line) =>
    /^kubectl .*\b(?:apply|create|delete|patch|replace|scale|set)\b/.test(line) &&
    (
      /(?:^|\s)(?:-n|--namespace) external-secrets(?:\s|$)/.test(line) ||
      /\bnamespace(?:s)?(?:\/|\s+)external-secrets\b/.test(line) ||
      /\b(?:deployment|serviceaccount|service)(?:\.apps)?(?:\/|\s+)external-secrets(?:\s|$)/.test(line) ||
      /\bnetworkpolic(?:y|ies)(?:\.networking\.k8s\.io)?\b/.test(line)
    )
  )
  assert.deepEqual(
    forbiddenAdminMutations,
    [],
    `${context} mutated administrator-owned ESO/network state`,
  )
  assertSecretSafe(result, context)
  return {auth, lines, storePatchIndex: storePatches[0]}
}

// bbx-repair-staging-061 | fn-openbao-eso-token-policy-metadata | OpenSpec #### Scenario: Auth reconcile excludes the default policy from ESO tokens
test('rendered auth reconcile excludes default and validates exactly the four ESO policies', () => {
  const { objects } = render(umbrellaChart, [
    '-f', stagingValues,
    '--set', 'openbao.openbao.authReconcile.allowRecoveryRoot=true',
    '--show-only', authReconcileTemplate,
  ])
  const jobs = objects.filter((object) =>
    object?.apiVersion === 'batch/v1' &&
    object?.kind === 'Job' &&
    object?.metadata?.name === 'openbao-auth-reconcile'
  )
  assert.equal(jobs.length, 1, 'the public chart must render exactly one auth reconcile Job')
  const reconciler = jobs[0].spec?.template?.spec?.containers?.find(
    (container) => container.name === 'auth-metadata-reconciler',
  )
  assert.ok(reconciler, 'the auth reconcile Job must expose its reconciler container')
  const script = (reconciler.args ?? []).join('\n')

  assert.match(script, /desired_token_no_default_policy="true"/)
  assert.doesNotMatch(script, /desired_token_no_default_policy="false"/)
  assert.match(script, /desired_policies="functions,gateway,iam,platform"/)
  assert.match(
    script,
    /\[ "\$\(normalize_list "\$\(field token_policies "auth\/kubernetes\/role\/\$role"\)"\)" = "\$desired_policies" \] \|\| fail ROLE_VERIFY_FAILED/,
    'the durable role verification must require exact normalized policy equality',
  )
  assert.match(
    script,
    /\[ "\$lookup_policies" = "\$desired_policies" \][\s\\]+&& \[ "\$lookup_ttl" -gt 0 \]/,
    'the canary lookup must require exact normalized equality with only the four desired policies',
  )
})

// bbx-repair-staging-062 | fn-revision24-auth-recovery-preflight | OpenSpec #### Scenario: Revision-24 recovery reconciles OpenBao auth before ESO handoff
test('exact r24 recovery runs the attested 0.4.15 auth Job before CAS handoff and preserves both health gates', () => {
  const result = runRevision24AuthRecovery()
  assert.equal(
    result.status,
    0,
    `exact 0.4.15 auth-first recovery failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\ntrace:\n${result.trace}`,
  )
  assert.match(result.stdout, /revision24-global-wait-recovery=validated/)
  assert.match(result.stdout, /chart=in-falcone-0\.4\.15/)

  const lines = traceLines(result)
  const authExecution = assertFreshAuthExecution(lines, 'exact r24 recovery')
  const patchIndex = lines.findIndex((line) => /kubectl .*\bpatch clustersecretstore\b/.test(line))
  assert.ok(authExecution.logIndex < patchIndex, 'exact auth success evidence must precede the store handoff')
  assertRecoveryRootOnlyForAuthJob(lines, authExecution.index, 'exact r24 recovery')
  const preHandoffJobCalls = lines.slice(authExecution.index + 1, patchIndex).filter((line) =>
    /kubectl .*\b(?:wait|logs|apply|delete)\b.*openbao-auth-reconcile/.test(line)
  )
  assert.ok(
    preHandoffJobCalls.every((line) => line.includes(authExecution.ref)),
    `pre-handoff wait/log must target only ${authExecution.ref}:\n${preHandoffJobCalls.join('\n')}`,
  )
  assert.doesNotMatch(result.trace, new RegExp(revision24AuthRecoveryContract.staleJobRef.replaceAll('.', '\\.')))

  const patch = lines[patchIndex]
  assert.match(patch, /(?:^|\s)--type(?:=|\s+)json(?:\s|$)/)
  assert.match(patch, /\/metadata\/uid/)
  assert.match(patch, /\/metadata\/resourceVersion/)
  assert.match(patch, /helm\.sh~1hook/)
  assert.match(patch, /eso-system/)

  const storeReadyIndex = lines.findIndex((line) =>
    /kubectl .*\bwait\b.*clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(line),
  )
  assert.ok(patchIndex < storeReadyIndex, 'store Ready must follow the guarded handoff')
  const upgrades = matchingIndexes(lines, (line) => line.startsWith('helm upgrade '))
  assert.equal(upgrades.length, 2, 'r24 recovery must retain exactly two Helm upgrades')
  assert.ok(storeReadyIndex < upgrades[0], 'store Ready must precede the first upgrade')

  for (const name of revision24AuthRecoveryContract.externalSecretNames) {
    const readyIndex = lines.findIndex((line, index) =>
      index > storeReadyIndex &&
      index < upgrades[0] &&
      /kubectl .*\bwait\b.*externalsecret/.test(line) &&
      line.includes(name),
    )
    assert.ok(readyIndex !== -1, `ExternalSecret ${name} must be waited Ready before Helm`)
  }

  for (const upgradeIndex of upgrades) {
    assert.match(lines[upgradeIndex], /(?:^|\s)--version 0\.4\.15(?:\s|$)/)
    assert.doesNotMatch(lines[upgradeIndex], /(?:^|\s)--wait(?:\s|$)/)
    assert.doesNotMatch(lines[upgradeIndex], /allowRecoveryRoot=true/)
  }
  const healthLogIndexes = matchingIndexes(
    lines,
    (line) => /kubectl .*\blogs job\/openbao-auth-reconcile(?:\s|$)/.test(line),
  )
  assert.equal(healthLogIndexes.length, 2, 'both post-upgrade health gates must retain routine auth evidence')
  assert.ok(upgrades[0] < healthLogIndexes[0] && healthLogIndexes[0] < upgrades[1], 'first health gate must finish between upgrades')
  assert.ok(upgrades[1] < healthLogIndexes[1], 'second health gate must finish after the second upgrade')
  assert.equal(
    lines.some((line) =>
      /kubectl .*\b(?:wait|rollout status)\b/.test(line) &&
      line.includes(revision24AuthRecoveryContract.vectorResource)
    ),
    false,
    'recovery must not globally wait for the intentionally Pending vector workload',
  )
  assertSecretSafe(result, 'exact r24 recovery')
})

// bbx-repair-staging-063 | fn-revision24-auth-recovery-completion-gate | OpenSpec #### Scenario: Revision-24 recovery fails closed when auth reconciliation does not complete
test('r24 recovery stops before store, ExternalSecrets, and Helm when the auth Job fails', () => {
  const result = runRevision24AuthRecovery({waitFails: true})
  assert.notEqual(result.status, 0, `failed auth Job unexpectedly continued:\n${result.trace}`)
  const lines = traceLines(result)
  const execution = assertFreshAuthExecution(lines, 'failed auth Job recovery', {expectLog: false})
  assertRecoveryRootOnlyForAuthJob(lines, execution.index, 'failed auth Job recovery')
  assert.match(combinedOutput(result), /REVISION24_AUTH_RECONCILE_INCOMPLETE/)
  assert.match(combinedOutput(result), /FORWARD_RECOVERY_REQUIRED/)
  assert.doesNotMatch(result.trace, new RegExp(revision24AuthRecoveryContract.staleJobRef.replaceAll('.', '\\.')))
  assert.doesNotMatch(result.trace, new RegExp(`kubectl .*\\bdelete\\b.*${execution.ref.replaceAll('.', '\\.')}`))
  assertNoEsoOrHelmProgressAfterAuthFailure(result, 'failed auth Job recovery')
})

// bbx-repair-staging-068 | fn-revision24-auth-recovery-create-gate | OpenSpec #### Scenario: Revision-24 recovery fails closed when auth reconciliation does not complete
test('r24 recovery fails closed when the fresh auth Job cannot be created', () => {
  const result = runRevision24AuthRecovery({createMode: 'fail'})
  assertCreateFailureBoundary(result, 'auth Job create failure', 'CREATE_FAILED', {materialized: false})
  assert.match(result.trace, /kubectl (?:-n|--namespace) secret-store create -f \S+ -o name(?:\s|$)/)
  assert.doesNotMatch(result.trace, /^kubectl create auth-reconcile-job ref=/m)
})

// bbx-repair-staging-069 | fn-revision24-auth-recovery-create-ref-gate | OpenSpec #### Scenario: Revision-24 recovery fails closed when auth reconciliation does not complete
test('r24 recovery retains the created Job but rejects a wrong-prefix returned ref', () => {
  const result = runRevision24AuthRecovery({createMode: 'wrong-prefix'})
  const created = assertCreateFailureBoundary(
    result,
    'wrong-prefix auth Job ref',
    'CREATE_REF_DRIFT',
    {materialized: true},
  )
  assertMaterializedAuthJob(created, 'wrong-prefix auth Job ref')
  assert.match(
    result.trace,
    /^kubectl create auth-reconcile-output lineCount=1 value=job\.batch\/openbao-auth-reconcile-unbound-/m,
  )
  assert.doesNotMatch(result.trace, new RegExp(`kubectl .*\\b(?:wait|logs)\\b.*${created.ref.replaceAll('.', '\\.')}`))
})

// bbx-repair-staging-070 | fn-revision24-auth-recovery-create-ref-gate | OpenSpec #### Scenario: Revision-24 recovery fails closed when auth reconciliation does not complete
test('r24 recovery retains the created Job but rejects multiple returned refs', () => {
  const result = runRevision24AuthRecovery({createMode: 'multiple'})
  const created = assertCreateFailureBoundary(
    result,
    'multiple auth Job refs',
    'CREATE_REF_DRIFT',
    {materialized: true},
  )
  assertMaterializedAuthJob(created, 'multiple auth Job refs')
  assert.match(
    result.trace,
    new RegExp(`^kubectl create auth-reconcile-output lineCount=2 values=${created.ref.replaceAll('.', '\\.')}[^\\n]*$`, 'm'),
  )
  assert.doesNotMatch(result.trace, new RegExp(`kubectl .*\\b(?:wait|logs)\\b.*${created.ref.replaceAll('.', '\\.')}`))
})

// bbx-repair-staging-064 | fn-revision24-auth-recovery-log-gate | OpenSpec #### Scenario: Revision-24 recovery requires exact auth reconciliation evidence
test('r24 recovery stops before store, ExternalSecrets, and Helm when auth success evidence is inexact', () => {
  const result = runRevision24AuthRecovery({
    preflightLog: 'result=changed code=AUTH_METADATA_CONVERGED canary=failed',
  })
  assert.notEqual(result.status, 0, `inexact auth evidence unexpectedly continued:\n${result.trace}`)
  const lines = traceLines(result)
  const execution = assertFreshAuthExecution(lines, 'inexact auth evidence recovery')
  assert.doesNotMatch(result.stdout, authSuccessPattern)
  assertRecoveryRootOnlyForAuthJob(lines, execution.index, 'inexact auth evidence recovery')
  assert.match(combinedOutput(result), /REVISION24_AUTH_RECONCILE_EVIDENCE_DRIFT/)
  assert.match(combinedOutput(result), /FORWARD_RECOVERY_REQUIRED/)
  assert.doesNotMatch(result.trace, new RegExp(revision24AuthRecoveryContract.staleJobRef.replaceAll('.', '\\.')))
  assertNoEsoOrHelmProgressAfterAuthFailure(result, 'inexact auth evidence recovery')
})

// bbx-repair-staging-065 | fn-revision24-auth-recovery-retry-identity | OpenSpec #### Scenario: Revision-24 recovery requires exact auth reconciliation evidence
test('r24 retry retains stale evidence and validates only a newly generated package-bound Job', () => {
  const result = runRevision24AuthRecovery({attemptCount: 2, waitFailures: 1})
  assert.equal(result.attempts.length, 2)
  assert.notEqual(result.attempts[0].status, 0, 'the admitted first auth attempt must time out')
  assert.match(combinedOutput(result.attempts[0]), /REVISION24_AUTH_RECONCILE_INCOMPLETE/)
  assert.match(combinedOutput(result.attempts[0]), /FORWARD_RECOVERY_REQUIRED/)
  assert.equal(
    result.attempts[1].status,
    0,
    `retry with a fresh auth Job failed:\n${combinedOutput(result.attempts[1])}\n${result.attempts[1].trace}`,
  )

  const first = assertFreshAuthExecution(
    traceLines(result.attempts[0]),
    'first retained auth attempt',
    {expectLog: false},
  )
  const retry = assertFreshAuthExecution(traceLines(result.attempts[1]), 'retried auth attempt')
  assert.notEqual(first.ref, retry.ref, 'retry must create a new Job identity')
  assert.equal(first.generateName, retry.generateName, 'retry must retain the package-bound generateName')

  const retryTrace = result.attempts[1].trace
  assert.doesNotMatch(retryTrace, new RegExp(first.ref.replaceAll('.', '\\.')), 'retry touched the prior failed Job')
  assert.doesNotMatch(
    result.trace,
    new RegExp(revision24AuthRecoveryContract.staleJobRef.replaceAll('.', '\\.')),
    'recovery touched the stale failed Job retained before both attempts',
  )
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\b(?:apply|delete)\b.*openbao-auth-reconcile-r24-/,
    'recovery reapplied or deleted retained auth Job evidence',
  )
  assertSecretSafe(result, 'r24 auth retry')
})

// bbx-repair-staging-066 | fn-revision24-external-eso-reachability | OpenSpec #### Scenario: External ESO network reachability remains an operator prerequisite
test('r24 stops after auth and store CAS when ClusterSecretStore Ready times out', () => {
  const result = runRevision24AuthRecovery({storeWaitFails: true})
  const boundary = assertReachabilityFailureBoundary(result, 'ClusterSecretStore reachability timeout')
  const storeWaitIndex = boundary.lines.findIndex((line, index) =>
    index > boundary.storePatchIndex &&
    /kubectl .*\bwait\b.*clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(line) &&
    /(?:^|\s)--timeout(?:=|\s+)10m(?:\s|$)/.test(line)
  )
  assert.ok(storeWaitIndex !== -1, 'the store must have its own ten-minute Ready wait')
  assert.equal(
    boundary.lines.slice(storeWaitIndex + 1).some((line) => /kubectl .*\bwait\b.*externalsecret/.test(line)),
    false,
    'store timeout must stop before every ExternalSecret wait',
  )
})

// bbx-repair-staging-067 | fn-revision24-external-eso-reachability | OpenSpec #### Scenario: External ESO network reachability remains an operator prerequisite
test('r24 stops after store Ready when one canonical ExternalSecret times out', () => {
  const failedName = revision24AuthRecoveryContract.externalSecretNames[0]
  const result = runRevision24AuthRecovery({externalSecretWaitFailure: failedName})
  const boundary = assertReachabilityFailureBoundary(result, 'canonical ExternalSecret reachability timeout')
  const storeWaitIndex = boundary.lines.findIndex((line, index) =>
    index > boundary.storePatchIndex &&
    /kubectl .*\bwait\b.*clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(line) &&
    /(?:^|\s)--timeout(?:=|\s+)10m(?:\s|$)/.test(line)
  )
  const externalWaitIndex = boundary.lines.findIndex((line, index) =>
    index > storeWaitIndex &&
    /kubectl .*\bwait\b.*externalsecret/.test(line) &&
    line.includes(failedName) &&
    /(?:^|\s)--timeout(?:=|\s+)10m(?:\s|$)/.test(line)
  )
  assert.ok(storeWaitIndex !== -1, 'store Ready must precede ExternalSecret readiness')
  assert.ok(externalWaitIndex !== -1, `${failedName} must have a separate ten-minute Ready wait`)
  assert.equal(
    boundary.lines.slice(externalWaitIndex + 1).some((line) => /kubectl .*\bwait\b.*externalsecret/.test(line)),
    false,
    'the first ExternalSecret timeout must stop the remaining readiness sequence',
  )
})
