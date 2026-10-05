import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { repoRoot, run, umbrellaChart, yamlDocuments } from '../fixtures/blackbox.mjs'

const canonical = yamlDocuments(readFileSync(resolve(umbrellaChart, 'files/apisix/standalone/apisix.yaml'), 'utf8'))[0]
const routeById = (table, id) => table.routes.find((route) => String(route.id) === id)
const tablePath = '/v1/postgres/workspaces/workspace-example/data/database-example/schemas/public/tables/table-example'
const operations = [
  ['GET', 'rows'], ['POST', 'rows'],
  ['GET', 'rows/by-primary-key'], ['PATCH', 'rows/by-primary-key'], ['DELETE', 'rows/by-primary-key'],
  ['POST', 'bulk/insert'], ['POST', 'rows/bulk/insert'], ['POST', 'search'],
  ['PUT', 'embedding-mapping'], ['GET', 'embedding-mapping'], ['DELETE', 'embedding-mapping'],
]
const issuerBases = {
  default: 'https://iam.dev.in-falcone.example.com',
  staging: 'https://iam.baas.musematic.ai',
  prod: 'https://iam.in-falcone.example.com',
  kind: 'http://falcone-keycloak:8080',
}

function selectRoute(table, method, uri, headers = {}) {
  return [...table.routes].sort((a, b) => b.priority - a.priority).find((route) => {
    const uriMatches = route.uri.endsWith('*') ? uri.startsWith(route.uri.slice(0, -1)) : uri === route.uri
    return uriMatches && (!route.methods || route.methods.includes(method))
      && (route.vars ?? []).every(([variable, operator, pattern]) => {
        assert.equal(operator, '~~')
        return new RegExp(pattern).test(variable === 'uri' ? uri : headers[variable.slice(5)] ?? '')
      })
  })
}

for (const [profile, overlay] of [
  ['default', []],
  ['staging', ['-f', `${umbrellaChart}/values/staging.yaml`]],
  ['prod', ['-f', `${umbrellaChart}/values/prod.yaml`]],
  ['kind', ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`]],
]) {
  test(`${profile} standalone Postgres data route preserves bearer verification and API-key precedence`, () => {
    const args = ['template', 'falcone', umbrellaChart, '--namespace', 'falcone', ...overlay,
      '--set', 'apisix.manageStandaloneRoutes=true', '--show-only', 'templates/apisix-standalone-routes.yaml']
    const first = run('helm', args)
    const second = run('helm', args)
    assert.equal(first.status, 0, first.stderr)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(first.stdout, second.stdout, 'standalone rendering must be deterministic')
    const config = yamlDocuments(first.stdout)[0]
    const table = yamlDocuments(config.data['apisix.yaml'])[0]
    assert.equal(table.routes.filter((route) => String(route.id) === '2005-data').length, 1)
    const bearer = routeById(table, '2005-data')
    const mongo = routeById(table, '2006')
    assert.deepEqual(bearer.plugins, mongo.plugins, 'Postgres must use the same verifier and hardening as Mongo')
    assert.deepEqual(bearer.upstream, mongo.upstream)
    assert.equal(bearer.plugins['openid-connect'], undefined)
    assert.equal(bearer.plugins['issuer-jwks-auth'].enforce_tenant_audience, profile !== 'staging')
    assert.equal(bearer.plugins['issuer-jwks-auth'].issuer_base_url, issuerBases[profile])
    assert.equal(bearer.plugins['issuer-jwks-auth'].jwks_base_url, 'http://falcone-keycloak:8080')
    assert.deepEqual(routeById(table, '2005'), routeById(canonical, '2005'))
    assert.deepEqual(routeById(table, '2005-key'), routeById(canonical, '2005-key'))
    assert.ok(routeById(table, '2005').priority < bearer.priority)
    assert.ok(bearer.priority < routeById(table, '2005-key').priority)
    for (const [method, suffix] of operations) {
      const uri = `${tablePath}/${suffix}`
      for (const headers of [{}, { authorization: 'Bearer test-token' }, { authorization: 'Bearer invalid' },
        { apikey: 'noncanonical-test-key' }, { 'x-api-key': 'flc_test_only' }]) {
        assert.equal(selectRoute(table, method, uri, headers)?.id, '2005-data', `${method} ${suffix}`)
      }
      assert.equal(selectRoute(table, method, uri, {
        apikey: 'flc_test_only', authorization: 'Bearer test-token',
      })?.id, '2005-key')
    }
    const controlPlanePaths = [
      ['POST', `${tablePath}/exports`], ['POST', `${tablePath}/imports`],
      ['GET', '/v1/postgres/databases'],
      ['GET', '/v1/postgres/databases/database-example/schemas'],
      ['GET', '/v1/postgres/databases/database-example/schemas/public/tables'],
      ...['columns', 'indexes', 'policies', 'security'].map((suffix) => [
        'GET', `/v1/postgres/databases/database-example/schemas/public/tables/table-example/${suffix}`,
      ]),
      ...['views', 'materialized-views'].map((suffix) => [
        'GET', `/v1/postgres/databases/database-example/schemas/public/${suffix}`,
      ]),
    ]
    const unsupportedPaths = [
      ...['rows', 'rows/by-primary-key', 'bulk/insert', 'rows/bulk/insert', 'search', 'embedding-mapping']
        .flatMap((suffix) => [`${tablePath}/${suffix}/extra`, `${tablePath}/${suffix}/`]),
      `${tablePath}/bulk/update`, `${tablePath}/bulk/delete`,
      '/v1/postgres/data/database-example/schemas/public/tables/table-example/rows',
      '/v1/postgres/workspaces//data/database-example/schemas/public/tables/table-example/rows',
    ]
    for (const [method, uri] of [...controlPlanePaths, ...unsupportedPaths.map((uri) => ['POST', uri])]) {
      const selected = selectRoute(table, method, uri, { authorization: 'Bearer test-token' })
      assert.equal(selected?.id, '2005', `${method} ${uri}`)
      assert.match(Object.keys(selected.upstream.nodes)[0], /-control-plane\.falcone\.svc\.cluster\.local:8080$/)
    }
    const headers = bearer.plugins['proxy-rewrite'].headers
    assert.equal(headers.set['x-gateway-auth'], '${{GATEWAY_SHARED_SECRET}}')
    for (const header of ['X-Tenant-Id', 'X-Workspace-Id', 'X-Auth-Subject', 'X-Actor-Roles']) {
      assert.equal(bearer.plugins['request-validation'].header_schema.properties[header].maxLength, 0)
      assert.ok(headers.remove.includes(header.toLowerCase()))
    }
    for (const header of ['apikey', 'x-api-key']) assert.ok(headers.remove.includes(header))
  })
}
