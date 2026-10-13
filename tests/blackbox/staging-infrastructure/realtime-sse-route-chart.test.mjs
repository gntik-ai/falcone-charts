import assert from 'node:assert/strict'
import test from 'node:test'
import { readYaml, render, repoRoot, umbrellaChart, yamlDocuments } from '../fixtures/blackbox.mjs'

const streams = [
  ['public-api-realtime-collection-changes', '/v1/realtime/workspaces/ws1/data/appdb/collections/notes/changes'],
  ['public-api-realtime-table-changes', '/v1/realtime/workspaces/ws1/data/appdb/schemas/public/tables/notes/changes'],
]

function bootstrapRoutes(objects) {
  const payload = objects.find((object) => object.kind === 'ConfigMap' && Object.keys(object.data ?? {}).some((key) => key.startsWith('route-')))
  assert.ok(payload, 'gateway bootstrap payload is rendered')
  return Object.entries(payload.data).filter(([key]) => key.startsWith('route-'))
    .map(([, value]) => JSON.parse(value))
}

function assertStreams(routes) {
  assert.equal(routes.some((route) => route.name === 'public-api-realtime-changes' || String(route.id) === '2016-rt'), false)
  for (const [name, path] of streams) {
    const selected = routes.filter((route) => route.name === name)
    assert.equal(selected.length, 1, `${name} must be installed exactly once`)
    const [route] = selected
    assert.equal(route.uri, '/v1/realtime/workspaces/*')
    assert.deepEqual(route.methods, ['GET', 'OPTIONS'])
    assert.equal(route.labels['gateway.in-falcone.io/auth-mode'], 'query_api_key_sse')
    assert.deepEqual(route.vars.map(([variable, operator]) => [variable, operator]), [['uri', '~~']])
    const guard = new RegExp(route.vars[0][2])
    assert.equal(guard.test(path), true)
    for (const other of [`/extra${path}`, `${path}/extra`, `${path}/`,
      '/v1/realtime/workspaces/ws1/mongo-captures/changes',
      '/v1/workspaces/ws1/pg-captures/changes']) assert.equal(guard.test(other), false, other)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) assert.equal(route.methods.includes(method), false)
    const plugins = route.plugins
    for (const name of ['cors', 'limit-count', 'client-control', 'request-validation', 'proxy-rewrite']) assert.ok(plugins[name], name)
    assert.equal(plugins.cors.allow_methods, 'GET,OPTIONS')
    assert.equal(plugins['openid-connect'], undefined)
    assert.equal(plugins['issuer-jwks-auth'], undefined)
    assert.deepEqual(plugins['request-validation'].header_schema, { type: 'object' })
    assert.equal(plugins['client-control'].max_body_size, 1024)
    const headers = Object.fromEntries(Object.entries(plugins['proxy-rewrite'].headers.set).map(([key, value]) => [key.toLowerCase(), value]))
    for (const header of ['x-auth-subject', 'x-actor-username', 'x-tenant-id', 'x-workspace-id', 'x-plan-id', 'x-auth-scopes', 'x-actor-roles']) assert.equal(headers[header], '', header)
    assert.equal(headers['x-gateway-auth'], '${{GATEWAY_SHARED_SECRET}}')
    assert.equal(plugins['limit-count'].count, 120)
    assert.equal(plugins['limit-count'].time_window, 60)
    assert.equal(plugins['limit-count'].rejected_code, 429)
    assert.equal(plugins['limit-count'].key, '$http_apikey$arg_apikey')
    assert.deepEqual(route.upstream.timeout, { connect: 5, send: 3600, read: 3600 })
    assert.deepEqual(Object.keys(route.upstream.nodes), ['falcone-bbx-control-plane-executor.falcone-bbx.svc.cluster.local:8080'])
  }
}

test('bootstrap installs two bounded EventSource routes with executor authentication and capture coexistence', () => {
  const { objects } = render(umbrellaChart)
  const routes = bootstrapRoutes(objects)
  assertStreams(routes)
  for (const name of ['public-api-mongo-captures', 'public-api-pg-captures']) {
    const capture = routes.find((route) => route.name === name)
    assert.ok(capture)
    assert.ok(capture.plugins['openid-connect'])
    assert.ok(capture.methods.includes('POST'))
  }
})

