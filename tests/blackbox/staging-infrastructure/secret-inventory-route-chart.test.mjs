import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { repoRoot, umbrellaChart, yamlDocuments } from '../fixtures/blackbox.mjs'

function renderRoutes(args = []) {
  const result = spawnSync('helm', ['template', 'falcone', umbrellaChart,
    '--namespace', 'falcone', ...args,
    '--show-only', 'templates/bootstrap-payload-configmap.yaml'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  const [payload] = yamlDocuments(result.stdout)
  return Object.entries(payload.data).filter(([key]) => key.startsWith('route-'))
    .map(([, value]) => JSON.parse(value))
}

function selectRoute(routes, method, request) {
  const uri = new URL(request, 'https://api.example.test').pathname
  return [...routes].sort((a, b) => b.priority - a.priority).find((route) =>
    (route.uri.endsWith('*') ? uri.startsWith(route.uri.slice(0, -1)) : uri === route.uri)
      && (!route.methods || route.methods.includes(method)))
}

test('reconciled gateway publishes only GET inventory with the existing platform API policy', () => {
  for (const overlay of [[], ['-f', `${umbrellaChart}/values/staging.yaml`],
    ['-f', `${umbrellaChart}/values/prod.yaml`]]) {
    const routes = renderRoutes(overlay)
    const selected = selectRoute(routes, 'GET', '/v1/secrets/inventory?domain=tenant&tenantId=tenant-b')
    assert.equal(selected?.name, 'public-api-secret-inventory',
      'inventory must reach the control plane instead of the console catch-all')
    assert.equal(routes.filter((route) => route.name === selected.name).length, 1)
    assert.equal(selected.uri, '/v1/secrets/inventory')
    assert.deepEqual(selected.methods, ['GET', 'OPTIONS'])
    assert.deepEqual(Object.keys(selected.upstream.nodes),
      ['falcone-control-plane.falcone.svc.cluster.local:8080'])
    const platform = routes.find((route) => route.name === 'public-api-platform')
    assert.deepEqual(selected.plugins, platform.plugins, 'existing gateway safety policy must be retained')
    assert.deepEqual(selected.labels, platform.labels)
    assert.ok(selected.plugins['openid-connect'])
    assert.ok(selected.plugins['request-validation'])
    assert.equal(selected.plugins['limit-count'].rejected_code, 429)
    assert.equal(selected.plugins['request-validation'].header_schema.properties['X-Tenant-Id'].maxLength, 0)
    assert.equal(selected.plugins['proxy-rewrite'].uri, undefined, 'query-string tenantId must be preserved')
    assert.equal(selectRoute(routes, 'OPTIONS', '/v1/secrets/inventory')?.name, selected.name)
    for (const [method, path] of [['POST', '/v1/secrets/inventory'],
      ['GET', '/v1/secrets/inventory/extra'], ['GET', '/v1/secrets/other']]) {
      assert.notEqual(selectRoute(routes, method, path)?.name, selected.name)
    }
    assert.equal(selectRoute(routes, 'GET', '/v1/platform/secrets/tenant/example/history')?.name,
      'public-api-platform', 'history must keep its existing route')
  }
})

test('an explicit disabled inventory stays disabled and standalone keeps its existing forwarding', () => {
  const configured = yamlDocuments(readFileSync(`${umbrellaChart}/values.yaml`, 'utf8'))[0]
    .bootstrap.reconcile.apisix.routes
  const disabled = configured.map((route) => route.name === 'public-api-secret-inventory'
    ? { ...route, enabledInModes: [] } : route)
  const routes = renderRoutes(['--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(disabled)}`])
  assert.equal(routes.some((route) => route.name === 'public-api-secret-inventory'), false)
  assert.equal(selectRoute(routes, 'GET', '/v1/platform/secrets/platform/example/history')?.name,
    'public-api-platform')

  const kind = ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`]
  assert.equal(renderRoutes(kind).some((route) => route.name === 'public-api-secret-inventory'), false,
    'the standalone placeholder must not gain admin API reconciliation')
  for (const overlay of [kind, ['-f', `${umbrellaChart}/values/staging.yaml`]]) {
    const result = spawnSync('helm', ['template', 'falcone', umbrellaChart,
      '--namespace', 'falcone', ...overlay, '--set', 'apisix.manageStandaloneRoutes=true',
      '--show-only', 'templates/apisix-standalone-routes.yaml'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr)
    const [config] = yamlDocuments(result.stdout)
    const [table] = yamlDocuments(config.data['apisix.yaml'])
    const inventory = selectRoute(table.routes, 'GET', '/v1/secrets/inventory?domain=tenant&tenantId=tenant-b')
    assert.equal(String(inventory?.id), '5000')
    assert.deepEqual(Object.keys(inventory.upstream.nodes),
      ['falcone-control-plane.falcone.svc.cluster.local:8080'])
    assert.equal(inventory.plugins['proxy-rewrite'], undefined, 'the original request must reach control-plane auth')
  }
})

test('stored routes gain inventory without changing existing platform or history routing', () => {
  const base = spawnSync('git', ['-c', `safe.directory=${umbrellaChart}/../..`,
    'show', 'cb4df1634e1ec293f1c795549bb859fd5d43d8c2:charts/in-falcone/values.yaml'],
  { encoding: 'utf8', cwd: `${umbrellaChart}/../..` })
  assert.equal(base.status, 0, base.stderr)
  const stored = yamlDocuments(base.stdout)[0].bootstrap.reconcile.apisix.routes
  assert.equal(stored.some((route) => route.uri === '/v1/secrets/inventory'), false)
  const routes = renderRoutes(['--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(stored)}`])
  const inventory = selectRoute(routes, 'GET', '/v1/secrets/inventory?domain=platform')
  assert.equal(inventory?.name, 'public-api-secret-inventory')
  assert.deepEqual(inventory.methods, ['GET', 'OPTIONS'])
  const platform = selectRoute(routes, 'GET', '/v1/platform/secrets/platform/example/history')
  assert.equal(platform?.name, 'public-api-platform')
  assert.deepEqual(inventory.plugins, platform.plugins)
  assert.deepEqual(inventory.upstream, platform.upstream)
  assert.deepEqual(inventory.labels, platform.labels)
  const current = renderRoutes()
  assert.deepEqual(routes.filter((route) => route.name !== inventory.name),
    current.filter((route) => route.name !== inventory.name), 'all existing route payloads must remain unchanged')
})
