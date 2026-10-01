import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render, umbrellaChart, repoRoot, run, sha256, yamlDocuments } from '../fixtures/blackbox.mjs'

function rendered(overlay = []) {
  const { objects, text } = render(umbrellaChart, overlay)
  const payload = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['route-2006.json'])
  assert.ok(payload, 'bootstrap route payload is rendered')
  const route = JSON.parse(payload.data['route-2006.json'])
  const apiKey = JSON.parse(payload.data['route-2006-key.json'])
  const gateway = objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
  const executor = objects.find((object) => object.kind === 'Deployment' && /-control-plane-executor$/.test(object.metadata.name))
  return { objects, text, route, apiKey, gateway, executor }
}

function executorEnv(objects, executor) {
  return Object.fromEntries(executor.spec.template.spec.containers[0].env.map((item) => {
    const ref = item.valueFrom?.configMapKeyRef
    if (!ref) return [item.name, item.value]
    const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === ref.name)
    assert.ok(config?.data?.[ref.key], `${item.name}: referenced configuration must be rendered`)
    return [item.name, config.data[ref.key]]
  }))
}

for (const [name, overlay] of [['default', []], ['staging', ['-f', `${umbrellaChart}/values/staging.yaml`]], ['prod', ['-f', `${umbrellaChart}/values/prod.yaml`]]]) {
  test(`${name} Mongo bearer route enables issuer verification and keeps API key priority`, () => {
    const { objects, text, route, apiKey, gateway, executor } = rendered(overlay)
    assert.equal(route.uri, '/v1/mongo/*')
    assert.equal(route.priority, 234)
    assert.match(Object.keys(route.upstream.nodes)[0], /-control-plane-executor\./)
    assert.ok(route.plugins['issuer-jwks-auth'])
    assert.equal(route.plugins['openid-connect'], undefined)
    assert.deepEqual(Object.keys(route.plugins['issuer-jwks-auth']).sort(), [
      'issuer_base_url', 'jwks_base_url', 'platform_realm', 'audience', 'cache_ttl', 'cache_max_entries', 'timeout',
    ].sort())
    assert.equal(route.plugins['issuer-jwks-auth'].cache_max_entries, 128)
    assert.equal(route.plugins['issuer-jwks-auth'].cache_ttl, 300)
    assert.equal(route.plugins['limit-count'].rejected_code, 429)
    assert.ok(route.plugins['client-control'].max_body_size > 0)
    assert.ok(route.plugins['request-validation'].header_schema.properties['X-Tenant-Id'].maxLength === 0)
    assert.deepEqual(route.plugins['proxy-rewrite'].headers.remove, [
      'x-tenant-id', 'x-workspace-id', 'x-auth-subject', 'x-actor-roles',
    ])
    assert.equal(route.plugins['proxy-rewrite'].headers.set['x-gateway-auth'], '${{GATEWAY_SHARED_SECRET}}')
    assert.equal(route.plugins['proxy-rewrite'].headers.set['X-Correlation-Id'], '$http_x_correlation_id')
    assert.equal(route.plugins['proxy-rewrite'].headers.set['X-Request-Id'], '$request_id')
    assert.equal(apiKey.priority, 334)
    assert.deepEqual(apiKey.vars, [['http_apikey', '~~', '^flc_']])
    assert.equal(apiKey.plugins['limit-count'].key, '$http_apikey')
    assert.equal(apiKey.plugins['issuer-jwks-auth'], undefined)

    const plugin = objects.find((object) => object.kind === 'ConfigMap' && /-issuer-jwks-auth$/.test(object.metadata.name))
    const config = objects.find((object) => object.kind === 'ConfigMap' && /-apisix-config-file$/.test(object.metadata.name))
    assert.match(plugin.data['issuer-jwks-auth.lua'], /function plugin\.rewrite/)
    assert.match(config.data['config.yaml'], /- issuer-jwks-auth/)
    assert.match(config.data['config.yaml'], /extra_lua_path: \/usr\/local\/apisix\/falcone\/\?\.lua/)
    const mounts = gateway.spec.template.spec.containers[0].volumeMounts
    assert.ok(mounts.some((mount) => mount.mountPath.endsWith('/apisix/plugins/issuer-jwks-auth.lua')))
    const volumes = new Set(gateway.spec.template.spec.volumes.map((volume) => volume.name))
    if (name === 'staging') {
      const verifierVolume = gateway.spec.template.spec.volumes.find((volume) => volume.name === 'issuer-jwks-auth')
      assert.equal(verifierVolume.configMap.defaultMode, 420)
    }
    for (const container of [...gateway.spec.template.spec.initContainers, ...gateway.spec.template.spec.containers]) {
      for (const mount of container.volumeMounts ?? []) {
        assert.ok(volumes.has(mount.name), `${name}: ${container.name} mounts missing volume ${mount.name}`)
      }
    }
    assert.ok(mounts.some((mount) => mount.mountPath === '/usr/local/apisix/conf/config.yaml'))
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'KEYCLOAK_JWKS_URL'))
    const env = executorEnv(objects, executor)
    const verifier = route.plugins['issuer-jwks-auth']
    const policyConfig = objects.find((object) => object.kind === 'ConfigMap' && /-gateway-policy$/.test(object.metadata.name))
    const policyVerifier = JSON.parse(policyConfig.data['gateway-policy.json']).issuerJwksAuth
    assert.equal(policyVerifier.issuerBaseUrl, verifier.issuer_base_url)
    assert.equal(policyVerifier.jwksBaseUrl, verifier.jwks_base_url)
    assert.equal(env.KEYCLOAK_ISSUER, `${verifier.issuer_base_url}/realms/${verifier.platform_realm}`)
    assert.equal(env.KEYCLOAK_JWKS_URL, `${verifier.jwks_base_url}/realms/${verifier.platform_realm}/protocol/openid-connect/certs`)
    assert.equal(env.KEYCLOAK_AUDIENCE, verifier.audience)
    if (name === 'staging' || name === 'prod') {
      assert.doesNotMatch(env.KEYCLOAK_ISSUER, /iam\.dev\./)
      assert.doesNotMatch(verifier.issuer_base_url, /iam\.dev\./)
    }
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'GATEWAY_SHARED_SECRET' && item.valueFrom?.secretKeyRef))
    assert.equal(text.includes('GATEWAY_SHARED_SECRET=') , false)
  })
}