test('staging standalone installs the same bounded streams as bootstrap and omits query keys from access logs', () => {
  const { objects } = render(umbrellaChart, ['-f', `${umbrellaChart}/values/staging.yaml`])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.ok(config)
  const standalone = yamlDocuments(config.data['apisix.yaml'])[0].routes
  assertStreams(standalone)
  const bootstrap = bootstrapRoutes(objects)
  for (const [name] of streams) {
    const route = standalone.find((route) => route.name === name)
    assert.deepEqual(route, { id: name, ...bootstrap.find((route) => route.name === name) })
  }
  const logConfig = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name.endsWith('-apisix-config-file'))
  assert.ok(logConfig)
  const format = yamlDocuments(logConfig.data['config.yaml'])[0].nginx_config.http.access_log_format
  assert.match(format, /\$request_method \$uri \$server_protocol/)
  assert.doesNotMatch(format, /\$(?:request(?:_uri)?|args|arg_\w+|http_(?:apikey|x_api_key|authorization))\b/)
})

test('kind standalone installs bounded streams when the bootstrap route list is replaced', () => {
  const { objects } = render(umbrellaChart, ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`,
    '--set', 'apisix.manageStandaloneRoutes=true'])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assert.ok(config)
  assertStreams(yamlDocuments(config.data['apisix.yaml'])[0].routes)
  assert.equal(objects.some((object) => streams.some(([name]) => object.data?.[`route-${name}.json`])), false,
    'standalone defaults must not add routes to the operator bootstrap list')
})

test('standalone respects the stream kill switch in the active gateway mode', () => {
  const configured = readYaml(`${umbrellaChart}/values.yaml`).bootstrap.reconcile.apisix.routes
  const disabled = streams[0][0]
  const routes = configured.map((route) => route.name === disabled
    ? { ...route, enabledInModes: [] } : route)
  const { objects } = render(umbrellaChart, ['-f', `${umbrellaChart}/values/staging.yaml`,
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(routes)}`])
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  const standalone = yamlDocuments(config.data['apisix.yaml'])[0].routes
  for (const inventory of [bootstrapRoutes(objects), standalone]) {
    assert.equal(inventory.some((route) => route.name === disabled), false,
      'the disabled collection stream must not be installed')
    assert.equal(inventory.filter((route) => route.name === streams[1][0]).length, 1,
      'the table stream must remain installed')
    for (const uri of ['/v1/realtime/workspaces/{workspaceId}/mongo-captures/*',
      '/v1/workspaces/{workspaceId}/pg-captures/*']) {
      assert.ok(inventory.some((route) => route.uri === uri), `${uri} must remain installed`)
    }
  }
})

test('stored legacy SSE values migrate to both bounded routes without new values keys', () => {
  const historical = [{ routeId: '2016-rt', name: 'public-api-realtime-changes',
    uri: '/v1/realtime/*', methods: ['GET', 'OPTIONS'], priority: 340,
    vars: [['uri', '~~', '/changes$']],
    labels: { 'gateway.in-falcone.io/family': 'realtime' },
    plugins: { cors: {}, 'limit-count': { count: 120, time_window: 60, rejected_code: 429,
      key_type: 'var_combination', key: '$http_apikey$arg_apikey', allow_degradation: false } },
    upstream: { component: 'controlPlane', port: 8080, dataPlane: true, requiresExecutor: true, sse: true },
  }]
  const { objects } = render(umbrellaChart, ['-f', `${umbrellaChart}/values/staging.yaml`,
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(historical)}`])
  assertStreams(bootstrapRoutes(objects))
  const config = objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === 'falcone-apisix-standalone')
  assertStreams(yamlDocuments(config.data['apisix.yaml'])[0].routes)
  const adminApi = render(umbrellaChart, ['--set', 'apisix.config.inline.APISIX_STAND_ALONE=false',
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(historical)}`]).objects
  const script = adminApi.find((object) => object.kind === 'ConfigMap' && object.data?.['bootstrap.sh']).data['bootstrap.sh']
  assert.equal(script.includes('ensure_apisix_route "2016-rt"'), false)
  for (const [name] of streams) assert.ok(script.includes(`ensure_apisix_route "${name}" "$PAYLOAD_DIR/route-${name}.json"`))
  const inventory = JSON.parse(adminApi.find((object) => object.kind === 'ConfigMap'
    && object.data?.['enabled-apisix-routes.json']).data['enabled-apisix-routes.json'])
  assert.deepEqual(inventory.map((route) => route.name), streams.map(([name]) => name))
})

