/**
 * Black-box contracts for the revision-20 staging infrastructure repair.
 * These tests inspect only rendered/source metadata and never contact a cluster
 * or read Secret values.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  readYaml,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const upgradeEvidenceArgs = [
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-non-secret-evidence',
]

function render(args = []) {
  const result = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    ...args,
  ])
  assertSuccess(result, `helm template ${args.join(' ')}`)
  return { text: result.stdout, objects: yamlDocuments(result.stdout) }
}

function named(objects, kind, name, namespace) {
  return objects.find((object) => object?.kind === kind
    && object?.metadata?.name === name
    && (namespace === undefined || object?.metadata?.namespace === namespace))
}

test('external ESO uses exact TokenRequest/TokenReview authority without adopting its owner', () => {
  const { objects } = render(['-f', stagingValues])

  assert.ok(!objects.some((object) => object?.metadata?.namespace === 'external-secrets'),
    'Falcone must render no namespaced object in the external operator namespace')

  const requestRole = named(objects, 'Role', 'eso-openbao-token-request', 'eso-system')
  assert.deepEqual(requestRole?.rules, [{
    apiGroups: [''],
    resources: ['serviceaccounts/token'],
    resourceNames: ['eso-openbao-auth'],
    verbs: ['create'],
  }])
  const requestBinding = named(objects, 'RoleBinding', 'eso-openbao-token-request', 'eso-system')
  assert.ok(requestBinding?.subjects?.some((subject) => subject.kind === 'ServiceAccount'
    && subject.name === 'external-secrets' && subject.namespace === 'external-secrets'))

  const reviewRole = named(objects, 'ClusterRole', 'openbao-token-reviewer')
  assert.deepEqual(reviewRole?.rules, [{
    apiGroups: ['authentication.k8s.io'],
    resources: ['tokenreviews'],
    verbs: ['create'],
  }])
  const reviewBinding = named(objects, 'ClusterRoleBinding', 'openbao-token-reviewer')
  assert.deepEqual(reviewBinding?.subjects, [{
    kind: 'ServiceAccount',
    name: 'openbao',
    namespace: 'secret-store',
  }])

  assert.ok(!objects.some((object) => object?.metadata?.name === 'eso-secret-manager'),
    'the identity-only auth ServiceAccount must not receive generic Secret mutation')
})

test('fresh bootstrap is install-only and routine upgrades reconcile auth metadata without KV or policy writes', () => {
  const install = render(['-f', stagingValues])
  assert.ok(named(install.objects, 'Job', 'openbao-init', 'secret-store'),
    'fresh install must retain the complete bootstrap')
  assert.ok(named(install.objects, 'Job', 'openbao-auth-reconcile', 'secret-store'),
    'fresh install must verify the auth metadata after bootstrap')

  const upgrade = render(['--is-upgrade', '-f', stagingValues, ...upgradeEvidenceArgs])
  assert.equal(named(upgrade.objects, 'Job', 'openbao-init', 'secret-store'), undefined,
    'routine upgrade must not render the payload/policy bootstrap')
  const reconcile = named(upgrade.objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  assert.ok(reconcile, 'routine upgrade must render the dedicated auth reconciler')
  const script = reconcile.spec?.template?.spec?.containers?.[0]?.args?.[0] ?? ''
  assertSuccess(run('/bin/sh', ['-n'], { input: script }), 'rendered OpenBao auth reconciler shell syntax')
  assert.doesNotMatch(script, /\bbao\s+kv\b|\bbao\s+policy\s+(?:read|write|delete)\b|\bsecrets\s+(?:disable|enable)\b/)
  assert.match(script, /token_reviewer_jwt=""/)
  assert.match(script, /disable_local_ca_jwt=false/)
  assert.match(script, /result=(?:changed|unchanged)/)
  assert.match(script, /ROLE_MATCHES_AUTH_STILL_DENIED/)
  assert.match(script, /auth\/token\/lookup-self/)
  assert.match(script, /auth\/token\/revoke-self/)
})

test('FerretDB retains the old Ready ReplicaSet and runs its engine gate as UID 999', () => {
  const { objects } = render()
  const deployment = named(objects, 'Deployment', 'falcone-bbx-ferretdb')
  assert.ok(deployment)
  assert.equal(deployment.spec?.strategy?.type, 'RollingUpdate')
  assert.equal(deployment.spec?.strategy?.rollingUpdate?.maxUnavailable, 0)
  assert.equal(deployment.spec?.strategy?.rollingUpdate?.maxSurge, 1)
  assert.ok(deployment.spec?.revisionHistoryLimit >= 2)
  const gate = deployment.spec?.template?.spec?.initContainers?.find((container) => container.name === 'wait-for-documentdb')
  assert.equal(gate?.securityContext?.runAsUser, 999)
  assert.equal(gate?.securityContext?.runAsNonRoot, true)
  assert.equal(gate?.securityContext?.readOnlyRootFilesystem, true)
  assert.equal(gate?.securityContext?.allowPrivilegeEscalation, false)
  assert.deepEqual(gate?.securityContext?.capabilities?.drop, ['ALL'])
})

test('staging alone selects local-path/fsn1 and pins all six approved first-party digests', () => {
  const staging = readYaml(stagingValues)
  assert.equal(staging?.postgresqlVector?.persistence?.storageClass, 'local-path')
  assert.equal(staging?.postgresqlVector?.nodeSelector?.['topology.kubernetes.io/region'], 'fsn1')

  const expected = new Map([
    ['controlPlane', 'sha256:0c6aeff8f3c115c63b49164cdb6daf73c2b4636b4d1907e48c8b18484218861a'],
    ['controlPlaneExecutor', 'sha256:d19acae027d39e68ae4656e779ae8ce738a22a145092681d34d01201252ac28d'],
    ['webConsole', 'sha256:2cf611ee6e77e63b80c7aa988790191a668e52f08e2f907a335d1bb8eb83ff34'],
    ['workflowWorker', 'sha256:2669be573ec5d461f8a1e21c58c13817fd1bc14a947dba845ce1cfac8368a054'],
    ['controlPlane.functionExecutor.runtimeImage', 'sha256:4fe7a77b01e7e49cd97722a3f55808ec4a09c0c0886680389011ba43796382ba'],
    ['mcp.runtimeImage', 'sha256:ef4bf4a350388508f301f6ea4f39012b412b7bb625314e136812ba8cc53efb99'],
  ])
  for (const [path, digest] of expected) {
    const actual = path.split('.').reduce((value, key) => value?.[key], staging)?.image?.digest
      ?? path.split('.').reduce((value, key) => value?.[key], staging)?.digest
    assert.equal(actual, digest, `${path} must pin its approved digest`)
  }

  for (const profile of ['values.yaml', 'values/prod.yaml', 'values/profiles/ha.yaml', 'values/platform-openshift.yaml']) {
    const text = readFileSync(resolve(umbrellaChart, profile), 'utf8')
    assert.doesNotMatch(text, /storageClass:\s*local-path|topology\.kubernetes\.io\/region:\s*fsn1/,
      `${profile} must not inherit the staging storage topology`)
  }
})

test('revision-20 migration tooling is dry-run-first, exact-targeted, and JIT-confirmed', () => {
  const tool = resolve(umbrellaChart, 'migrations/revision-20-repair.sh')
  const recovery = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')
  assert.ok(existsSync(tool), 'revision-20 migration tool is missing')
  assert.ok(existsSync(recovery), 'revision-20 forward-recovery tool is missing')
  const script = readFileSync(tool, 'utf8')
  assert.match(script, /EXPECTED_CONTEXT="default"/)
  assert.match(script, /EXPECTED_NAMESPACE="in-falcone-staging"/)
  assert.match(script, /EXPECTED_RELEASE="falcone"/)
  assert.match(script, /EXPECTED_REVISION="20"/)
  assert.match(script, /EXPECTED_PVC="falcone-postgresql-vector-data"/)
  assert.match(script, /--pvc-uid/)
  assert.match(script, /--confirm-pvc/)
  assert.match(script, /Pending/)
  assert.match(script, /volumeName/)
  assert.match(script, /claimRef/)
  assert.match(script, /dry-run/i)
  assert.doesNotMatch(script, /delete\s+pvc\s+-l|delete\s+pvc\s+--all|delete\s+namespace/)
  const syntax = run('/bin/bash', ['-n', tool])
  assertSuccess(syntax, 'revision-20 migration shell syntax')
  assertSuccess(run('/bin/bash', ['-n', recovery]), 'forward-recovery shell syntax')
})