test('kind mounts the verifier, config overlay, and all init-container volumes', () => {
  const { objects } = render(umbrellaChart, ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`])
  const gateway = objects.find((object) => object.kind === 'Deployment' && /-apisix$/.test(object.metadata.name))
  const pod = gateway.spec.template.spec
  const volumes = new Set(pod.volumes.map((volume) => volume.name))
  for (const required of ['standalone-config', 'apisix-config-source', 'apisix-config-overlay', 'issuer-jwks-auth']) {
    assert.ok(volumes.has(required), `missing kind APISIX volume ${required}`)
  }
  for (const container of [...pod.initContainers, ...pod.containers]) {
    for (const mount of container.volumeMounts ?? []) {
      assert.ok(volumes.has(mount.name), `${container.name} mounts missing volume ${mount.name}`)
    }
  }
  const mounts = pod.containers[0].volumeMounts.map((mount) => mount.mountPath)
  assert.ok(mounts.includes('/usr/local/apisix/conf/config.yaml'))
  assert.ok(mounts.includes('/usr/local/apisix/falcone/apisix/plugins/issuer-jwks-auth.lua'))
  const config = objects.find((object) => object.kind === 'ConfigMap' && /-apisix-config-file$/.test(object.metadata.name))
  assert.match(config.data['config.yaml'], /- issuer-jwks-auth/)
})

test('staging standalone, bootstrap and executor use every configured verifier setting', () => {
  const { objects, route, executor } = rendered([
    '-f', `${umbrellaChart}/values/staging.yaml`,
    '--set-string', 'gatewayPolicy.issuerJwksAuth.issuerBaseUrl=https://iam.example.test/auth/',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.jwksBaseUrl=http://keycloak.internal:8080/',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.platformRealm=custom-platform',
    '--set-string', 'gatewayPolicy.issuerJwksAuth.audience=custom-api',
    '--set', 'gatewayPolicy.issuerJwksAuth.cache_ttl=60',
    '--set', 'gatewayPolicy.issuerJwksAuth.cache_max_entries=4',
    '--set', 'gatewayPolicy.issuerJwksAuth.timeout=2',
  ])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  const standalone = yamlDocuments(config.data['apisix.yaml'])[0]
  const verifier = route.plugins['issuer-jwks-auth']
  assert.deepEqual(standalone.routes.find((entry) => String(entry.id) === '2006').plugins['issuer-jwks-auth'], verifier)
  assert.deepEqual(verifier, {
    issuer_base_url: 'https://iam.example.test/auth', jwks_base_url: 'http://keycloak.internal:8080',
    platform_realm: 'custom-platform', audience: 'custom-api', cache_ttl: 60, cache_max_entries: 4, timeout: 2,
  })
  const env = executorEnv(objects, executor)
  assert.equal(env.KEYCLOAK_ISSUER, `${verifier.issuer_base_url}/realms/custom-platform`)
  assert.equal(env.KEYCLOAK_JWKS_URL, `${verifier.jwks_base_url}/realms/custom-platform/protocol/openid-connect/certs`)
  assert.equal(env.KEYCLOAK_AUDIENCE, verifier.audience)
  const policy = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['gateway-policy.json'])
  const policyVerifier = JSON.parse(policy.data['gateway-policy.json']).issuerJwksAuth
  assert.equal(policyVerifier.issuerBaseUrl, verifier.issuer_base_url)
  assert.equal(policyVerifier.jwksBaseUrl, verifier.jwks_base_url)

  const canonical = yamlDocuments(readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8'))[0]
  const withoutBearerRoute = (routes) => routes.filter((entry) => String(entry.id) !== '2006')
  assert.deepEqual(withoutBearerRoute(standalone.routes), withoutBearerRoute(canonical.routes.map((entry) =>
    JSON.parse(JSON.stringify(entry).replaceAll('.falcone.svc.cluster.local', '.falcone-bbx.svc.cluster.local')))))
})

test('all verifier settings are required at render time', () => {
  for (const key of ['issuerBaseUrl', 'jwksBaseUrl', 'platformRealm', 'audience', 'cache_ttl', 'cache_max_entries', 'timeout']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
      '-f', `${umbrellaChart}/values/staging.yaml`, '--set', `gatewayPolicy.issuerJwksAuth.${key}=`])
    assert.notEqual(result.status, 0, `${key} must be required`)
    assert.ok(result.stderr.includes(`issuerJwksAuth.${key} is required`), result.stderr)
  }
  for (const [key, setting] of [['keycloakIssuerBaseUrl', 'issuerBaseUrl'], ['keycloakJwksBaseUrl', 'jwksBaseUrl']]) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', `global.${key}=`])
    assert.notEqual(result.status, 0)
    assert.ok(result.stderr.includes(`issuerJwksAuth.${setting} is required`), result.stderr)
  }
})

test('staging standalone routes preserve the recorded pre-980 routes except route 2006', () => {
  const renderedStaging = run('helm', [
    'template', 'falcone', umbrellaChart, '--namespace', 'in-falcone-staging',
    '-f', `${umbrellaChart}/values/staging.yaml`,
  ])
  assert.equal(renderedStaging.status, 0, renderedStaging.stderr)
  const objects = yamlDocuments(renderedStaging.stdout)
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.ok(config)
  const baseline = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/mongo-staging-routes-before-980.yaml'), 'utf8')
  assert.equal(sha256(baseline), '445c3b628e904ece2a1c31b86b141966b87d65fda886cb9be66473cf6afe1bd5',
    'recorded pre-980 staging route fixture changed')
  // The operator reports that the live ConfigMap is this kind route table plus
  // the hand-applied llmwiki route. That live-only route is deliberately absent.
  const canonical = readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8')
  const recordedHash = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/mongo-staging-routes.sha256'), 'utf8').split(' ')[0]
  assert.equal(sha256(canonical), recordedHash, 'canonical staging route snapshot changed without a baseline update')
  const current = canonical
    .replaceAll('.falcone.svc.cluster.local', '.in-falcone-staging.svc.cluster.local')
    .replace('issuer_base_url: "http://falcone-keycloak:8080"', 'issuer_base_url: "https://iam.baas.musematic.ai/auth"')
  const route2006 = (routes) => {
    const match = routes.match(/^  - id: "2006"\n[\s\S]*?(?=^  - id: "2007")/m)
    assert.ok(match, 'route 2006 must be bounded by route 2007')
    return match[0]
  }
  const expected = baseline.replace(route2006(baseline), route2006(current))
  assert.notEqual(route2006(baseline), route2006(current), 'route 2006 must change')
  assert.equal(config.data['apisix.yaml'].trim(), expected.trim())
  assert.doesNotMatch(config.data['apisix.yaml'], /llmwiki-s2-mongo-jwt/)
  assert.match(config.data['apisix.yaml'], /falcone-control-plane-executor\.in-falcone-staging\.svc\.cluster\.local:8080/)
})
