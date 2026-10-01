import assert from 'node:assert/strict'
import test from 'node:test'

import { render, umbrellaChart } from './fixtures/blackbox.mjs'

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

for (const [name, overlay] of [['default', []], ['staging', ['-f', `${umbrellaChart}/values/staging.yaml`]]]) {
  test(`${name} Mongo bearer route enables issuer verification and keeps API key priority`, () => {
    const { objects, text, route, apiKey, gateway, executor } = rendered(overlay)
    assert.equal(route.uri, '/v1/mongo/*')
    assert.equal(route.priority, 234)
    assert.match(Object.keys(route.upstream.nodes)[0], /-control-plane-executor\./)
    assert.ok(route.plugins['issuer-jwks-auth'])
    assert.equal(route.plugins['openid-connect'], undefined)
    assert.deepEqual(Object.keys(route.plugins['issuer-jwks-auth'].issuers[0]).sort(), ['audiences', 'issuer', 'jwks_uri'])
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
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'KEYCLOAK_JWKS_URL'))
    assert.ok(executor.spec.template.spec.containers[0].env.some((item) => item.name === 'GATEWAY_SHARED_SECRET' && item.valueFrom?.secretKeyRef))
    assert.equal(text.includes('GATEWAY_SHARED_SECRET=') , false)
  })
}

test('an explicitly configured tenant realm is rendered without deriving an issuer from a token', () => {
  const issuers = [
    { issuer: 'https://iam.example/realms/in-falcone-platform', jwks_uri: 'https://iam.example/realms/in-falcone-platform/protocol/openid-connect/certs', audiences: ['in-falcone'] },
    { issuer: 'https://iam.example/realms/tenant-a', jwks_uri: 'https://iam.example/realms/tenant-a/protocol/openid-connect/certs', audiences: ['in-falcone'] },
  ]
  const { route } = rendered(['--set-json', `gatewayPolicy.issuerJwksAuth.issuers=${JSON.stringify(issuers)}`])
  assert.deepEqual(route.plugins['issuer-jwks-auth'].issuers, issuers)
})
