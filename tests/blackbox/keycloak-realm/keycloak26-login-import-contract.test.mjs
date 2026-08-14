/**
 * Public black-box regression contract for Keycloak 26 realm login representation.
 *
 * The suite invokes only the published Helm chart surface. Assertions are made against rendered
 * Kubernetes resources and the bootstrap program distributed in those resources; no template,
 * private chart helper, Kubernetes API server, or Keycloak instance is accessed.
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import {
  assertFailure,
  combined,
  render,
  repoRoot,
  run,
  umbrellaChart,
} from '../fixtures/blackbox.mjs'

const loginSettings = {
  loginWithEmailAllowed: false,
  registrationAllowed: true,
  rememberMe: false,
  verifyEmail: true,
  resetPasswordAllowed: false,
}

const loginValueArgs = Object.entries(loginSettings).flatMap(([name, value]) => [
  '--set', `bootstrap.oneShot.keycloak.realm.login.${name}=${value}`,
])

const unsupportedTopLevelLoginArgs = Object.entries(loginSettings).flatMap(([name, value]) => [
  '--set', `bootstrap.oneShot.keycloak.realm.${name}=${value}`,
])

const upgradeEvidenceArgs = [
  '--set-string', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-keycloak26-login-import',
]

function namedBootstrapArtifacts(objects) {
  const payloads = objects.filter((object) => (
    object?.kind === 'ConfigMap'
    && typeof object?.data?.['realm.json'] === 'string'
  ))
  assert.equal(payloads.length, 1, 'render must publish exactly one bootstrap realm.json payload')

  const scripts = objects.filter((object) => (
    object?.kind === 'ConfigMap'
    && typeof object?.data?.['bootstrap.sh'] === 'string'
  ))
  assert.equal(scripts.length, 1, 'render must publish exactly one bootstrap shell program')

  const jobs = objects.filter((object) => (
    object?.kind === 'Job'
    && (object?.spec?.template?.spec?.containers ?? []).some((container) => container.name === 'bootstrap')
  ))
  assert.equal(jobs.length, 1, 'render must publish exactly one platform bootstrap Job')

  const keycloakWorkloads = objects.filter((object) => (
    ['Deployment', 'StatefulSet'].includes(object?.kind)
    && (object?.spec?.template?.spec?.containers ?? []).some((container) => (
      /(?:^|\/)keycloak(?::|@)/.test(container.image ?? '')
    ))
  ))
  assert.equal(keycloakWorkloads.length, 1, 'render must publish exactly one Keycloak workload')

  return {
    job: jobs[0],
    keycloakWorkload: keycloakWorkloads[0],
    payloadConfig: payloads[0],
    realm: JSON.parse(payloads[0].data['realm.json']),
    script: scripts[0].data['bootstrap.sh'],
  }
}

function shellFunctions(script) {
  return new Map(
    [...script.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\(\) \{\n([\s\S]*?)^\}\n/gm)]
      .map((match) => [match[1], match[2]]),
  )
}

function reachableFunctionText(script, entrypoint) {
  const functions = shellFunctions(script)
  assert.ok(functions.has(entrypoint), `rendered bootstrap program lacks ${entrypoint}()`)
  const visited = new Set()
  const visit = (name) => {
    if (visited.has(name)) return ''
    visited.add(name)
    const body = functions.get(name) ?? ''
    const callees = [...functions.keys()].filter((candidate) => (
      candidate !== name && new RegExp(`\\b${candidate}\\b`).test(body)
    ))
    return `${body}\n${callees.map(visit).join('\n')}`
  }
  return visit(entrypoint)
}

function loginRepresentation(value, context) {
  assert.equal(value?.login, undefined, `${context} must not nest Keycloak login settings under login`)
  assert.deepEqual(
    Object.fromEntries(Object.keys(loginSettings).map((name) => [name, value?.[name]])),
    loginSettings,
    `${context} must expose all five configured Keycloak 26 login settings at realm top level`,
  )
}

function helmTemplate(args) {
  return run('helm', [
    'template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx',
    ...args,
  ])
}

function assertPreRenderFailure(args, expectedPath) {
  const result = helmTemplate(args)
  assert.notEqual(result.status, 0, `Helm must reject ${expectedPath} before manifest output`)
  assert.doesNotMatch(result.stdout ?? '', /^apiVersion:/m, 'invalid values must not emit a partial manifest')
  assert.match(combined(result), expectedPath, 'failure must identify the rejected public values path')
  return result
}

function assertAmbiguousRepresentationFails(name, value, label) {
  const result = helmTemplate([
    ...loginValueArgs,
    '--set', `bootstrap.oneShot.keycloak.realm.${name}=${value}`,
  ])
  assert.notEqual(result.status, 0,
    `${label} nested/top-level ${name} representation unexpectedly succeeded`)
  assert.doesNotMatch(result.stdout ?? '', /^apiVersion:/m,
    `${label} representation must not emit a partial manifest`)
  assert.match(combined(result), new RegExp(`${name}|conflict|duplicate`, 'i'),
    `${label} failure must identify the ambiguous setting`)
}

function jsonLines(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function executeRenderedBootstrap(artifacts, scenario) {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-keycloak26-bootstrap-bbx-'))
  const payloadDirectory = resolve(directory, 'payload')
  const fakeBin = resolve(directory, 'fake-bin')
  const stateDirectory = resolve(directory, 'state')
  const script = resolve(directory, 'bootstrap.sh')
  const curlLog = resolve(stateDirectory, 'curl.jsonl')
  const kubectlLog = resolve(stateDirectory, 'kubectl.jsonl')
  const traceLog = resolve(stateDirectory, 'trace.jsonl')
  mkdirSync(payloadDirectory)
  mkdirSync(fakeBin)
  mkdirSync(stateDirectory)
  for (const file of [curlLog, kubectlLog, traceLog]) writeFileSync(file, '')

  for (const [name, value] of Object.entries(artifacts.payloadConfig.data ?? {})) {
    writeFileSync(resolve(payloadDirectory, name), value)
  }
  writeFileSync(script, artifacts.script, { mode: 0o755 })

  for (const [source, target] of [
    ['fake-curl.mjs', 'curl'],
    ['fake-kubectl.mjs', 'kubectl'],
  ]) {
    copyFileSync(
      resolve(repoRoot, 'tests/blackbox/fixtures/keycloak26-bootstrap', source),
      resolve(fakeBin, target),
    )
    chmodSync(resolve(fakeBin, target), 0o755)
  }

  const marker = /^ONE_SHOT_HASH="([a-f0-9]{64})"$/m.exec(artifacts.script)?.[1]
  assert.ok(marker, 'rendered bootstrap program must expose its public one-shot hash')
  const nodeExecutable = run('sh', ['-c', 'command -v node']).stdout.trim()
  assert.ok(nodeExecutable, 'process-isolated fake public commands require the Node test runtime')
  const nodeRoot = resolve(dirname(nodeExecutable), '..')

  const result = run('bwrap', [
    '--die-with-parent',
    '--unshare-all',
    '--tmpfs', '/',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--dir', '/bootstrap',
    '--ro-bind', payloadDirectory, '/bootstrap/payload',
    '--dir', '/bootstrap/script',
    '--ro-bind', script, '/bootstrap/script/bootstrap.sh',
    '--dir', '/bbx',
    '--ro-bind', fakeBin, '/bbx/bin',
    '--ro-bind', nodeRoot, '/bbx/node',
    '--bind', stateDirectory, '/bbx/state',
    '--setenv', 'PATH', '/bbx/bin:/bbx/node/bin:/usr/bin:/bin',
    '--setenv', 'HOSTNAME', 'bbx-keycloak26-bootstrap',
    '--setenv', 'FALCONE_BBX_KEYCLOAK_SCENARIO', scenario,
    '--setenv', 'FALCONE_BBX_MARKER_HASH', marker,
    '--setenv', 'FALCONE_BBX_CURL_LOG', '/bbx/state/curl.jsonl',
    '--setenv', 'FALCONE_BBX_KUBECTL_LOG', '/bbx/state/kubectl.jsonl',
    '--setenv', 'FALCONE_BBX_TRACE_LOG', '/bbx/state/trace.jsonl',
    '--setenv', 'BOOTSTRAP_KEYCLOAK_ADMIN_USERNAME', 'bbx-admin',
    '--setenv', 'BOOTSTRAP_KEYCLOAK_ADMIN_PASSWORD', 'bbx-admin-password-must-not-escape',
    '--setenv', 'BOOTSTRAP_SUPERADMIN_PASSWORD', 'bbx-superadmin-password-must-not-escape',
    '--setenv', 'BOOTSTRAP_APISIX_ADMIN_KEY', 'bbx-apisix-key-must-not-escape',
    '/bin/bash', '/bootstrap/script/bootstrap.sh',
  ], { timeout: 10_000 })

  const invocation = {
    result,
    curlCalls: jsonLines(curlLog),
    kubectlCalls: jsonLines(kubectlLog),
    trace: jsonLines(traceLog),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  }
  return invocation
}

function loginPuts(invocation) {
  return invocation.curlCalls.filter((call) => (
    call.method === 'PUT'
    && call.url.endsWith('/admin/realms/in-falcone-platform')
    && call.dataFile === '/bootstrap/payload/login.json'
  ))
}

function loginReadbacks(invocation) {
  return invocation.curlCalls.filter((call) => (
    call.method === 'GET'
    && call.url.endsWith('/admin/realms/in-falcone-platform')
    && call.output === '/tmp/keycloak-login-readback'
  ))
}

function initialRealmGets(invocation) {
  return invocation.curlCalls.filter((call) => (
    call.method === 'GET'
    && call.url.endsWith('/admin/realms/in-falcone-platform')
    && call.output === '/tmp/keycloak-realm-check'
  ))
}

function realmCreates(invocation) {
  return invocation.curlCalls.filter((call) => (
    call.method === 'POST'
    && call.url.endsWith('/admin/realms')
    && call.dataFile === '/bootstrap/payload/realm.json'
  ))
}

function markerWrites(invocation) {
  return invocation.kubectlCalls.filter((call) => (
    call.verb === 'apply'
    || (call.verb === 'create' && call.name === 'in-falcone-bootstrap-state')
  ))
}

function assertSecretSafeFailure(invocation, diagnostic) {
  const evidence = combined(invocation.result)
  assert.match(evidence, diagnostic)
  assert.ok(Buffer.byteLength(evidence) <= 4096,
    `bootstrap failure diagnostic must remain bounded, got ${Buffer.byteLength(evidence)} bytes`)
  assert.doesNotMatch(evidence,
    /bbx-sensitive-provider-body|bbx-admin-password|bbx-superadmin-password|bbx-apisix-key|bbx-process-isolated-admin-token/,
    'bootstrap failure exposed a provider response or credential')
  assert.equal(markerWrites(invocation).length, 0,
    'failed login convergence must not create or apply the success marker')
  assert.equal(invocation.curlCalls.filter((call) => call.url.includes('/clients?')).length, 0,
    'failed login convergence must stop before later auth-layer verification')
  assert.equal(invocation.curlCalls.filter((call) => call.url.includes('/users?')).length, 0,
    'failed login convergence must stop before superadmin verification')
}

function assertFreshRealmFailure(invocation, diagnostic) {
  assert.notEqual(invocation.result.status, 0, 'failed fresh-realm interaction unexpectedly succeeded')
  assertSecretSafeFailure(invocation, diagnostic)
  assert.equal(loginPuts(invocation).length, 0,
    'failed initial realm discovery/create must stop before login reconciliation')
  assert.equal(loginReadbacks(invocation).length, 0,
    'failed initial realm discovery/create must stop before login readback')
  assert.deepEqual(
    invocation.curlCalls.filter((call) => call.method === 'DELETE' && call.url.includes('/admin/realms')),
    [],
    'failed fresh-realm interaction must not delete durable Keycloak resources',
  )
  assert.doesNotMatch(combined(invocation.result), /\b(?:helm\s+rollback|rollback initiated)\b/i,
    'failed fresh-realm interaction must not initiate rollback')
}

let install
let upgrade

test.before(() => {
  install = namedBootstrapArtifacts(render(umbrellaChart, loginValueArgs).objects)
  upgrade = namedBootstrapArtifacts(render(umbrellaChart, [
    '--is-upgrade',
    ...upgradeEvidenceArgs,
    ...loginValueArgs,
  ]).objects)
})

// bbx-keycloak26-login-001 | fn-keycloak-26-realm-login-import | OpenSpec #### Scenario: Fresh install sends Keycloak 26 login settings as top-level realm fields
test('fresh install renders a Keycloak 26-compatible top-level realm representation', () => {
  const images = (install.keycloakWorkload.spec?.template?.spec?.containers ?? [])
    .map((container) => container.image)
  assert.ok(images.some((image) => /(?:^|\/)keycloak:26(?:\.|$)/.test(image ?? '')),
    `contract must exercise the rendered Keycloak 26 workload, got ${images.join(', ')}`)

  loginRepresentation(install.realm, 'fresh-install realm.json')
  assert.equal(install.realm.realm, 'in-falcone-platform')
  assert.equal(install.realm.enabled, true)
  assert.equal(install.realm.displayName, 'In Falcone Platform')
  assert.equal(install.realm.bruteForceProtected, true,
    'flattening login settings must preserve unrelated top-level realm protection')

  const createProgram = reachableFunctionText(install.script, 'ensure_keycloak_realm')
  assert.match(createProgram, /-X POST/, 'missing-realm path must create the realm')
  assert.match(createProgram, /--data @"\$PAYLOAD_DIR\/realm\.json"/,
    'realm create must submit the exact rendered realm.json payload')
  assert.match(createProgram, /\/admin\/realms(?:"|\s)/,
    'realm create must target the public Keycloak Admin REST collection')
})

// bbx-keycloak26-login-002 | fn-keycloak-26-realm-login-upgrade | OpenSpec #### Scenario: Existing realms are preserved while Keycloak 26 login settings are reconciled on upgrade
test('upgrade preserves an existing realm and idempotently reconciles its login settings', () => {
  loginRepresentation(upgrade.realm, 'upgrade realm.json')
  assert.deepEqual(upgrade.realm, install.realm,
    'install and upgrade must derive the same public realm representation from the same values')

  const hook = upgrade.job.metadata?.annotations?.['helm.sh/hook'] ?? ''
  assert.deepEqual(new Set(hook.split(',').map((value) => value.trim())),
    new Set(['post-install', 'post-upgrade']),
    'the same bootstrap contract must execute after clean install and routine upgrade')

  const createBody = shellFunctions(upgrade.script).get('ensure_keycloak_realm') ?? ''
  const existingRealm = createBody.indexOf('if [ "$status" = "200" ]')
  const existingReturn = createBody.indexOf('return 0', existingRealm)
  const createRequest = createBody.indexOf('-X POST')
  assert.ok(existingRealm >= 0 && existingReturn > existingRealm && createRequest > existingReturn,
    'a successful existing-realm read must return before the create POST')

  const upgradeProgram = reachableFunctionText(upgrade.script, 'run_upgrade_reconciliation')
  assert.match(upgradeProgram, /-X PUT/,
    'routine upgrade must idempotently PUT existing-realm login settings')
  assert.match(upgradeProgram, /\/admin\/realms\/\$KEYCLOAK_REALM_ID/,
    'routine login reconciliation must address the existing platform realm')
  assert.doesNotMatch(upgradeProgram, /-X (?:POST|DELETE)/,
    'routine login reconciliation must neither recreate nor delete existing realm resources')

  const referencedPayloads = [...upgradeProgram.matchAll(/--data @"\$PAYLOAD_DIR\/([^"\n]+)"/g)]
    .map((match) => match[1])
    .filter((name) => typeof upgrade.payloadConfig.data?.[name] === 'string')
    .map((name) => JSON.parse(upgrade.payloadConfig.data[name]))
  const loginUpdate = referencedPayloads.find((payload) => (
    Object.keys(loginSettings).every((name) => typeof payload?.[name] === 'boolean')
  ))
  assert.ok(loginUpdate,
    'routine upgrade must submit a rendered payload containing all five top-level login settings')
  loginRepresentation(loginUpdate, 'existing-realm update payload')
})

// bbx-keycloak26-login-003 | fn-keycloak-26-realm-login-validation | OpenSpec #### Scenario: Malformed realm login configuration fails before any Keycloak mutation
test('malformed or unknown realm login settings fail during public Helm validation', () => {
  assertPreRenderFailure([
    '--set', 'bootstrap.oneShot.keycloak.realm.login.loginWithEmailAllowed=not-a-boolean',
  ], /bootstrap.+oneShot.+keycloak.+realm.+login.+loginWithEmailAllowed/i)

  assertPreRenderFailure([
    '--set', 'bootstrap.oneShot.keycloak.realm.login.keycloak26UnknownSetting=true',
  ], /bootstrap.+oneShot.+keycloak.+realm.+login/i)
})

// bbx-keycloak26-login-004 | fn-keycloak-26-realm-login-conflict | OpenSpec #### Scenario: Conflicting nested and top-level realm login settings fail closed
test('duplicate nested/top-level login representations fail closed', () => {
  assertAmbiguousRepresentationFails('loginWithEmailAllowed', false, 'duplicate')
})

// bbx-keycloak26-login-005 | fn-keycloak-26-realm-login-conflict | OpenSpec #### Scenario: Conflicting nested and top-level realm login settings fail closed
test('conflicting nested/top-level login representations fail closed', () => {
  assertAmbiguousRepresentationFails('registrationAllowed', false, 'conflicting')
})

// bbx-keycloak26-login-006 | fn-keycloak-26-realm-bootstrap-secrecy | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('rendered realm bootstrap keeps credentials in Secret references and disables shell tracing', () => {
  const container = (install.job.spec?.template?.spec?.containers ?? [])
    .find((candidate) => candidate.name === 'bootstrap')
  assert.ok(container, 'bootstrap Job container is absent')

  const credentialEnv = (container.env ?? []).filter((entry) => /PASSWORD|KEY/i.test(entry.name ?? ''))
  assert.ok(credentialEnv.length >= 3, 'bootstrap must declare its credential inputs')
  for (const entry of credentialEnv) {
    assert.equal(entry.value, undefined, `${entry.name} must not contain a rendered literal`)
    assert.equal(typeof entry.valueFrom?.secretKeyRef?.name, 'string',
      `${entry.name} must be sourced from a Kubernetes Secret reference`)
    assert.equal(typeof entry.valueFrom?.secretKeyRef?.key, 'string',
      `${entry.name} must select a Secret key without rendering its value`)
  }

  assert.match(install.script, /^set -euo pipefail$/m, 'bootstrap must retain fail-fast shell behavior')
  assert.doesNotMatch(install.script, /(?:^|\s)set\s+-[^\n]*x|(?:^|\s)(?:-v|--verbose)(?=\s|$)/m,
    'bootstrap must not enable shell or HTTP credential tracing')
  const realmKeys = []
  const collectKeys = (value) => {
    if (Array.isArray(value)) return value.forEach(collectKeys)
    if (!value || typeof value !== 'object') return
    for (const [name, child] of Object.entries(value)) {
      realmKeys.push(name)
      collectKeys(child)
    }
  }
  collectKeys(install.realm)
  assert.ok(realmKeys.every((name) => !/^(?:password|credential|access[_-]?token|client[_-]?secret)$/i.test(name)),
    `public realm payload contains a credential-bearing field: ${realmKeys.join(', ')}`)
})

// bbx-keycloak26-login-007 | fn-keycloak-26-realm-bootstrap-failure | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('failed clean-install bootstrap remains retryable and records success only after verification', () => {
  const functions = shellFunctions(install.script)
  const main = functions.get('main') ?? ''
  const oneShot = main.indexOf('run_one_shot_bootstrap')
  const reconcile = main.indexOf('run_upgrade_reconciliation')
  const verify = main.indexOf('verify_auth_layer')
  const marker = main.indexOf('write_marker')
  assert.ok(oneShot >= 0 && reconcile > oneShot && verify > reconcile && marker > verify,
    'success marker must be written only after create, reconciliation, and auth verification')
  assert.equal((main.match(/\bwrite_marker\b/g) ?? []).length, 1,
    'bootstrap main must expose one terminal success-marker write')

  assert.ok(Number(install.job.spec?.backoffLimit) >= 1,
    'a transient clean-install failure must remain retryable while the marker is absent')
  assert.equal(install.job.spec?.template?.spec?.restartPolicy, 'OnFailure')
  assert.match(install.job.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? '', /before-hook-creation/,
    'a later Helm retry must be able to replace the failed hook Job')
  assert.doesNotMatch(install.script, /\bhelm\s+(?:rollback|upgrade)|\bkubectl\s+[^\n]*\bdelete\s+[^\n]*\b(?:realm|keycloak)\b/i,
    'realm compatibility failure must not roll back or delete durable identity state')
})

// bbx-keycloak26-login-008 | fn-keycloak-26-realm-login-upgrade | OpenSpec #### Scenario: Existing realms are preserved while Keycloak 26 login settings are reconciled on upgrade
test('matching-marker reruns execute one exact login PUT/readback before verification and marker write', () => {
  const first = executeRenderedBootstrap(install, 'success')
  const second = executeRenderedBootstrap(install, 'success')
  try {
    for (const [label, invocation] of [['first run', first], ['idempotent rerun', second]]) {
      assert.equal(invocation.result.status, 0,
        `${label} failed:\n${combined(invocation.result)}`)
      assert.equal(loginPuts(invocation).length, 1, `${label} must execute exactly one login PUT`)
      assert.equal(loginReadbacks(invocation).length, 1, `${label} must execute exactly one exact readback`)

      const adminDestructive = invocation.curlCalls.filter((call) => (
        call.url.includes('/admin/realms') && ['POST', 'DELETE'].includes(call.method)
      ))
      assert.deepEqual(adminDestructive, [],
        `${label} must not recreate or delete an existing realm resource`)

      const trace = invocation.trace
      const putIndex = trace.findIndex((call) => call.source === 'curl' && loginPuts({ curlCalls: [call] }).length === 1)
      const readbackIndex = trace.findIndex((call) => (
        call.source === 'curl' && loginReadbacks({ curlCalls: [call] }).length === 1
      ))
      const verifyIndex = trace.findIndex((call) => (
        call.source === 'curl' && call.url.includes('/users?username=superadmin&exact=true')
      ))
      const markerIndex = trace.findIndex((call) => (
        call.source === 'kubectl' && call.verb === 'create' && call.name === 'in-falcone-bootstrap-state'
      ))
      assert.ok(putIndex >= 0 && readbackIndex > putIndex && verifyIndex > readbackIndex && markerIndex > verifyIndex,
        `${label} must order login PUT, exact readback, later verification, then success marker`)
    }

    assert.deepEqual(first.curlCalls, second.curlCalls,
      'matching-marker rerun must retain the exact idempotent Keycloak request sequence')
  } finally {
    first.cleanup()
    second.cleanup()
  }
})

// bbx-keycloak26-login-009 | fn-keycloak-26-realm-login-readback | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('login readback drift fails closed before verification or success marker', () => {
  const invocation = executeRenderedBootstrap(install, 'drift')
  try {
    assert.notEqual(invocation.result.status, 0, 'drifted login readback unexpectedly succeeded')
    assert.equal(loginPuts(invocation).length, 1)
    assert.equal(loginReadbacks(invocation).length, 1)
    assertSecretSafeFailure(invocation, /Keycloak realm login settings did not converge/)
  } finally {
    invocation.cleanup()
  }
})

// bbx-keycloak26-login-010 | fn-keycloak-26-realm-login-update-failure | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('login PUT failure is bounded and secret-safe with no later phase or marker', () => {
  const invocation = executeRenderedBootstrap(install, 'put-failure')
  try {
    assert.notEqual(invocation.result.status, 0, 'failed Keycloak login PUT unexpectedly succeeded')
    assert.equal(loginPuts(invocation).length, 1)
    assert.equal(loginReadbacks(invocation).length, 0)
    assertSecretSafeFailure(invocation, /failed to reconcile Keycloak realm login settings; status=400/)
  } finally {
    invocation.cleanup()
  }
})

// bbx-keycloak26-login-011 | fn-keycloak-26-realm-login-readback-failure | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('login GET failure is bounded and secret-safe with no later phase or marker', () => {
  const invocation = executeRenderedBootstrap(install, 'get-failure')
  try {
    assert.notEqual(invocation.result.status, 0, 'failed Keycloak login readback unexpectedly succeeded')
    assert.equal(loginPuts(invocation).length, 1)
    assert.equal(loginReadbacks(invocation).length, 1)
    assertSecretSafeFailure(invocation, /failed to read back Keycloak realm login settings; status=503/)
  } finally {
    invocation.cleanup()
  }
})

// bbx-keycloak26-login-012 | fn-keycloak-26-realm-login-validation | OpenSpec #### Scenario: Malformed realm login configuration fails before any Keycloak mutation
test('explicitly null nested login authoring fails before Helm emits a manifest', () => {
  assertPreRenderFailure([
    '--set-json', 'bootstrap.oneShot.keycloak.realm.login=null',
  ], /bootstrap.+oneShot.+keycloak.+realm.+login/i)
})

// bbx-keycloak26-login-013 | fn-keycloak-26-realm-login-validation | OpenSpec #### Scenario: Malformed realm login configuration fails before any Keycloak mutation
test('top-level-only login authoring cannot replace the required nested source of truth', () => {
  assertPreRenderFailure([
    '--set-json', 'bootstrap.oneShot.keycloak.realm.login=null',
    ...unsupportedTopLevelLoginArgs,
  ], /bootstrap.+oneShot.+keycloak.+realm.+login/i)
})

function assertFreshRealmSuccess(scenario, createStatus) {
  const invocation = executeRenderedBootstrap(install, scenario)
  try {
    assert.equal(invocation.result.status, 0,
      `${scenario} failed:\n${combined(invocation.result)}`)
    assert.equal(initialRealmGets(invocation).length, 1,
      `${scenario} must discover the missing realm exactly once`)
    assert.equal(realmCreates(invocation).length, 1,
      `${scenario} must submit exactly one realm create POST`)
    assert.equal(loginPuts(invocation).length, 1,
      `${scenario} must perform mandatory login reconciliation after create`)
    assert.equal(loginReadbacks(invocation).length, 1,
      `${scenario} must read the five login settings back exactly once`)

    const trace = invocation.trace
    const initialGetIndex = trace.findIndex((call) => (
      call.source === 'curl' && initialRealmGets({ curlCalls: [call] }).length === 1
    ))
    const notFoundIndex = trace.findIndex((call) => (
      call.source === 'curl-response'
      && call.method === 'GET'
      && call.status === 404
      && call.url.endsWith('/admin/realms/in-falcone-platform')
    ))
    const createIndex = trace.findIndex((call) => (
      call.source === 'curl' && realmCreates({ curlCalls: [call] }).length === 1
    ))
    const createResponseIndex = trace.findIndex((call) => (
      call.source === 'curl-response'
      && call.method === 'POST'
      && call.status === createStatus
      && call.url.endsWith('/admin/realms')
    ))
    const loginPutIndex = trace.findIndex((call) => (
      call.source === 'curl' && loginPuts({ curlCalls: [call] }).length === 1
    ))
    const loginReadbackIndex = trace.findIndex((call) => (
      call.source === 'curl' && loginReadbacks({ curlCalls: [call] }).length === 1
    ))
    const verifyOffset = loginReadbackIndex + 1
    const verifyRelativeIndex = trace.slice(verifyOffset).findIndex((call) => (
      call.source === 'curl' && call.url.includes('/users?username=superadmin&exact=true')
    ))
    const verifyIndex = verifyRelativeIndex >= 0 ? verifyOffset + verifyRelativeIndex : -1
    const markerIndex = trace.findIndex((call) => (
      call.source === 'kubectl' && call.verb === 'create' && call.name === 'in-falcone-bootstrap-state'
    ))
    assert.ok(
      initialGetIndex >= 0
      && notFoundIndex > initialGetIndex
      && createIndex > notFoundIndex
      && createResponseIndex > createIndex
      && loginPutIndex > createResponseIndex
      && loginReadbackIndex > loginPutIndex
      && verifyIndex > loginReadbackIndex
      && markerIndex > verifyIndex,
      `${scenario} must order GET 404, POST ${createStatus}, login PUT/readback, verification, then marker`,
    )
    assert.deepEqual(
      invocation.curlCalls.filter((call) => call.method === 'DELETE' && call.url.includes('/admin/realms')),
      [],
      `${scenario} must not delete Keycloak state`,
    )
    assert.doesNotMatch(combined(invocation.result), /\bhelm\s+rollback\b/i,
      `${scenario} must not invoke rollback`)
  } finally {
    invocation.cleanup()
  }
}

function assertRetryableFreshRealmFailure(scenario, diagnostic, expectedGets, expectedCreates) {
  const first = executeRenderedBootstrap(install, scenario)
  const retry = executeRenderedBootstrap(install, scenario)
  try {
    assert.deepEqual(retry.curlCalls, first.curlCalls,
      `${scenario} retry must repeat the same bounded public interaction after no marker was written`)
    for (const invocation of [first, retry]) {
      assert.equal(initialRealmGets(invocation).length, expectedGets)
      assert.equal(realmCreates(invocation).length, expectedCreates)
      assertFreshRealmFailure(invocation, diagnostic)
    }
  } finally {
    first.cleanup()
    retry.cleanup()
  }
}

// bbx-keycloak26-login-014 | fn-keycloak-26-fresh-realm-create | OpenSpec #### Scenario: Fresh install sends Keycloak 26 login settings as top-level realm fields
test('fresh missing realm accepts create 201 only after mandatory login convergence', () => {
  assertFreshRealmSuccess('fresh-create-201', 201)
})

// bbx-keycloak26-login-015 | fn-keycloak-26-fresh-realm-conflict | OpenSpec #### Scenario: Fresh install sends Keycloak 26 login settings as top-level realm fields
test('fresh concurrent create 409 is not convergence proof and still requires login PUT/readback', () => {
  assertFreshRealmSuccess('fresh-create-409', 409)
})

// bbx-keycloak26-login-016 | fn-keycloak-26-fresh-realm-discovery-failure | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('initial realm GET transport failure is secret-safe, non-destructive, and retryable', () => {
  assertRetryableFreshRealmFailure(
    'fresh-get-transport-failure',
    /process-isolated Keycloak connection refused/,
    1,
    0,
  )
})

// bbx-keycloak26-login-017 | fn-keycloak-26-fresh-realm-discovery-failure | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('initial realm GET non-404 failure suppresses the provider body and remains retryable', () => {
  assertRetryableFreshRealmFailure(
    'fresh-get-http-failure',
    /unexpected status while checking realm: 503/,
    1,
    0,
  )
})

// bbx-keycloak26-login-018 | fn-keycloak-26-fresh-realm-create-failure | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('realm create transport failure is secret-safe, non-destructive, and retryable', () => {
  assertRetryableFreshRealmFailure(
    'fresh-create-transport-failure',
    /process-isolated Keycloak connection refused/,
    1,
    1,
  )
})

// bbx-keycloak26-login-019 | fn-keycloak-26-fresh-realm-create-failure | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('realm create non-201-or-409 failure suppresses the provider body and remains retryable', () => {
  assertRetryableFreshRealmFailure(
    'fresh-create-http-failure',
    /failed to create Keycloak realm; status=400/,
    1,
    1,
  )
})

function assertCorrectAndRetryDiagnostic(invocation, context) {
  const evidence = combined(invocation.result)
  assert.notEqual(invocation.result.status, 0, `${context} unexpectedly succeeded`)
  assert.ok(Buffer.byteLength(evidence) <= 4096,
    `${context} diagnostic must remain bounded, got ${Buffer.byteLength(evidence)} bytes`)
  assert.match(evidence, /\bin-falcone-platform\b/,
    `${context} diagnostic must identify the affected realm`)
  assert.match(evidence, /(?=[\s\S]*\bretry\b)(?=[\s\S]*\b(?:correct|resolve|repair|fix|fail[- ]forward)\b)/i,
    `${context} diagnostic must provide safe correct-and-retry or fail-forward guidance`)
  assert.doesNotMatch(evidence,
    /bbx-sensitive-provider-body|bbx-admin-password|bbx-superadmin-password|bbx-apisix-key|bbx-process-isolated-admin-token/,
    `${context} diagnostic exposed a provider body or credential`)
  assert.equal(markerWrites(invocation).length, 0,
    `${context} must not write the success marker`)
  assert.equal(invocation.curlCalls.filter((call) => call.url.includes('/clients?')).length, 0,
    `${context} must stop before later client verification`)
  assert.equal(invocation.curlCalls.filter((call) => call.url.includes('/users?')).length, 0,
    `${context} must stop before later user verification`)
  assert.deepEqual(
    invocation.curlCalls.filter((call) => call.method === 'DELETE' && call.url.includes('/admin/realms')),
    [],
    `${context} must not delete durable Keycloak state`,
  )
  assert.doesNotMatch(evidence, /\bhelm\s+rollback\b|\brollback initiated\b/i,
    `${context} must not initiate rollback`)
}

function executeDiagnosticScenario(scenario, context) {
  const invocation = executeRenderedBootstrap(install, scenario)
  try {
    assertCorrectAndRetryDiagnostic(invocation, context)
  } finally {
    invocation.cleanup()
  }
}

// bbx-keycloak26-login-020 | fn-keycloak-26-realm-payload-compatibility | OpenSpec #### Scenario: Fresh install sends Keycloak 26 login settings as top-level realm fields
test('non-zero legacy top-level realm fields retain precedence over nested partial settings', () => {
  // `false` is a Sprig zero value and was already ignored by the historical `merge`; it is not a
  // valid compatibility oracle. A non-zero collision distinguishes the public base behavior from
  // an accidental `mergeOverwrite`: the create payload keeps 99 while the reconcile partial keeps 10.
  const rendered = namedBootstrapArtifacts(render(umbrellaChart, [
    '--set', 'bootstrap.oneShot.keycloak.realm.failureFactor=99',
  ]).objects)
  const bruteForcePartial = JSON.parse(rendered.payloadConfig.data['brute-force.json'])
  assert.equal(rendered.realm.failureFactor, 99,
    'realm create payload must preserve the explicitly authored non-zero top-level value')
  assert.equal(bruteForcePartial.failureFactor, 10,
    'brute-force reconciliation partial must retain its independently authored nested value')
})

// bbx-keycloak26-login-021 | fn-keycloak-26-realm-failure-guidance | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('initial realm GET transport failure identifies the realm and provides correct-and-retry guidance', () => {
  executeDiagnosticScenario('fresh-get-transport-failure', 'initial realm GET transport failure')
})

// bbx-keycloak26-login-022 | fn-keycloak-26-realm-failure-guidance | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('initial realm GET HTTP failure identifies the realm with bounded fail-forward guidance', () => {
  executeDiagnosticScenario('fresh-get-http-failure', 'initial realm GET HTTP failure')
})

// bbx-keycloak26-login-023 | fn-keycloak-26-realm-failure-guidance | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('realm create transport failure identifies the realm and provides correct-and-retry guidance', () => {
  executeDiagnosticScenario('fresh-create-transport-failure', 'realm create transport failure')
})

// bbx-keycloak26-login-024 | fn-keycloak-26-realm-failure-guidance | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('realm create HTTP failure identifies the realm with bounded fail-forward guidance', () => {
  executeDiagnosticScenario('fresh-create-http-failure', 'realm create HTTP failure')
})

// bbx-keycloak26-login-025 | fn-keycloak-26-realm-login-failure-guidance | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('login PUT failure identifies the realm with bounded correct-and-retry guidance', () => {
  executeDiagnosticScenario('put-failure', 'login PUT failure')
})

// bbx-keycloak26-login-026 | fn-keycloak-26-realm-login-failure-guidance | OpenSpec #### Scenario: Realm bootstrap failures do not expose credentials or Secret values
test('login GET failure identifies the realm with bounded correct-and-retry guidance', () => {
  executeDiagnosticScenario('get-failure', 'login GET failure')
})

// bbx-keycloak26-login-027 | fn-keycloak-26-realm-login-failure-guidance | OpenSpec #### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
test('login readback drift identifies the realm with bounded correct-and-retry guidance', () => {
  executeDiagnosticScenario('drift', 'login readback drift')
})
