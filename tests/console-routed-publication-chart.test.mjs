import assert from 'node:assert/strict'
import test from 'node:test'

import { readYaml, render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const families = [
  ['plans', '/v1/plans/*', 'none', 'platform_control'],
  ['quota-dimensions', '/v1/quota-dimensions/*', 'none', 'platform_control'],
  ['tenant-plan', '/v1/tenant/*', 'required', 'tenant_control'],
  ['console', '/v1/console/*', 'none', 'platform_control'],
  ['async-operation-query', '/v1/async-operation-query/*', 'required', 'tenant_control'],
]
const values = readYaml(`${umbrellaChart}/values.yaml`)

function routes(objects) {
  const payload = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['route-2002.json'])
  assert.ok(payload, 'bootstrap route payload must exist')
  return Object.entries(payload.data).filter(([key]) => /^route-.*\.json$/.test(key))
    .map(([key, body]) => ({ key, ...JSON.parse(body) }))
}

function assertSpoofedHeaders(route) {
  const properties = route.plugins?.['request-validation']?.header_schema?.properties
  for (const header of values.gatewayPolicy.requestValidation.spoofedHeaders) {
    assert.deepEqual(properties?.[header], { type: 'string', maxLength: 0 },
      `${route.name} must reject spoofed ${header}`)
  }
}

test('published console families reach controlPlane with their scoped policy and spoofed-header rejection', () => {
  const rendered = routes(render(umbrellaChart).objects)
  const configured = values.bootstrap.reconcile.apisix.routes
  const tenants = configured.find((route) => route.name === 'public-api-tenants')
  const catchAll = rendered.find((route) => route.name === 'console')
  assertSpoofedHeaders(rendered.find((route) => route.name === 'public-api-tenants'))
  assert.equal(new Set(configured.map((route) => String(route.routeId))).size, configured.length)
  for (const [family, uri, tenantBinding, profile] of families) {
    const matches = rendered.filter((route) => route.labels?.['gateway.in-falcone.io/family'] === family)
    assert.equal(matches.length, 1, `${family} must have exactly one published route`)
    const route = matches[0]
    assert.equal(route.name, `public-api-${family}`)
    assert.equal(route.uri, uri)
    assert.ok(route.priority > catchAll.priority)
    assert.equal(route.labels['gateway.in-falcone.io/route-kind'], 'product_api')
    assert.equal(route.labels['gateway.in-falcone.io/tenant-binding'], tenantBinding)
    assert.equal(route.labels['gateway.in-falcone.io/workspace-binding'], 'none')
    assert.deepEqual(route.upstream.nodes, { 'falcone-bbx-control-plane.falcone-bbx.svc.cluster.local:8080': 1 })
    const source = configured.find((entry) => entry.name === route.name)
    assert.deepEqual(source.methods, tenants.methods)
    assert.deepEqual(source.plugins, tenants.plugins)
    assert.deepEqual(values.gatewayPolicy.familyPolicies[family], {
      tenantBinding, workspaceBinding: 'none', qosProfile: profile,
      requestValidationProfile: profile, planCapabilityAnyOf: [],
    })
    assertSpoofedHeaders(route)
  }
})

test('removing any published family policy is detected by the rendered spoofed-header assertion', () => {
  for (const [family] of families) {
    const rendered = routes(render(umbrellaChart, ['--set', `gatewayPolicy.familyPolicies.${family}=null`]).objects)
    const route = rendered.find((entry) => entry.name === `public-api-${family}`)
    assert.ok(route, 'the route still renders without its family policy')
    assert.throws(() => assertSpoofedHeaders(route), /must reject spoofed/)
    assertSpoofedHeaders(rendered.find((entry) => entry.name === 'public-api-tenants'))
  }
})
