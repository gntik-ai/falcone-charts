import assert from 'node:assert/strict'

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
  return value
}

// Subtract only #1087's bounded route replacement from historical umbrella
// snapshots. The rendered-route suite verifies the full SSE policy separately.
export function withPriorRealtimeSse(objects) {
  const prior = structuredClone(objects)
  const payload = prior.find((object) => object.kind === 'ConfigMap' && object.data?.['route-public-api-realtime-collection-changes.json'])
  assert.ok(payload, 'the reviewed collection stream must be rendered')
  assert.equal(payload.data['route-2016-rt.json'], undefined, 'the legacy catch-all must be removed')
  let legacy
  for (const [source, pattern] of [
    ['collection', '^/v1/realtime/workspaces/[^/]+/data/[^/]+/collections/[^/]+/changes$'],
    ['table', '^/v1/realtime/workspaces/[^/]+/data/[^/]+/schemas/[^/]+/tables/[^/]+/changes$'],
  ]) {
    const name = `public-api-realtime-${source}-changes`
    const key = `route-${name}.json`
    const route = JSON.parse(payload.data[key])
    assert.equal(route.name, name)
    assert.deepEqual(route.methods, ['GET', 'OPTIONS'])
    assert.deepEqual(route.vars, [['uri', '~~', pattern]])
    assert.equal(route.labels['gateway.in-falcone.io/auth-mode'], 'query_api_key_sse')
    assert.equal(route.plugins.cors.allow_methods, 'GET,OPTIONS')
    assert.deepEqual(route.plugins['client-control'], { max_body_size: 1024 })
    assert.deepEqual(route.plugins['request-validation'], { header_schema: { type: 'object' } })
    assert.deepEqual(route.plugins['proxy-rewrite'], { headers: { set: {
      'x-auth-subject': '', 'x-actor-username': '', 'x-tenant-id': '', 'x-workspace-id': '',
      'x-plan-id': '', 'x-auth-scopes': '', 'x-actor-roles': '', 'x-gateway-auth': '${{GATEWAY_SHARED_SECRET}}',
    } } })
    route.name = 'public-api-realtime-changes'
    route.vars = [['uri', '~~', '/changes$']]
    delete route.labels['gateway.in-falcone.io/auth-mode']
    route.plugins.cors.allow_methods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    for (const plugin of ['client-control', 'request-validation', 'proxy-rewrite']) delete route.plugins[plugin]
    if (legacy) assert.deepEqual(route, legacy, 'both streams preserve the same pre-existing settings')
    legacy = route
    delete payload.data[key]
  }
  payload.data['route-2016-rt.json'] = `\n${JSON.stringify(sorted(legacy), null, 2)}\n`
  const config = prior.find((object) => object.kind === 'ConfigMap' && object.data?.['enabled-apisix-routes.json'])
  assert.ok(config, 'the enabled route inventory remains present')
  const inventory = JSON.parse(config.data['enabled-apisix-routes.json'])
  const first = inventory.findIndex((route) => route.name === 'public-api-realtime-collection-changes')
  assert.ok(first >= 0)
  assert.deepEqual(inventory.slice(first, first + 2), ['collection', 'table'].map((source) => {
    const name = `public-api-realtime-${source}-changes`
    return { routeId: name, name, uri: '/v1/realtime/*' }
  }))
  inventory.splice(first, 2, { routeId: '2016-rt', name: 'public-api-realtime-changes', uri: '/v1/realtime/*' })
  config.data['enabled-apisix-routes.json'] = `\n${JSON.stringify(sorted(inventory), null, 2)}\n`
  return prior
}
