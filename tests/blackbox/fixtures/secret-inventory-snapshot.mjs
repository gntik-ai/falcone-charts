import assert from 'node:assert/strict'

// Check #1089's complete gateway addition before subtracting it from historical
// snapshots. Existing routes, policies and approved baseline hashes stay intact.
export function withPriorSecretInventory(objects) {
  const prior = structuredClone(objects)
  const payloads = prior.filter((object) => object.kind === 'ConfigMap'
    && object.data?.['route-2001-inventory.json'])
  assert.equal(payloads.length, 1, 'inventory must be rendered exactly once')
  const payload = payloads[0]
  const platform = JSON.parse(payload.data['route-2001.json'])
  const inventory = JSON.parse(payload.data['route-2001-inventory.json'])
  assert.deepEqual(inventory, {
    ...platform,
    name: 'public-api-secret-inventory',
    uri: '/v1/secrets/inventory',
    methods: ['GET', 'OPTIONS'],
  }, 'inventory must retain the complete platform upstream and safety policy')
  delete payload.data['route-2001-inventory.json']

  const policies = prior.filter((object) => object.kind === 'ConfigMap'
    && object.data?.['enabled-apisix-routes.json'])
  assert.equal(policies.length, 1, 'the enabled route inventory must remain present exactly once')
  const policy = policies[0]
  const routes = JSON.parse(policy.data['enabled-apisix-routes.json'])
  const additions = routes.filter((route) => route.name === 'public-api-secret-inventory'
    || route.routeId === '2001-inventory' || route.uri === '/v1/secrets/inventory')
  assert.deepEqual(additions, [{
    name: 'public-api-secret-inventory',
    routeId: '2001-inventory',
    uri: '/v1/secrets/inventory',
  }])
  const index = routes.indexOf(additions[0])
  assert.deepEqual(routes[index - 1], {
    name: 'public-api-platform', routeId: '2001', uri: '/v1/platform/*',
  }, 'only the reviewed insertion after the platform route is subtracted')
  routes.splice(index, 1)
  policy.data['enabled-apisix-routes.json'] = `\n${JSON.stringify(routes, null, 2)}\n`
  return prior
}
