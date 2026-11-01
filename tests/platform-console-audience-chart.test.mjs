import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { render, repoRoot, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const desiredMapper = {
  name: 'in-falcone-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: { 'included.custom.audience': 'in-falcone', 'access.token.claim': 'true', 'id.token.claim': 'false' },
}

let cachedObjects
function renderedObjects() {
  return cachedObjects ??= render(umbrellaChart).objects
}

function bootstrap(objects, scenario, runs = 1) {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-audience-'))
  try {
    const payload = resolve(work, 'payload')
    const bin = resolve(work, 'bin')
    mkdirSync(payload)
    mkdirSync(bin)
    const config = objects.find(o => o.kind === 'ConfigMap' && o.data?.['realm.json'])
    for (const [name, data] of Object.entries(config.data)) writeFileSync(resolve(payload, name), data)
    const program = objects.find(o => o.kind === 'ConfigMap' && o.data?.['bootstrap.sh']).data['bootstrap.sh']
    const marker = /^ONE_SHOT_HASH="([a-f0-9]{64})"$/m.exec(program)[1]
    // Redirect filesystem boundaries only; execute the entire published program unchanged otherwise.
    const script = program.replaceAll('/tmp/', `${work}/`)
      .replace('PAYLOAD_DIR="/bootstrap/payload"', `PAYLOAD_DIR="${payload}"`)
    writeFileSync(resolve(work, 'bootstrap.sh'), script)
    copyFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/jwt-policy-bootstrap/fake-curl.py'), resolve(bin, 'curl'))
    chmodSync(resolve(bin, 'curl'), 0o755)
    writeFileSync(resolve(bin, 'kubectl'), `#!/bin/bash
if [[ "$*" == *"get configmap in-falcone-bootstrap-lock"* ]]; then exit 1; fi
if [[ "$*" == *"get configmap in-falcone-bootstrap-state"* ]]; then echo '${marker}'; fi
if [[ "$*" == *"apply -f -"* ]]; then cat >/dev/null; echo marker >> '${work}/markers'; fi
`, { mode: 0o755 })
    const results = Array.from({ length: runs }, () => run('bash', [resolve(work, 'bootstrap.sh')], { timeout: 0, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, JWT_BOOTSTRAP_TEST_DIR: work,
      TMPDIR: scenario === 'missing-tmpdir' ? resolve(work, 'absent') : process.env.TMPDIR,
      JWT_BOOTSTRAP_TEST_SCENARIO: scenario, BOOTSTRAP_KEYCLOAK_ADMIN_USERNAME: 'fixture',
      BOOTSTRAP_KEYCLOAK_ADMIN_PASSWORD: 'fixture', BOOTSTRAP_SUPERADMIN_PASSWORD: 'fixture',
      BOOTSTRAP_APISIX_ADMIN_KEY: 'fixture',
    } }))
    const result = results.at(-1)
    return { ...result, calls: JSON.parse(readFileSync(resolve(work, 'calls.json'), 'utf8')),
      results, workDirs: readdirSync(work).filter(name => name.startsWith('console-audience.')),
      state: JSON.parse(readFileSync(resolve(work, 'state.json'), 'utf8')),
      markers: (() => { try { return readFileSync(resolve(work, 'markers'), 'utf8') } catch { return '' } })() }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

test('Keycloak 26 stored defaults converge and the second bootstrap performs no writes', () => {
  const result = bootstrap(renderedObjects(), 'kc26-defaults', 2)
  for (const invocation of result.results) {
    assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`)
    assert.match(invocation.stdout, /reconciled platform console audience mapper/)
  }
  assert.equal(result.calls.filter(c => c.method === 'POST' && c.url.includes('/protocol-mappers/')).length, 1)
  assert.equal(result.calls.filter(c => c.method === 'PUT' && c.url.includes('/protocol-mappers/')).length, 0)
  assert.equal(result.markers, 'marker\nmarker\n')
  assert.deepEqual(result.workDirs, [])
})

test('platform console gets the API audience on fresh provisioning and matching-marker upgrades', () => {
  const objects = renderedObjects()
  const payload = objects.find(o => o.kind === 'ConfigMap' && o.data?.['client-in-falcone-console.json'])
  assert.deepEqual(JSON.parse(payload.data['client-in-falcone-console.json']).protocolMappers, [desiredMapper])
  for (const scenario of ['missing', 'drift', 'converged']) {
    const result = bootstrap(objects, scenario)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.deepEqual(result.state.mapper, { ...desiredMapper, id: 'mapper-id' })
    assert.equal(result.calls.filter(c => c.method === 'POST').length, scenario === 'missing' ? 1 : 0)
    assert.equal(result.calls.filter(c => c.method === 'PUT' && c.url.includes('/protocol-mappers/')).length,
      scenario === 'drift' ? 1 : 0)
    assert.equal(result.markers, 'marker\n')
  }
})

test('provider metadata does not cause repeated audience mapper updates', () => {
  const result = bootstrap(renderedObjects(), 'provider-metadata')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.calls.filter(c => c.method === 'PUT' && c.url.includes('/protocol-mappers/')).length, 0)
})

test('failed mapper writes and readback drift prevent success without logging provider responses', () => {
  const objects = renderedObjects()
  for (const scenario of ['write-failure', 'readback-drift']) {
    const result = bootstrap(objects, scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.markers, '')
    assert.equal(result.stderr, `[bootstrap] console audience ${scenario === 'write-failure'
      ? 'write status=503' : 'readback-mismatch key=access.token.claim'}\n`)
    assert.doesNotMatch(result.stderr, /private-provider-response-must-not-escape|offline-fixture/)
    assert.ok(result.stderr.length < 1024)
  }
})

test('mapper reconciliation works when an inherited temporary directory is unavailable', () => {
  const result = bootstrap(renderedObjects(), 'missing-tmpdir')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.markers, 'marker\n')
})

function assertAudienceFailure(result, diagnostic) {
  assert.notEqual(result.status, 0)
  assert.equal(result.markers, '')
  assert.equal(result.stderr, `[bootstrap] console audience ${diagnostic}\n`)
  assert.ok(Buffer.byteLength(result.stderr) < 1024)
  assert.deepEqual(result.workDirs, [])
  // The full bootstrap emits these fixed messages before entering audience reconciliation.
  // Any output from the failing stage itself must use only the console audience prefix.
  const preamble = '[bootstrap] bootstrap marker already matches the current one-shot payload; skipping create-only phase\n'
    + '[bootstrap] running upgrade reconciliation phase\n'
    + '[bootstrap] reconciled Keycloak realm login settings\n'
  assert.ok(result.stdout.startsWith(preamble), result.stdout)
  for (const line of `${result.stdout.slice(preamble.length)}${result.stderr}`.trim().split('\n')) {
    assert.ok(line.startsWith('[bootstrap] console audience'), line)
  }
  assert.doesNotMatch(`${result.stdout}${result.stderr}`,
    /private-provider-response-must-not-escape|offline-fixture|Authorization|in-falcone/)
}

test('mapper lists and readbacks require exactly one valid JSON array', () => {
  const objects = renderedObjects()
  for (const stage of ['list', 'readback']) {
    for (const shape of ['empty-body', 'string', 'object', 'number', 'multiple', 'invalid-json', 'null']) {
      const result = bootstrap(objects, `${stage}-${shape}`)
      assertAudienceFailure(result, `${stage === 'list' ? 'list-mappers' : stage} invalid-shape`)
    }
  }
})

for (const [scenario, diagnostic] of [
  ['duplicate', 'duplicate'], ['readback-missing', 'readback-missing'],
  ['readback-duplicate', 'readback-duplicate'], ['invalid-id-list', 'list-mappers invalid-id'],
  ['invalid-id-readback-only', 'readback invalid-id'],
]) {
  test(`mapper cardinality and id validation: ${scenario}`, () => {
    const result = bootstrap(renderedObjects(), scenario)
    assertAudienceFailure(result, diagnostic)
    assert.equal(result.calls.filter(c => c.url.includes('/protocol-mappers/') && c.method !== 'GET').length, 0)
  })
}

for (const [scenario, diagnostic] of [
  ...['failure', 'transport', 'missing', 'duplicate', 'invalid-id', 'multiple', 'object', 'empty', 'invalid-json']
    .map(kind => [`lookup-${kind}`, 'lookup-client']),
  ['list-failure', 'list-mappers status=503'], ['list-transport', 'list-mappers status=000'],
  ['write-failure', 'write status=503'], ['write-transport', 'write status=000'],
  ['readback-failure', 'readback status=503'], ['readback-transport', 'readback status=000'],
  ...Object.keys(desiredMapper.config).flatMap(key => [
    [`readback-missing-key:${key}`, `readback-mismatch key=${key}`],
    [`readback-wrong-key:${key}`, `readback-mismatch key=${key}`],
  ]),
  ...['protocol', 'protocolMapper', 'consentRequired'].map(key => [
    `readback-field:${key}`, `readback-mismatch key=${key}`,
  ]),
  ['readback-boolean', 'readback-mismatch key=access.token.claim'],
  ['readback-invalid-shape', 'readback invalid-shape'],
  ['readback-missing-key', 'readback-mismatch key=included.custom.audience'],
  ...['null', '23', '""', '"unsafe/id"', '"line\\nfeed"', '"trailing\\n"'].map(id => [`readback-id:${id}`, 'readback invalid-id']),
]) {
  test(`provider failure has a bounded fixed diagnostic: ${scenario}`, () => {
    assertAudienceFailure(bootstrap(renderedObjects(), scenario), diagnostic)
  })
}

test('each desired config key is repaired with one targeted PUT and no other mapper mutation', () => {
  for (const scenario of ['wrong-audience', ...Object.keys(desiredMapper.config).flatMap(key => [
    `missing-key:${key}`, `wrong-key:${key}`,
  ])]) {
    const result = bootstrap(renderedObjects(), scenario)
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    const writes = result.calls.filter(call => call.url.includes('/protocol-mappers/') && call.method !== 'GET')
    assert.deepEqual(writes, [{ method: 'PUT',
      url: 'http://falcone-bbx-keycloak.falcone-bbx.svc.cluster.local:8080/admin/realms/in-falcone-platform/clients/client-id/protocol-mappers/models/mapper-id',
      payload: { ...desiredMapper, id: 'mapper-id' },
    }])
    assert.equal(result.markers, 'marker\n')
    assert.deepEqual(result.workDirs, [])
  }
})

test('a converged mapper with provider config and metadata performs zero writes', () => {
  const result = bootstrap(renderedObjects(), 'converged-extras')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.deepEqual(result.calls.filter(call => call.url.includes('/protocol-mappers/') && call.method !== 'GET'), [])
  assert.equal(result.markers, 'marker\n')
  assert.match(result.stdout, /reconciled platform console audience mapper/)
  assert.deepEqual(result.workDirs, [])
})
