import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { render, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const profile = {
  tokenEndpoint: 'https://identity.example.test/oauth/token',
  audience: 'https://provider.example.test',
  tenantAllowList: ['tenant-a'],
  grantType: 'token-exchange',
}

function withValues(values, fn) {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-provider-identity-'))
  try {
    const file = resolve(directory, 'values.json')
    writeFileSync(file, JSON.stringify({ controlPlaneExecutor: values }))
    return fn(['-f', file])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('executor receives named profiles and an opt-in audience-bound projected token without new Secrets', () => {
  const baseline = render(umbrellaChart)
  withValues({
    llmIdentityProfiles: { provider: profile },
    llmIdentityToken: { enabled: true, audience: 'cloud-token-exchange', expirationSeconds: 1800 },
  }, args => {
    const { objects } = render(umbrellaChart, args)
    const deployment = objects.find(object => object.kind === 'Deployment'
      && object.metadata.name === 'falcone-bbx-control-plane-executor')
    const pod = deployment.spec.template.spec
    const container = pod.containers[0]
    const env = container.env.filter(entry => entry.name === 'LLM_IDENTITY_PROFILES')
    assert.equal(env.length, 1, 'broker must receive exactly one profile map')
    assert.deepEqual(JSON.parse(env[0].value), { provider: profile })
    assert.deepEqual(pod.volumes.find(volume => volume.name === 'llm-identity-token'), {
      name: 'llm-identity-token',
      projected: { defaultMode: 292, sources: [{ serviceAccountToken: {
        audience: 'cloud-token-exchange', expirationSeconds: 1800, path: 'token',
      } }] },
    })
    assert.deepEqual(container.volumeMounts.find(mount => mount.name === 'llm-identity-token'), {
      name: 'llm-identity-token', mountPath: '/var/run/secrets/falcone/llm-identity', readOnly: true,
    })
    for (const other of objects.filter(object => object !== deployment)) {
      assert.ok(!JSON.stringify(other).includes('cloud-token-exchange'), 'projection must be executor-only')
    }
    for (const sidecar of [...(pod.initContainers ?? []), ...pod.containers.slice(1)]) {
      assert.ok(!(sidecar.volumeMounts ?? []).some(mount => mount.name === 'llm-identity-token'))
    }
    const secrets = objects => objects.filter(object => ['Secret', 'ExternalSecret'].includes(object.kind))
    assert.deepEqual(secrets(objects), secrets(baseline.objects), 'existing ESO and Secret wiring must be unchanged')
  })
})

test('empty or absent identity settings preserve the default render byte for byte', () => {
  const baseline = render(umbrellaChart)
  for (const values of [
    { llmIdentityProfiles: {}, llmIdentityToken: { enabled: false } },
    { llmIdentityProfiles: null, llmIdentityToken: null },
  ]) {
    withValues(values, args => assert.equal(render(umbrellaChart, args).text, baseline.text))
  }
  assert.ok(!baseline.text.includes('LLM_IDENTITY_PROFILES'))
  assert.ok(!baseline.text.includes('llm-identity-token'))
})

test('profiles do not implicitly enable a service-account projection', () => {
  withValues({ llmIdentityProfiles: { provider: { ...profile, grantType: 'jwt-bearer' } } }, args => {
    const { objects, text } = render(umbrellaChart, args)
    const executor = objects.find(object => object.kind === 'Deployment'
      && object.metadata.name === 'falcone-bbx-control-plane-executor')
    const env = executor.spec.template.spec.containers[0].env
    assert.deepEqual(JSON.parse(env.find(entry => entry.name === 'LLM_IDENTITY_PROFILES').value), {
      provider: { ...profile, grantType: 'jwt-bearer' },
    })
    assert.ok(!text.includes('llm-identity-token'))
  })
})

test('an enabled identity projection requires an explicit audience', () => {
  withValues({ llmIdentityToken: { enabled: true } }, args => {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, ...args])
    assert.notEqual(result.status, 0, 'projection without audience must fail closed')
    assert.match(result.stderr, /llmIdentityToken.audience/)
  })
})

test('identity configuration rejects missing tenant lists, credential fields, unsupported grants and invalid projections', () => {
  const { tenantAllowList, ...withoutTenants } = profile
  for (const values of [
    { llmIdentityProfiles: { provider: withoutTenants } },
    { llmIdentityProfiles: { provider: { ...profile, clientSecret: 'forbidden-inline-value' } } },
    { llmIdentityProfiles: { provider: { ...profile, grantType: 'authorization_code' } } },
    { llmIdentityToken: { enabled: 'true', audience: 'exchange' } },
    { llmIdentityToken: { enabled: true, audience: 'exchange', expirationSeconds: 1 } },
  ]) {
    withValues(values, args => {
      const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, ...args])
      assert.notEqual(result.status, 0, 'invalid identity configuration must be rejected')
      assert.equal(result.stdout.trim(), '', 'invalid configuration must render no resources')
    })
  }
})
