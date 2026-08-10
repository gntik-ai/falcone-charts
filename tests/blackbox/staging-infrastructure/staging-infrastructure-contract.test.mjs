/**
 * Black-box contracts for the revision-20 staging infrastructure repair.
 * These tests use only public Helm renders and migration CLI invocations. The
 * migration fixtures cannot reach a cluster and never expose Secret values.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import {
  assertSuccess,
  combined,
  readYaml,
  repoRoot,
  run,
  umbrellaChart,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

const stagingValues = resolve(umbrellaChart, 'values/staging.yaml')
const repairTool = resolve(umbrellaChart, 'migrations/revision-20-repair.sh')
const recoveryTool = resolve(umbrellaChart, 'migrations/revision-20-forward-recovery.sh')
const migrationFakeBin = resolve(repoRoot, 'tests/blackbox/fixtures/staging-infrastructure/fake-bin')
const upgradeEvidenceArgs = [
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-non-secret-evidence',
]
const approvedImageSource = {
  commit: 'd9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc',
  tag: '0.6.6-main-d9cd0f6b',
}
const approvedDigests = new Map([
  ['controlPlane', 'sha256:26bb5ff1caa0ffbd9f902b5da645fa69caa9153ff6d19b28eda640f35f9c4254'],
  ['controlPlaneExecutor', 'sha256:94809c39149cb6d2aa12a606f5b7db19d8365e1a857b83bcd45405554116feae'],
  ['webConsole', 'sha256:4ccb885b4e15637e68f409fcedf93f180397fad3d6ccf331961d41e43af8c868'],
  ['workflowWorker', 'sha256:0520d57d36ee1383c2077388eb4880023f3b5c11536107151a1e01657001e8aa'],
  ['controlPlane.functionExecutor.runtimeImage', 'sha256:b50e93fb529a2129daa4e682ea4ae3741967a649c5fc1cc5f2f2b6588eb1a0fd'],
  ['mcp.runtimeImage', 'sha256:f0bb4c639f08c40c650e3f2b45a0d3c546fa84b0ae5d2eb9a4153860ec06a162'],
])
const supersededDigests = [
  'sha256:adead18f61c601b016b46af29bcb8d3959bb7956cde4f37775fff6abf6278253',
  'sha256:91c5e8dbc66cf2a10a4c7545d2822624f165f9d39fa3847e5645ed394ef4aa6c',
  'sha256:9c540d1c12f3adf9efbb80a08a314b1dd2b3a3e1443784125a020b9345026191',
  'sha256:fd98a3683aa3457bfda00ea05f1563cd398b951fad22af4f2b7e6b27b038087d',
  'sha256:3329ffdd4a4f97f5dd6818f256507789495fc21d4f0d2a7fdfdf3148a4d15613',
  'sha256:03f1eeaf932a3c87d581e596645f27f3a5d3da04df4b59341bd23fe32e9abfcb',
  'sha256:0c6aeff8f3c115c63b49164cdb6daf73c2b4636b4d1907e48c8b18484218861a',
  'sha256:d19acae027d39e68ae4656e779ae8ce738a22a145092681d34d01201252ac28d',
  'sha256:2cf611ee6e77e63b80c7aa988790191a668e52f08e2f907a335d1bb8eb83ff34',
  'sha256:2669be573ec5d461f8a1e21c58c13817fd1bc14a947dba845ce1cfac8368a054',
  'sha256:4fe7a77b01e7e49cd97722a3f55808ec4a09c0c0886680389011ba43796382ba',
  'sha256:ef4bf4a350388508f301f6ea4f39012b412b7bb625314e136812ba8cc53efb99',
]
const renderCache = new Map()

function render(args = []) {
  const key = JSON.stringify(args)
  if (renderCache.has(key)) return renderCache.get(key)
  const result = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    ...args,
  ])
  assertSuccess(result, `helm template ${args.join(' ')}`)
  const rendered = { text: result.stdout, objects: yamlDocuments(result.stdout) }
  renderCache.set(key, rendered)
  return rendered
}

function named(objects, kind, name, namespace) {
  return objects.find((object) => object?.kind === kind
    && object?.metadata?.name === name
    && (namespace === undefined || object?.metadata?.namespace === namespace))
}

function valueAt(root, path) {
  return path.split('.').reduce((value, key) => value?.[key], root)
}

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function invokeMigration(tool, args = [], scenario = 'safe', assumeApprovedRender = false) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-staging-repair-bbx-'))
  const helmLog = resolve(work, 'helm.log')
  const kubectlLog = resolve(work, 'kubectl.log')
  const stateFile = resolve(work, 'state')
  const realHelm = run('/bin/sh', ['-c', 'command -v helm'])
  assertSuccess(realHelm, 'locating the real Helm executable')
  const result = run('/bin/bash', [tool, ...args], {
    env: {
      ...process.env,
      PATH: `${migrationFakeBin}:${process.env.PATH}`,
      FALCONE_STAGING_REAL_HELM: realHelm.stdout.trim(),
      FALCONE_STAGING_HELM_LOG: helmLog,
      FALCONE_STAGING_KUBECTL_LOG: kubectlLog,
      FALCONE_STAGING_STATE_FILE: stateFile,
      FALCONE_STAGING_SCENARIO: scenario,
      FALCONE_STAGING_ASSUME_APPROVED_RENDER: String(assumeApprovedRender),
    },
    timeout: 30_000,
  })
  const helmCalls = readLines(helmLog)
  const kubectlCalls = readLines(kubectlLog)
  const kubectlMutationVerbs = new Set(['apply', 'create', 'delete', 'patch', 'replace', 'scale', 'set'])
  return {
    result,
    helmCalls,
    kubectlCalls,
    helmMutations: helmCalls.filter((line) => /^(?:install|rollback|uninstall|upgrade)(?:\s|$)/.test(line)),
    kubectlMutations: kubectlCalls.filter((line) => line.split(/\s+/).some((word) => kubectlMutationVerbs.has(word))),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

const confirmedPhaseBArgs = [
  '--phase-b',
  '--apply',
  '--confirm-target', 'default/in-falcone-staging/falcone@20',
  '--pvc-uid', 'bbx-pvc-uid',
  '--confirm-pvc', 'falcone-postgresql-vector-data/bbx-pvc-uid',
  '--backup-reference', 'bbx-backup-reference',
]

// bbx-repair-staging-001 | fn-external-eso-ownership-rbac | OpenSpec #### Scenario: External controller is reused
test('external ESO uses exact TokenRequest/TokenReview authority without adopting its owner', () => {
  const staging = readYaml(stagingValues)
  assert.equal(staging?.eso?.['external-secrets']?.enabled, false)
  assert.equal(staging?.global?.externalSecrets?.operatorNamespace, 'external-secrets')
  assert.equal(staging?.global?.externalSecrets?.operatorServiceAccount, 'external-secrets')
  assert.equal(staging?.eso?.eso?.namespace, 'eso-system')
  assert.equal(staging?.openbao?.eso?.namespace, 'eso-system')

  const { objects } = render(['-f', stagingValues])
  assert.ok(!objects.some((object) => object?.metadata?.namespace === 'external-secrets'),
    'Falcone must render no namespaced object in the external operator namespace')
  assert.ok(named(objects, 'ServiceAccount', 'eso-openbao-auth', 'eso-system'),
    'the Falcone-owned authentication identity is missing')

  const requestRole = named(objects, 'Role', 'eso-openbao-token-request', 'eso-system')
  assert.deepEqual(requestRole?.rules, [{
    apiGroups: [''],
    resources: ['serviceaccounts/token'],
    resourceNames: ['eso-openbao-auth'],
    verbs: ['create'],
  }])
  const requestBinding = named(objects, 'RoleBinding', 'eso-openbao-token-request', 'eso-system')
  assert.deepEqual(requestBinding?.roleRef, {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: 'eso-openbao-token-request',
  })
  assert.deepEqual(
    (requestBinding?.subjects ?? []).map((subject) => `${subject.kind}/${subject.namespace}/${subject.name}`).sort(),
    ['ServiceAccount/external-secrets/external-secrets', 'ServiceAccount/secret-store/openbao-auth-reconciler'],
  )

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
  assert.deepEqual(reviewBinding?.roleRef, {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'ClusterRole',
    name: 'openbao-token-reviewer',
  })

  const authIdentityBindings = objects.filter((object) => /Binding$/.test(object?.kind ?? ''))
    .flatMap((object) => object?.subjects ?? [])
    .filter((subject) => subject.kind === 'ServiceAccount'
      && subject.namespace === 'eso-system' && subject.name === 'eso-openbao-auth')
  assert.deepEqual(authIdentityBindings, [],
    'the identity-only authentication ServiceAccount must receive no Kubernetes mutation authority')

  const adoption = run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'in-falcone-staging',
    '-f', stagingValues,
    '--set', 'eso.eso.clusterOwnership.adoptExisting=true',
  ])
  assert.notEqual(adoption.status, 0, 'the external owner adoption escape hatch unexpectedly rendered')
  assert.match(combined(adoption), /adoptExisting=true is forbidden/)
})

// bbx-repair-staging-002 | fn-openbao-install-bootstrap | OpenSpec #### Scenario: Static reviewer credential is present
test('fresh install retains full bootstrap while upgrade renders only the auth reconciler', () => {
  const install = render(['-f', stagingValues])
  const server = named(install.objects, 'StatefulSet', 'openbao', 'secret-store')
  const bootstrap = named(install.objects, 'Job', 'openbao-init', 'secret-store')
  const reconciler = named(install.objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  assert.ok(bootstrap, 'fresh install must retain the complete bootstrap')
  assert.equal(bootstrap.metadata?.annotations?.['helm.sh/hook'], 'post-install')
  const bootstrapCommands = JSON.stringify(bootstrap.spec?.template?.spec?.containers ?? [])
  assert.match(bootstrapCommands, /bao kv (?:get|patch|put)/,
    'fresh-install bootstrap no longer seeds its established KV payloads')
  assert.match(bootstrapCommands, /bao policy write/,
    'fresh-install bootstrap no longer creates its established policies')
  assert.ok(reconciler,
    'fresh install must verify auth metadata after bootstrap')
  assert.equal(server?.spec?.template?.spec?.serviceAccountName, 'openbao')
  assert.equal(bootstrap.spec?.template?.spec?.serviceAccountName, 'openbao-bootstrap')
  assert.equal(reconciler.spec?.template?.spec?.serviceAccountName, 'openbao-auth-reconciler')
  assert.equal(new Set([
    server.spec?.template?.spec?.serviceAccountName,
    bootstrap.spec?.template?.spec?.serviceAccountName,
    reconciler.spec?.template?.spec?.serviceAccountName,
  ]).size, 3, 'server, bootstrap, and metadata-only reconciler identities must remain separate')

  const upgrade = render(['--is-upgrade', '-f', stagingValues, ...upgradeEvidenceArgs])
  assert.equal(named(upgrade.objects, 'Job', 'openbao-init', 'secret-store'), undefined,
    'routine upgrade must not render the payload/policy bootstrap')
  assert.ok(named(upgrade.objects, 'Job', 'openbao-auth-reconcile', 'secret-store'),
    'routine upgrade must render the dedicated auth reconciler')
})

// bbx-repair-staging-003 | fn-openbao-auth-reconciliation | OpenSpec #### Scenario: Static reviewer credential is present
test('upgrade reconciler selects rotating local reviewer mode and forbids KV or policy-document mutation', () => {
  const { objects } = render(['--is-upgrade', '-f', stagingValues, ...upgradeEvidenceArgs])
  const reconcile = named(objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  assert.ok(reconcile)
  assert.equal(reconcile.metadata?.annotations?.['helm.sh/hook'], 'post-install,post-upgrade')
  assert.equal(reconcile.spec?.template?.spec?.serviceAccountName, 'openbao-auth-reconciler')
  assert.notEqual(reconcile.spec?.template?.spec?.automountServiceAccountToken, false,
    'OpenBao auth reconciliation needs the rotating local pod token')

  const tokenRequest = reconcile.spec?.template?.spec?.initContainers?.find((container) => container.name === 'request-no-kv-canary-token')
  const tokenRequestScript = tokenRequest?.args?.[0] ?? ''
  assert.match(tokenRequestScript, /kubectl -n "eso-system" create token[\s\\]+\s*"eso-openbao-auth"/)
  assert.match(tokenRequestScript, /> \/canary\/token/)
  const canary = reconcile.spec?.template?.spec?.volumes?.find((volume) => volume.name === 'canary')
  assert.equal(canary?.emptyDir?.medium, 'Memory')

  const script = reconcile.spec?.template?.spec?.containers?.find((container) => container.name === 'auth-metadata-reconciler')?.args?.[0] ?? ''
  assertSuccess(run('/bin/sh', ['-n'], { input: script }), 'rendered OpenBao auth reconciler shell syntax')
  assert.doesNotMatch(script, /token_reviewer_jwt=/,
    'routine reconciliation must not clear or replace a persisted reviewer credential')
  assert.doesNotMatch(script, /kubernetes_ca_cert=/,
    'routine reconciliation must not clear or replace persisted Kubernetes CA material')
  assert.match(script, /disable_local_ca_jwt=false/)
  assert.match(script, /reviewer_set=.*token_reviewer_jwt_set/)
  assert.match(script, /desired_name="eso-openbao-auth"/)
  assert.match(script, /desired_namespace="eso-system"/)
  assert.match(script, /desired_policies="functions,gateway,iam,platform"/)
  assert.match(script, /auth\/token\/lookup-self/)
  assert.match(script, /auth\/token\/revoke-self/)

  const forbidden = [
    /\bbao\s+kv(?:\s|$)/,
    /\bbao\s+policy\s+(?:read|write|delete)\b/,
    /\bbao\s+secrets\s+(?:enable|disable)\b/,
    /\bbao\s+auth\s+disable\b/,
    /\bbao\s+operator\s+(?:init|unseal)\b/,
    /\bsecret\/(?:data|metadata)\//,
    /\bsys\/policies\/acl\//,
  ]
  for (const operation of forbidden) assert.doesNotMatch(script, operation)

  const recovery = render([
    '--is-upgrade', '-f', stagingValues, ...upgradeEvidenceArgs,
    '--set', 'openbao.openbao.authReconcile.allowRecoveryRoot=true',
  ])
  const recoveryJob = named(recovery.objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  const recoveryScript = recoveryJob?.spec?.template?.spec?.containers
    ?.find((container) => container.name === 'auth-metadata-reconciler')?.args?.[0] ?? ''
  assert.match(recoveryScript, /if \[ "\$auth_source" = "recovery_root" \]; then[\s\S]*bao policy write auth-reconcile/,
    'only the explicitly authorized recovery render may bootstrap the dedicated metadata policy')
  assert.match(recoveryScript, /auth\/kubernetes\/role\/openbao-auth-reconcile-role/)
  assert.match(recoveryScript, /\/openbao-recovery\/root-token/)
  const mountsAndVolumes = JSON.stringify({
    mounts: reconcile.spec?.template?.spec?.containers?.flatMap((container) => container.volumeMounts ?? []),
    volumes: reconcile.spec?.template?.spec?.volumes,
  })
  assert.doesNotMatch(mountsAndVolumes, /platform-creds|openbao-policy-|root-token|service-account-jwt/i)
})

// bbx-repair-staging-004 | fn-openbao-auth-idempotency | OpenSpec #### Scenario: Metadata already matches + #### Scenario: Matching role remains denied
test('matching OpenBao metadata has an observable unchanged path and denied matching role fails closed', () => {
  const { objects } = render(['--is-upgrade', '-f', stagingValues, ...upgradeEvidenceArgs])
  const reconcile = named(objects, 'Job', 'openbao-auth-reconcile', 'secret-store')
  const script = reconcile.spec?.template?.spec?.containers?.find((container) => container.name === 'auth-metadata-reconciler')?.args?.[0] ?? ''
  assert.match(script, /changed=false/)
  assert.match(script, /if \[ "\$changed" = "true" \]; then[\s\S]*result=changed[\s\S]*else[\s\S]*result=unchanged/)
  assert.match(script, /\[ "\$role_matched" = "true" \] && fail ROLE_MATCHES_AUTH_STILL_DENIED/)
})

// bbx-repair-staging-005 | fn-ferretdb-uid-rollout | OpenSpec #### Scenario: Replacement never becomes Ready
test('FerretDB keeps zero-unavailable rollout safety and runs its engine gate as UID 999', () => {
  const { objects } = render()
  const deployment = named(objects, 'Deployment', 'falcone-bbx-ferretdb')
  assert.ok(deployment)
  assert.equal(deployment.spec?.replicas, 2)
  assert.equal(deployment.spec?.strategy?.type, 'RollingUpdate')
  assert.equal(deployment.spec?.strategy?.rollingUpdate?.maxUnavailable, 0)
  assert.equal(deployment.spec?.strategy?.rollingUpdate?.maxSurge, 1)
  assert.ok(deployment.spec?.revisionHistoryLimit >= 2)
  assert.ok(deployment.spec?.progressDeadlineSeconds > 0 && deployment.spec?.progressDeadlineSeconds <= 600)
  const gate = deployment.spec?.template?.spec?.initContainers?.find((container) => container.name === 'wait-for-documentdb')
  assert.equal(gate?.image, 'ghcr.io/ferretdb/postgres-documentdb@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7')
  assert.equal(gate?.securityContext?.runAsUser, 999)
  assert.equal(gate?.securityContext?.runAsNonRoot, true)
  assert.equal(gate?.securityContext?.readOnlyRootFilesystem, true)
  assert.equal(gate?.securityContext?.allowPrivilegeEscalation, false)
  assert.deepEqual(gate?.securityContext?.capabilities?.drop, ['ALL'])
})

// bbx-repair-staging-006 | fn-ferretdb-openshift-uid | OpenSpec #### Scenario: Replacement never becomes Ready
test('OpenShift preserves arbitrary-UID behavior while retaining the FerretDB rollout hardening', () => {
  const openshiftValues = resolve(umbrellaChart, 'values/platform-openshift.yaml')
  const { objects } = render(['-f', openshiftValues])
  const deployment = named(objects, 'Deployment', 'falcone-bbx-ferretdb')
  const gate = deployment?.spec?.template?.spec?.initContainers?.find((container) => container.name === 'wait-for-documentdb')
  assert.equal(gate?.securityContext?.runAsUser, undefined,
    'OpenShift arbitrary-UID render must not pin the Kubernetes staging UID')
  assert.equal(gate?.securityContext?.runAsNonRoot, true)
  assert.equal(gate?.securityContext?.readOnlyRootFilesystem, true)
  assert.equal(gate?.securityContext?.allowPrivilegeEscalation, false)
  assert.deepEqual(gate?.securityContext?.capabilities?.drop, ['ALL'])
  assert.equal(deployment?.spec?.strategy?.rollingUpdate?.maxUnavailable, 0)
  assert.equal(deployment?.spec?.strategy?.rollingUpdate?.maxSurge, 1)
})

// bbx-repair-staging-007 | fn-staging-storage-image-authority | OpenSpec #### Scenario: Staging render
test('staging alone selects local-path/fsn1 and renders all six exact approved digests', () => {
  const staging = readYaml(stagingValues)
  assert.equal(staging?.postgresqlVector?.persistence?.storageClass, 'local-path')
  assert.equal(staging?.postgresqlVector?.nodeSelector?.['topology.kubernetes.io/region'], 'fsn1')

  const { objects } = render(['-f', stagingValues])
  const vectorPvc = named(objects, 'PersistentVolumeClaim', 'falcone-bbx-postgresql-vector-data')
  const vectorStatefulSet = named(objects, 'StatefulSet', 'falcone-bbx-postgresql-vector')
  assert.equal(vectorPvc?.spec?.storageClassName, 'local-path')
  assert.equal(vectorPvc?.spec?.accessModes?.[0], 'ReadWriteOnce')
  assert.equal(vectorPvc?.spec?.resources?.requests?.storage, '10Gi')
  assert.equal(vectorStatefulSet?.spec?.template?.spec?.nodeSelector?.['topology.kubernetes.io/region'], 'fsn1')

  const rendered = JSON.stringify(objects)
  const violations = []
  for (const [path, digest] of approvedDigests) {
    const value = valueAt(staging, path)
    const image = value?.image ?? value
    if (image?.digest !== digest) {
      violations.push(`${path}: expected ${digest}, got ${image?.digest ?? 'missing'}`)
    }
    if (!rendered.includes(digest)) {
      violations.push(`${path}: ${digest} did not reach the rendered public manifest`)
    }
  }
  for (const digest of supersededDigests) {
    if (rendered.includes(digest)) violations.push(`staging render retained superseded image ${digest}`)
  }
  assert.deepEqual(violations, [],
    `staging must use the images built from origin/main ${approvedImageSource.commit} (${approvedImageSource.tag})`)
})

// bbx-repair-staging-008 | fn-nonstaging-storage-nonregression | OpenSpec #### Scenario: Staging render
test('base, production, HA, and OpenShift renders do not inherit staging storage or approved-image overrides', () => {
  const profiles = [
    ['base', []],
    ['production', ['-f', resolve(umbrellaChart, 'values/prod.yaml')]],
    ['HA', ['-f', resolve(umbrellaChart, 'values/profiles/ha.yaml')]],
    ['OpenShift', ['-f', resolve(umbrellaChart, 'values/platform-openshift.yaml')]],
  ]
  for (const [profile, args] of profiles) {
    const { objects } = render(args)
    const vectorPvc = named(objects, 'PersistentVolumeClaim', 'falcone-bbx-postgresql-vector-data')
    const vectorStatefulSet = named(objects, 'StatefulSet', 'falcone-bbx-postgresql-vector')
    assert.equal(vectorPvc?.spec?.storageClassName, undefined, `${profile} inherited local-path`)
    assert.notEqual(vectorStatefulSet?.spec?.template?.spec?.nodeSelector?.['topology.kubernetes.io/region'], 'fsn1',
      `${profile} inherited the staging topology`)
    const rendered = JSON.stringify(objects)
    for (const digest of approvedDigests.values()) {
      assert.doesNotMatch(rendered, new RegExp(digest), `${profile} inherited an approved staging image override`)
    }
  }
})

// bbx-repair-staging-009 | fn-revision20-dry-run | OpenSpec #### Scenario: PVC state changes
test('revision-20 repair and forward-recovery CLIs default to read-only dry-run', () => {
  for (const tool of [repairTool, recoveryTool]) {
    assert.ok(existsSync(tool), `migration tool is missing: ${tool}`)
    const invocation = invokeMigration(tool)
    try {
      assertSuccess(invocation.result, `${tool} default dry-run`)
      assert.match(combined(invocation.result), /dry-run=true/)
      assert.match(combined(invocation.result), /no mutation performed/)
      assert.deepEqual(invocation.helmMutations, [])
      assert.deepEqual(invocation.kubectlMutations, [])
    } finally {
      invocation.cleanup()
    }
  }
})

// bbx-repair-staging-010 | fn-revision20-target-gate | OpenSpec #### Scenario: PVC state changes
test('revision-20 apply refuses a missing or inexact target confirmation before mutation', () => {
  const invocation = invokeMigration(repairTool, [
    '--phase-a', '--apply',
    '--confirm-target', 'default/in-falcone-staging/falcone',
    '--backup-reference', 'bbx-backup-reference',
  ], 'safe', true)
  try {
    assert.notEqual(invocation.result.status, 0)
    assert.match(combined(invocation.result), /JIT_TARGET_CONFIRMATION_REQUIRED expected=default\/in-falcone-staging\/falcone@20/)
    assert.deepEqual(invocation.helmMutations, [])
    assert.deepEqual(invocation.kubectlMutations, [])
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-011 | fn-revision20-pvc-identity-gate | OpenSpec #### Scenario: PVC state changes
test('post-confirmation PVC UID, phase, or volume change forbids deletion', () => {
  for (const scenario of ['pvc-uid-changed', 'pvc-phase-changed', 'pvc-volume-changed']) {
    const invocation = invokeMigration(repairTool, confirmedPhaseBArgs, scenario, true)
    try {
      assert.notEqual(invocation.result.status, 0, `${scenario} unexpectedly succeeded`)
      assert.ok(!invocation.kubectlCalls.some((line) => /\bdelete\s+pvc\b/.test(line)),
        `${scenario} reached PVC deletion`)
      assert.deepEqual(invocation.helmMutations, [], `${scenario} reached Helm mutation`)
    } finally {
      invocation.cleanup()
    }
  }
})

// bbx-repair-staging-012 | fn-revision20-jit-state-gate | OpenSpec #### Scenario: PVC state changes
test('post-confirmation PV claimRef or Pod evidence invalidates the PVC confirmation', () => {
  const unsafe = []
  for (const scenario of ['pv-claimref-added', 'pod-evidence-added']) {
    const invocation = invokeMigration(repairTool, confirmedPhaseBArgs, scenario, true)
    try {
      if (invocation.result.status === 0
        || invocation.kubectlCalls.some((line) => /\bdelete\s+pvc\b/.test(line))
        || invocation.helmMutations.length > 0) {
        unsafe.push(scenario)
      }
    } finally {
      invocation.cleanup()
    }
  }
  assert.deepEqual(unsafe, [], 'state was allowed to change between confirmation and exact PVC deletion')
})

// bbx-repair-staging-013 | fn-revision20-exact-pvc-target | OpenSpec #### Scenario: PVC state changes
test('confirmed Phase B mutates only the exact StatefulSet, PVC, and repaired Helm release', () => {
  const invocation = invokeMigration(repairTool, confirmedPhaseBArgs, 'safe', true)
  try {
    assertSuccess(invocation.result, 'confirmed Phase B fixture run')
    assert.match(combined(invocation.result), /phase-b=applied recovery=forward-only pvc=falcone-postgresql-vector-data uid=bbx-pvc-uid/)
    assert.ok(invocation.kubectlCalls.includes('-n in-falcone-staging scale statefulset falcone-postgresql-vector --replicas=0'))
    assert.ok(invocation.kubectlCalls.includes('-n in-falcone-staging delete pvc falcone-postgresql-vector-data --wait=true'))
    assert.equal(invocation.kubectlCalls.filter((line) => /\bdelete\s+pvc\b/.test(line)).length, 1)
    assert.ok(!invocation.kubectlCalls.some((line) => /(?:--all|-l|\*)/.test(line) && /\bdelete\b/.test(line)))
    assert.equal(invocation.helmMutations.length, 1)
    assert.match(invocation.helmMutations[0], /^upgrade falcone .*--namespace in-falcone-staging/)
  } finally {
    invocation.cleanup()
  }
})

// bbx-repair-staging-014 | fn-revision20-forward-recovery | OpenSpec #### Scenario: Apply fails after deletion
test('forward recovery never deletes, rolls back, or targets anything beyond the repaired release', () => {
  const invocation = invokeMigration(recoveryTool, [
    '--apply',
    '--confirm-target', 'default/in-falcone-staging/falcone',
    '--backup-reference', 'bbx-backup-reference',
  ])
  try {
    assertSuccess(invocation.result, 'forward-recovery fixture run')
    assert.match(combined(invocation.result), /forward-recovery=applied rollback=not-used/)
    assert.ok(!invocation.kubectlCalls.some((line) => /\bdelete\b/.test(line)))
    assert.ok(!invocation.helmCalls.some((line) => /^rollback(?:\s|$)/.test(line)))
    assert.equal(invocation.helmMutations.length, 1)
    assert.match(invocation.helmMutations[0], /^upgrade falcone .*--namespace in-falcone-staging/)

    const publicScript = readFileSync(recoveryTool, 'utf8')
    assert.doesNotMatch(publicScript, /\bhelm\s+rollback\b/)
    assert.doesNotMatch(publicScript, /\bkubectl(?:\s+-n\s+"?\$EXPECTED_NAMESPACE"?)?\s+delete\b/)
  } finally {
    invocation.cleanup()
  }
})
