/**
 * Regression contract for falcone#1118.
 *
 * Flow event streams retain query-key authentication until the u5 cutover.
 * The rendered gateway config must log normalized paths without query-bearing
 * variables, while preserving the standalone and Prometheus contracts.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import { render, repoRoot, umbrellaChart, yamlDocuments } from '../fixtures/blackbox.mjs'

// APISIX 3.10's stock field layout, with query-bearing request/upstream URI
// fields replaced by method, normalized path and protocol (falcone#1118).
const expectedAccessLogFormat = '$remote_addr - $remote_user [$time_local] $http_host "$request_method $uri $server_protocol" $status $body_bytes_sent $request_time "$http_referer" "$http_user_agent" $upstream_addr $upstream_status $upstream_response_time "$upstream_scheme://$upstream_host$uri"'

const profiles = [
  ['default', []],
  ['staging', ['-f', `${umbrellaChart}/values/staging.yaml`]],
  ['prod', ['-f', `${umbrellaChart}/values/prod.yaml`]],
  ['airgap', ['-f', `${umbrellaChart}/values/airgap.yaml`]],
  ['kind', ['-f', `${repoRoot}/deploy/kind/values-kind.yaml`]],
]

function renderedConfig(chart, args = []) {
  const { objects } = render(chart, args)
  const configMap = objects.find((object) => (
    object?.kind === 'ConfigMap' && /-apisix-config-file$/.test(object?.metadata?.name ?? '')
  ))
  assert.ok(configMap, 'apisix-config-file ConfigMap was not rendered')
  const [config] = yamlDocuments(configMap.data['config.yaml'])
  return config
}

function assertAccessLogContract(config) {
  const format = config.nginx_config?.http?.access_log_format
  assert.equal(typeof format, 'string', 'config.yaml must set nginx_config.http.access_log_format')
  assert.equal(format, expectedAccessLogFormat, 'access log must preserve the stock field layout without literal YAML quoting')
  const variables = [...format.matchAll(/\$\{?([a-zA-Z_][a-zA-Z0-9_]*)\}?/g)].map((match) => match[1])
  for (const variable of variables) {
    assert.ok(
      !['request', 'request_uri', 'args', 'query_string', 'upstream_uri'].includes(variable)
        && !variable.startsWith('arg_'),
      `access log contains query-bearing variable ${variable}`,
    )
  }
  for (const required of [
    'request_method', 'uri', 'server_protocol', 'status', 'request_time', 'upstream_addr',
    'remote_addr', 'remote_user', 'time_local', 'http_host', 'body_bytes_sent',
    'http_referer', 'http_user_agent', 'upstream_status', 'upstream_response_time',
    'upstream_scheme', 'upstream_host',
  ]) {
    assert.ok(variables.includes(required), `access log must retain ${required}`)
  }
  assert.match(format, /\$request_method \$uri \$server_protocol/)
  assert.deepEqual(config.deployment, {
    role: 'data_plane',
    role_data_plane: { config_provider: 'yaml' },
    admin: { admin_key: [{ name: 'admin', key: '', role: 'admin' }] },
  })
  assert.deepEqual(config.apisix, { extra_lua_path: '/usr/local/apisix/falcone/?.lua' })
  // Known-good ordered plugin list from the assigned pre-fix chart (138cda13).
  assert.equal(
    createHash('sha256').update(config.plugins.join('\n')).digest('hex'),
    'b9a90fecae64cacab5b6a0b4d4f14f1fef021ff40b4f9ee29b0b28247146e3f6',
    'the APISIX plugin list must remain unchanged',
  )
  assert.deepEqual(config.plugin_attr, { prometheus: { enable_export_server: false } })
}

for (const [profile, args] of profiles) {
  test(`${profile} APISIX access logs omit query strings and retain gateway configuration`, () => {
    assertAccessLogContract(renderedConfig(umbrellaChart, args))
  })
}

test('APISIX access-log contract rejects missing format and query-bearing variables (falcone#1118)', () => {
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-apisix-log-negative-bbx-'))
  const chart = resolve(work, 'in-falcone')
  try {
    cpSync(umbrellaChart, chart, { recursive: true })
    const template = resolve(chart, 'templates/apisix-config-file.yaml')
    const original = readFileSync(template, 'utf8')
    assertAccessLogContract(renderedConfig(chart))
    const mutations = [
      {
        name: 'missing access_log_format',
        template: original.replace(/^\s+access_log_format:.*\n/m, ''),
        failure: /config\.yaml must set nginx_config\.http\.access_log_format/,
      },
      {
        name: 'raw request variable',
        template: original.replace('$request_method $uri $server_protocol', '$request'),
        failure: /access log must preserve the stock field layout/,
      },
      {
        name: 'query-bearing upstream URI',
        template: original.replace('$upstream_host$uri', '$upstream_host$upstream_uri'),
        failure: /access log must preserve the stock field layout/,
      },
    ]
    for (const mutation of mutations) {
      assert.notEqual(mutation.template, original, `${mutation.name} mutation must be applied`)
      writeFileSync(template, mutation.template)
      // Rendering and YAML decoding must succeed before the contract rejects
      // the unsafe format; a subprocess failure is not a valid negative signal.
      const config = renderedConfig(chart)
      assert.throws(
        () => assertAccessLogContract(config),
        (error) => error.code === 'ERR_ASSERTION' && mutation.failure.test(error.message),
        `${mutation.name} must fail the real rendered-config contract`,
      )
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
