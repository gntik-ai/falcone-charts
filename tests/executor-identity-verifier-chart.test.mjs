import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { render, repoRoot, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const verifierKeys = [
  'KEYCLOAK_ISSUER', 'KEYCLOAK_JWKS_URL', 'KEYCLOAK_AUDIENCE',
  'KEYCLOAK_TRUSTED_REALM_BASES', 'KEYCLOAK_PLATFORM_REALM', 'KEYCLOAK_PLATFORM_AUDIENCES',
  'KEYCLOAK_TENANT_AUDIENCE', 'KEYCLOAK_ENFORCE_TENANT_AUDIENCE', 'KEYCLOAK_ALLOW_TENANT_REALMS',
]

test('both JWT verifiers consume one exact issuer and audience policy across deployment profiles', () => {
  for (const [args, internalBase] of [
    [[], 'http://falcone-bbx-keycloak:8080/realms/'],
    [['-f', resolve(umbrellaChart, 'values/staging-argocd.yaml')], 'http://falcone-bbx-keycloak:8080/realms/'],
    [['-f', resolve(umbrellaChart, 'values/kind-quickstart.yaml')], 'http://falcone-bbx-keycloak:8080/realms/'],
    [['-f', resolve(repoRoot, 'deploy/kind/values-production.yaml')], 'https://falcone-keycloak:8443/realms/'],
  ]) {
    const { objects } = render(umbrellaChart, args)
    const config = objects.find(o => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-executor-jwt-config')
    assert.deepEqual(JSON.parse(config.data.KEYCLOAK_PLATFORM_AUDIENCES), ['in-falcone', 'account'])
    assert.equal(config.data.KEYCLOAK_PLATFORM_REALM, 'in-falcone-platform')
    assert.equal(config.data.KEYCLOAK_ALLOW_TENANT_REALMS, '1')
    const bases = JSON.parse(config.data.KEYCLOAK_TRUSTED_REALM_BASES)
    assert.ok(bases.includes(`${config.data.KEYCLOAK_ISSUER.replace(/\/realms\/[^/]+$/, '')}/realms/`))
    assert.ok(bases.includes(internalBase))
    const checksums = []
    for (const component of ['control-plane', 'control-plane-executor']) {
      const deployment = objects.find(o => o.kind === 'Deployment' && o.metadata.name === `falcone-bbx-${component}`)
      const env = deployment.spec.template.spec.containers[0].env
      for (const name of verifierKeys) {
        assert.equal(typeof config.data[name], 'string', name)
        assert.deepEqual(env.filter(e => e.name === name), [{ name, valueFrom: {
          configMapKeyRef: { name: config.metadata.name, key: name },
        } }], `${component}: ${name}`)
      }
      checksums.push(deployment.spec.template.metadata.annotations['in-falcone.io/issuer-config-checksum'])
    }
    assert.match(checksums[0], /^[a-f0-9]{64}$/)
    assert.equal(checksums[0], checksums[1])
  }
})

test('strict rollout settings and exact custom realm bases reach both verifiers', () => {
  const args = ['--set-string', 'gatewayPolicy.issuerJwksAuth.issuerBaseUrl=https://identity.example.test/auth',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.jwksBaseUrl=http://internal.example.test:8080/auth',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.platformRealm=custom-platform',
    '--set-json', 'gatewayPolicy.issuerJwksAuth.platformAudiences=["in-falcone"]',
    '--set', 'gatewayPolicy.issuerJwksAuth.allowTenantRealms=false',
    '--set', 'gateway.mongoBearer.enforceTenantAudience=false']
  const { objects } = render(umbrellaChart, args)
  const config = objects.find(o => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-executor-jwt-config')
  assert.deepEqual(JSON.parse(config.data.KEYCLOAK_TRUSTED_REALM_BASES), [
    'https://identity.example.test/auth/realms/', 'http://internal.example.test:8080/auth/realms/',
  ])
  assert.deepEqual(JSON.parse(config.data.KEYCLOAK_PLATFORM_AUDIENCES), ['in-falcone'])
  assert.equal(config.data.KEYCLOAK_PLATFORM_REALM, 'custom-platform')
  assert.equal(config.data.KEYCLOAK_ALLOW_TENANT_REALMS, '0')
  assert.equal(config.data.KEYCLOAK_ENFORCE_TENANT_AUDIENCE, 'false')
  assert.equal(config.data.KEYCLOAK_TENANT_AUDIENCE, 'falcone-data-api')
  const baseline = render(umbrellaChart).objects
  for (const component of ['control-plane', 'control-plane-executor']) {
    const select = docs => docs.find(o => o.kind === 'Deployment' && o.metadata.name === `falcone-bbx-${component}`)
    assert.notEqual(select(objects).spec.template.metadata.annotations['in-falcone.io/issuer-config-checksum'],
      select(baseline).spec.template.metadata.annotations['in-falcone.io/issuer-config-checksum'])
  }
})

test('prod TLS trusts the effective HTTPS JWKS base without the stale HTTP alias', () => {
  const { objects } = render(umbrellaChart, [
    '-f', resolve(umbrellaChart, 'values/prod.yaml'),
    '-f', resolve(repoRoot, 'deploy/kind/values-production.yaml'),
  ])
  const config = objects.find(o => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-executor-jwt-config')
  assert.equal(config.data.KEYCLOAK_JWKS_URL,
    'https://falcone-keycloak:8443/realms/in-falcone-platform/protocol/openid-connect/certs')
  assert.deepEqual(JSON.parse(config.data.KEYCLOAK_TRUSTED_REALM_BASES), [
    'https://iam.in-falcone.example.com/realms/', 'https://falcone-keycloak:8443/realms/',
  ])
})

test('invalid explicit audience lists and tenant realm switches fail closed during rendering', () => {
  for (const value of ['platformAudiences=[]', 'platformAudiences=[""]', 'platformAudiences=[1]',
    'platformAudiences="account"', 'allowTenantRealms="false"']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
      '--set-json', `gatewayPolicy.issuerJwksAuth.${value}`])
    assert.notEqual(result.status, 0, value)
    assert.match(result.stderr, /gatewayPolicy\.issuerJwksAuth\.(platformAudiences|allowTenantRealms)/)
  }
})

test('changing the API audience keeps the default platform list and console mapper aligned', () => {
  const { objects } = render(umbrellaChart, ['--set-string', 'gatewayPolicy.issuerJwksAuth.audience=custom-api'])
  const config = objects.find(o => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-executor-jwt-config')
  assert.equal(config.data.KEYCLOAK_AUDIENCE, 'custom-api')
  assert.deepEqual(JSON.parse(config.data.KEYCLOAK_PLATFORM_AUDIENCES), ['custom-api', 'account'])
  const payload = objects.find(o => o.kind === 'ConfigMap' && o.data?.['console-audience-mapper.json'])
  assert.equal(JSON.parse(payload.data['console-audience-mapper.json']).config['included.custom.audience'], 'custom-api')
})

function executorEnv(objects) {
  const deployment = objects.find(object => object.kind === 'Deployment'
    && object.metadata.name === 'falcone-bbx-control-plane-executor')
  assert.ok(deployment, 'executor Deployment must render')
  return deployment.spec.template.spec.containers[0].env
}

for (const [profile, args] of [
  ['default', []],
  ['staging', ['-f', resolve(umbrellaChart, 'values/staging-argocd.yaml')]],
]) {
  test(`${profile} configures JWT verification without the development opt-in`, () => {
    const { objects } = render(umbrellaChart, args)
    const config = objects.find(object => object.kind === 'ConfigMap'
      && object.metadata.name === 'falcone-bbx-executor-jwt-config')
    assert.ok(config, 'executor JWT ConfigMap must render')
    assert.equal(typeof config.data.KEYCLOAK_JWKS_URL, 'string')
    assert.ok(config.data.KEYCLOAK_JWKS_URL.trim().length > 0, 'executor JWKS URL must be non-empty')
    const env = executorEnv(objects)
    assert.deepEqual(env.filter(entry => entry.name === 'KEYCLOAK_JWKS_URL'), [{
      name: 'KEYCLOAK_JWKS_URL',
      valueFrom: { configMapKeyRef: { name: config.metadata.name, key: 'KEYCLOAK_JWKS_URL' } },
    }])
    assert.equal(env.some(entry => entry.name === 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY'), false)
  })
}

test('kind-advanced explicitly permits unverified identity for local development', () => {
  const { objects } = render(umbrellaChart, [
    '-f', resolve(repoRoot, 'deploy/kind/values-kind.yaml'),
    '-f', resolve(repoRoot, 'deploy/kind/values-kind-advanced.yaml'),
  ])
  assert.deepEqual(executorEnv(objects).filter(entry => entry.name === 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY'),
    [{ name: 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY', value: 'true' }])
})
