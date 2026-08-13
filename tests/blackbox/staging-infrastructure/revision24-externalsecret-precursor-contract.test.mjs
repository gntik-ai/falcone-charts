/**
 * Public black-box contracts for the 0.4.19 revision-24 ExternalSecret
 * precursor. The tests invoke only Helm metadata and the distributed recovery
 * CLI against process-isolated public-tool fixtures.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'
import {
  revision24ExternalSecretPrecursorContract,
  runRevision24ExternalSecretPrecursorRecovery,
} from '../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs'

function publicChartVersion() {
  const result = run('helm', ['show', 'chart', umbrellaChart])
  assertSuccess(result, 'helm show chart charts/in-falcone')
  const documents = yamlDocuments(result.stdout)
  assert.equal(documents.length, 1, 'public chart metadata must be one YAML document')
  return documents[0].version
}

function publicTarget() {
  const version = publicChartVersion()
  return {
    version,
    packageDigest: version ===
      revision24ExternalSecretPrecursorContract.publishedButUnappliedVersion
      ? revision24ExternalSecretPrecursorContract.publishedButUnappliedDigest
      : revision24ExternalSecretPrecursorContract.packageDigest,
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

function assertFresh019Job(job, context) {
  assert.ok(job, `${context} did not create a fresh recovery Job`)
  assert.match(job.ref, new RegExp(
    `^${revision24ExternalSecretPrecursorContract.jobPrefix.replaceAll('.', '\\.')}[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$`,
  ))
  assert.equal(
    job.generateName,
    revision24ExternalSecretPrecursorContract.jobPrefix.replace(/^job\.batch\//, ''),
  )
  assert.equal(job.chart, 'in-falcone-0.4.19')
  assert.equal(job.digest, revision24ExternalSecretPrecursorContract.packageDigest)
  assert.equal(job.sourceRevision, revision24ExternalSecretPrecursorContract.sourceRevision)
  assert.equal(job.allowRecoveryRoot, 'true')
}

function assertSecretSafe(result, context) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bget (?:secret|secrets)(?:\s|$)/,
    `${context} read a Kubernetes Secret`,
  )
  assert.doesNotMatch(combined(result), /"client_token"\s*:|(?:^|\s)BAO_TOKEN=\S+/m)
}

function assertNoMutation(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded`)
  assert.equal(result.mutations, '', `${context} mutated:\n${result.mutations}`)
  assert.doesNotMatch(result.trace, /^helm (?:upgrade|rollback)\b/m)
  assert.doesNotMatch(result.trace, /kubectl .*\b(?:apply|create|delete|patch|replace)\b/)
  assertSecretSafe(result, context)
}

function assertExact018Recovery(result, context) {
  assert.equal(
    result.status,
    0,
    `${context} was not recovered:\n${combined(result)}\n${result.trace}`,
  )
  assert.match(result.stdout, /revision24-global-wait-recovery=validated chart=in-falcone-0\.4\.11/)
  assert.match(result.trace, /kubectl .*\bget externalsecrets(?:\.external-secrets\.io)?\b/)
  assert.doesNotMatch(result.trace, /kubectl .*\bpatch clustersecretstore/)
  const jobs = createdAuthJobs(result)
  assert.equal(jobs.length, 1, `${context} must create exactly one fresh auth Job`)
  assertFresh019Job(jobs[0], context)
  const upgrades = traceLines(result).filter((line) => line.startsWith('helm upgrade '))
  assert.equal(upgrades.length, 2, `${context} must complete both recovery upgrades`)
  assert.ok(upgrades.every((line) => /(?:^|\s)--version 0\.4\.19(?:\s|$)/.test(line)))
  assert.doesNotMatch(
    result.trace,
    new RegExp(
      `kubectl .*\\b(?:wait|logs|delete)\\b.*${revision24ExternalSecretPrecursorContract.partialJobRef.replaceAll('.', '\\.')}`,
    ),
  )
  assertSecretSafe(result, context)
}

const blockedCondition = () => ({
  ...revision24ExternalSecretPrecursorContract.externalSecretBlockedCondition,
})
const readyCondition = () => ({
  ...revision24ExternalSecretPrecursorContract.externalSecretReadyCondition,
})

// bbx-repair-staging-079 | fn-revision24-externalsecret-homogeneous-precursor | OpenSpec #### Scenario: Revision-24 recovery admits only homogeneous ExternalSecret states for the exact self-token policy failure
test('r24/0.4.19 admits both complete homogeneous ExternalSecret precursor states', async (t) => {
  const target = publicTarget()
  for (const [name, externalSecretState] of [
    ['stale Ready=True window', 'ready'],
    ['stable SecretSyncedError set', 'auth-blocked'],
  ]) {
    await t.test(name, () => {
      const result = runRevision24ExternalSecretPrecursorRecovery({
        targetVersion: target.version,
        packageDigest: target.packageDigest,
        externalSecretState,
      })
      assertExact018Recovery(result, name)
    })
  }
  assert.equal(publicChartVersion(), '0.4.19', 'the corrected recovery package must be 0.4.19')
})

// bbx-repair-staging-080 | fn-revision24-externalsecret-precursor-drift | OpenSpec #### Scenario: Revision-24 recovery rejects ExternalSecret precursor drift before mutation
test('r24/0.4.19 rejects every ExternalSecret precursor drift before mutation', async (t) => {
  const target = publicTarget()
  const first = revision24ExternalSecretPrecursorContract.externalSecretNames[0]
  const second = revision24ExternalSecretPrecursorContract.externalSecretNames[1]
  const cases = [
    ['13 identities', (fixture) => {
      fixture.externalSecretNames.pop()
    }],
    ['15 identities', (fixture) => {
      fixture.externalSecretNames.push('unexpected-extra-external-secret')
    }],
    ['name drift', (fixture) => {
      fixture.externalSecretNames[0] = 'unexpected-external-secret'
    }],
    ['namespace drift', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {namespace: 'unexpected-namespace'}
    }],
    ['duplicate identity', (fixture) => {
      fixture.externalSecretNames[1] = first
    }],
    ['mixed Ready states', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {conditions: [readyCondition()]}
    }],
    ['reason drift', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {
        conditions: [{...blockedCondition(), reason: 'ProviderError'}],
      }
    }],
    ['message drift', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {
        conditions: [{...blockedCondition(), message: 'provider access denied'}],
      }
    }],
    ['extra condition', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {
        conditions: [blockedCondition(), {
          type: 'Synced',
          status: 'False',
          reason: 'SecretSyncedError',
          message: 'could not get secret data from provider',
        }],
      }
    }],
    ['missing condition', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[first] = {conditions: []}
    }],
    ['second identity namespace drift', (fixture) => {
      fixture.authBlockedStore.externalSecretOverrides[second] = {namespace: 'secret-store'}
    }],
  ]

  for (const [name, mutatePrecursor] of cases) {
    await t.test(name, () => {
      const result = runRevision24ExternalSecretPrecursorRecovery({
        targetVersion: target.version,
        packageDigest: target.packageDigest,
        externalSecretState: 'auth-blocked',
        mutatePrecursor,
      })
      assertNoMutation(result, name)
      assert.match(
        result.trace,
        /kubectl .*\bget externalsecrets(?:\.external-secrets\.io)?\b/,
        `${name} was not rejected from public ExternalSecret evidence`,
      )
      assert.match(combined(result), /LEGACY_CLUSTERSECRETSTORE_EXTERNALSECRET_DRIFT/)
    })
  }

  await t.test('Store drift', () => {
    const result = runRevision24ExternalSecretPrecursorRecovery({
      targetVersion: target.version,
      packageDigest: target.packageDigest,
      externalSecretState: 'auth-blocked',
      mutatePrecursor: (fixture) => {
        fixture.authBlockedStore.store.status.conditions[0].message =
          fixture.authBlockedStore.store.status.conditions[0].message
            .replace('/v1/auth/token/lookup-self', '/v1/auth/token/lookup')
      },
    })
    assertNoMutation(result, 'Store drift')
    assert.match(result.trace, /kubectl .*\bget clustersecretstore/)
    assert.doesNotMatch(result.trace, /kubectl .*\bget externalsecrets/)
    assert.match(combined(result), /LEGACY_CLUSTERSECRETSTORE_HANDOFF_DRIFT/)
  })
})

// bbx-repair-staging-081 | fn-revision24-externalsecret-recovery-target | OpenSpec #### Scenario: Revision-24 recovery targets only the corrected 0.4.19 package
test('r24 rejects all superseded published packages before mutation', async (t) => {
  for (const [name, targetVersion, packageDigest] of [
    [
      'published but unapplied 0.4.15',
      revision24ExternalSecretPrecursorContract.publishedButUnappliedVersion,
      revision24ExternalSecretPrecursorContract.publishedButUnappliedDigest,
    ],
    [
      'published and attempted 0.4.16',
      revision24ExternalSecretPrecursorContract.publishedFailedVersion,
      revision24ExternalSecretPrecursorContract.publishedFailedDigest,
    ],
    [
      'published and attempted 0.4.17',
      revision24ExternalSecretPrecursorContract.publishedFailed017Version,
      revision24ExternalSecretPrecursorContract.publishedFailed017Digest,
    ],
    [
      'published with JIT consumed but no Job created 0.4.18',
      revision24ExternalSecretPrecursorContract.publishedPreCreate018Version,
      revision24ExternalSecretPrecursorContract.publishedPreCreate018Digest,
    ],
  ]) {
    await t.test(name, () => {
      const result = runRevision24ExternalSecretPrecursorRecovery({
        targetVersion,
        packageDigest,
        externalSecretState: 'ready',
      })
      assertNoMutation(result, `${name} target`)
      assert.match(combined(result), /JIT_TARGET_CONFIRMATION_REQUIRED/)
      assert.doesNotMatch(result.trace, /kubectl .*\bcreate\b.*openbao-auth-reconcile/)
    })
  }
})
