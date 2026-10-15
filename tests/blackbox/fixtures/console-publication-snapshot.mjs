import assert from 'node:assert/strict'

// Subtract only #1095's five reviewed routes and policies; keep the historical golden hash
// and every existing route's complete policy under the original assertions.
export function withPriorConsolePublication(objects) {
  const prior = structuredClone(objects)
  const payload = prior.find((object) => object.kind === 'ConfigMap' && object.data?.['route-2002.json'])
  assert.ok(payload, 'the bootstrap route payload must remain present')
  const additions = [
    ['plans', 'plans', 'none'],
    ['quota-dimensions', 'quota-dimensions', 'none'],
    ['tenant-plan', 'tenant', 'required'],
    ['console', 'console', 'none'],
    ['async-operation-query', 'async-operation-query', 'required'],
  ]
  for (const [family, prefix, binding] of additions) {
    const reference = JSON.parse(payload.data[binding === 'none' ? 'route-2001.json' : 'route-2002.json'])
    const key = `route-2002-${family}.json`
    assert.deepEqual(JSON.parse(payload.data[key]), {
      ...reference,
      name: `public-api-${family}`,
      uri: `/v1/${prefix}/*`,
      priority: 238,
      labels: { ...reference.labels, 'gateway.in-falcone.io/family': family },
    }, `${family} must retain the complete reviewed upstream and safety policy`)
    delete payload.data[key]
  }
  const config = prior.find((object) => object.kind === 'ConfigMap' && object.data?.['enabled-apisix-routes.json'])
  assert.ok(config, 'the enabled route inventory must remain present')
  const inventory = JSON.parse(config.data['enabled-apisix-routes.json'])
  const first = inventory.findIndex((route) => route.routeId === '2002-plans')
  assert.ok(first >= 0)
  assert.deepEqual(inventory.slice(first, first + 5), additions.map(([family, prefix]) => ({
    name: `public-api-${family}`, routeId: `2002-${family}`, uri: `/v1/${prefix}/*`,
  })))
  inventory.splice(first, 5)
  config.data['enabled-apisix-routes.json'] = `\n${JSON.stringify(inventory, null, 2)}\n`
  const policy = JSON.parse(config.data['gateway-policy.json'])
  for (const [family, , tenantBinding] of additions) {
    const profile = tenantBinding === 'none' ? 'platform_control' : 'tenant_control'
    assert.deepEqual(policy.familyPolicies[family], {
      tenantBinding,
      workspaceBinding: 'none',
      qosProfile: profile,
      requestValidationProfile: profile,
      planCapabilityAnyOf: [],
    }, `${family} must retain the complete reviewed family policy`)
    delete policy.familyPolicies[family]
  }
  config.data['gateway-policy.json'] = `${JSON.stringify(policy, null, 2)}\n`
  return prior
}