test('admin-API upgrades remove the installed legacy catch-all before publishing bounded streams', () => {
  const { objects } = render(umbrellaChart, ['--set', 'apisix.config.inline.APISIX_STAND_ALONE=false'])
  const script = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['bootstrap.sh']).data['bootstrap.sh']
  const removal = script.match(/curl[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*/g)
    .find((command) => command.includes('-X DELETE') && command.includes('"$APISIX_ADMIN_URL/apisix/admin/routes/2016-rt"'))
  assert.ok(removal, 'upgrades must delete the previously installed unanchored route from APISIX')
  for (const [name] of streams) {
    assert.ok(script.indexOf(removal) < script.indexOf(`"$PAYLOAD_DIR/route-${name}.json"`),
      'the catch-all must be removed before the replacement routes are installed')
  }
  const standalone = render(umbrellaChart).objects
    .find((object) => object.kind === 'ConfigMap' && object.data?.['bootstrap.sh']).data['bootstrap.sh']
  assert.equal(standalone.includes('-X DELETE'), false, 'standalone bootstrap must not call the admin API')
})

test('admin-API cleanup preserves an explicitly configured route using the legacy ID', () => {
  const configured = [{ routeId: '2016-rt', name: 'custom-realtime-route',
    uri: '/custom-realtime', methods: ['GET'], priority: 340, plugins: {},
    upstream: { component: 'controlPlane', port: 8080, dataPlane: true, requiresExecutor: true },
  }]
  const { objects } = render(umbrellaChart, ['--set', 'apisix.config.inline.APISIX_STAND_ALONE=false',
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(configured)}`])
  const script = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['bootstrap.sh']).data['bootstrap.sh']
  assert.equal(script.includes('-X DELETE'), false, 'an explicitly configured legacy ID must not be deleted')
  assert.ok(script.includes('"$PAYLOAD_DIR/route-2016-rt.json"'))
})

test('admin-API upgrades remove disabled streams while preserving the enabled stream', () => {
  const configured = readYaml(`${umbrellaChart}/values.yaml`).bootstrap.reconcile.apisix.routes
  const disabled = streams[0][0]
  const routes = configured.map((route) => route.name === disabled
    ? { ...route, enabledInModes: [] } : route)
  const { objects } = render(umbrellaChart, ['--set', 'apisix.config.inline.APISIX_STAND_ALONE=false',
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(routes)}`])
  const script = objects.find((object) => object.kind === 'ConfigMap' && object.data?.['bootstrap.sh']).data['bootstrap.sh']
  const removals = script.match(/curl[^\n]*\\\n(?:[^\n]*\\\n)*[^\n]*/g)
    .filter((command) => command.includes('-X DELETE'))
  assert.ok(removals.some((command) => command.includes(`"$APISIX_ADMIN_URL/apisix/admin/routes/${disabled}"`)),
    'the kill switch must remove a stream already installed in the admin store')
  assert.equal(script.includes(`ensure_apisix_route "${disabled}"`), false)
  const enabled = streams[1][0]
  assert.equal(removals.some((command) => command.includes(`/routes/${enabled}"`)), false,
    'the enabled stream must not be removed')
  assert.ok(script.includes(`ensure_apisix_route "${enabled}" "$PAYLOAD_DIR/route-${enabled}.json"`))
})
