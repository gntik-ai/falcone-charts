import assert from 'node:assert/strict'

import { sha256 } from './blackbox.mjs'

// Preserve the approved historical hashes by checking and subtracting only
// #1087's reviewed default route and policy delta. All other drift stays hashed.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function one(objects, name) {
  const matches = objects.filter((object) => object.kind === 'ConfigMap' && object.metadata.name === name)
  assert.equal(matches.length, 1, `${name} must remain present exactly once`)
  return matches[0]
}

export function withPriorRealtimeChanges(objects) {
  const prior = structuredClone(objects)
  const payload = one(prior, 'falcone-bbx-in-falcone-bootstrap-payload')
  const route = JSON.parse(payload.data['route-2016-rt.json'])
  assert.equal(sha256(JSON.stringify(canonical(route))),
    'eef18d2410920338e251ad0cbd2cedd399c6f6c77c34189d1e90ff2dc7381509',
    'the realtime changes route must retain its complete reviewed default spec')
  route.labels['gateway.in-falcone.io/family'] = 'realtime'
  route.labels['gateway.in-falcone.io/route-kind'] = 'product_api_apikey'
  route.uri = '/v1/realtime/*'
  route.vars = [['uri', '~~', '/changes$']]
  delete route.plugins['client-control']
  delete route.plugins['proxy-rewrite']
  delete route.upstream.retries
  payload.data['route-2016-rt.json'] = `\n${JSON.stringify(canonical(route), null, 2)}\n`

  const config = one(prior, 'falcone-bbx-in-falcone-gateway-policy')
  const policy = JSON.parse(config.data['gateway-policy.json'])
  assert.deepEqual(policy.familyPolicies['realtime-changes'], {
    planCapabilityAnyOf: ['data.openwhisk.actions'],
    qosProfile: 'realtime',
    requestValidationProfile: 'realtime',
    tenantBinding: 'required',
    workspaceBinding: 'required',
  })
  delete policy.familyPolicies['realtime-changes']
  config.data['gateway-policy.json'] = `${JSON.stringify(canonical(policy), null, 2)}\n`

  const enabled = JSON.parse(config.data['enabled-apisix-routes.json'])
  const streams = enabled.filter((entry) => entry.routeId === '2016-rt')
  assert.deepEqual(streams, [{
    name: 'public-api-realtime-changes', routeId: '2016-rt', uri: '/v1/realtime/workspaces/*',
  }])
  streams[0].uri = '/v1/realtime/*'
  config.data['enabled-apisix-routes.json'] = `\n${JSON.stringify(canonical(enabled), null, 2)}\n`
  return prior
}
