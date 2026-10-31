import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { render, repoRoot, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const desiredMapper = {
  name: 'in-falcone-audience', protocol: 'openid-connect', protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: { 'included.custom.audience': 'in-falcone', 'access.token.claim': 'true', 'id.token.claim': 'false' },
}

function bootstrap(objects, scenario) {
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
    const result = run('bash', [resolve(work, 'bootstrap.sh')], { timeout: 0, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, JWT_BOOTSTRAP_TEST_DIR: work,
      JWT_BOOTSTRAP_TEST_SCENARIO: scenario, BOOTSTRAP_KEYCLOAK_ADMIN_USERNAME: 'fixture',
      BOOTSTRAP_KEYCLOAK_ADMIN_PASSWORD: 'fixture', BOOTSTRAP_SUPERADMIN_PASSWORD: 'fixture',
      BOOTSTRAP_APISIX_ADMIN_KEY: 'fixture',
    } })
    return { ...result, calls: JSON.parse(readFileSync(resolve(work, 'calls.json'), 'utf8')),
      state: JSON.parse(readFileSync(resolve(work, 'state.json'), 'utf8')),
      markers: (() => { try { return readFileSync(resolve(work, 'markers'), 'utf8') } catch { return '' } })() }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

test('platform console gets the API audience on fresh provisioning and matching-marker upgrades', () => {
  const { objects } = render(umbrellaChart)
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
  const result = bootstrap(render(umbrellaChart).objects, 'provider-metadata')
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.equal(result.calls.filter(c => c.method === 'PUT' && c.url.includes('/protocol-mappers/')).length, 0)
})

test('failed mapper writes and readback drift prevent success without logging provider responses', () => {
  const { objects } = render(umbrellaChart)
  for (const scenario of ['write-failure', 'readback-drift']) {
    const result = bootstrap(objects, scenario)
    assert.notEqual(result.status, 0)
    assert.equal(result.markers, '')
    assert.match(result.stderr, /console audience mapper did not converge/)
    assert.doesNotMatch(result.stderr, /private-provider-response-must-not-escape|offline-fixture/)
    assert.ok(result.stderr.length < 1024)
  }
})
