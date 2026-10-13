import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const chart = fileURLToPath(new URL('../../../charts/in-falcone', import.meta.url));
const identityHeaders = ['x-tenant-id', 'x-workspace-id', 'x-auth-subject', 'x-actor-roles'];

function render(args = []) {
  const result = spawnSync('helm', ['template', 'realtime-bbx', chart, '--namespace', 'realtime-bbx', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function routePayload(text, id) {
  const block = text.split(`  route-${id}.json: |\n`)[1];
  assert.ok(block, `enabled route ${id} must be rendered`);
  return JSON.parse(block.split(/\n  [\w.-]+: \|/)[0].replace(/^    /gm, ''));
}

function standaloneRoutes(text) {
  const directory = mkdtempSync(join(tmpdir(), 'realtime-route-bbx-'));
  try {
    const input = join(directory, 'render.yaml');
    writeFileSync(input, text);
    const result = spawnSync('python3', ['-c', [
      'import json, sys, yaml',
      'docs = list(yaml.safe_load_all(open(sys.argv[1])))',
      'config = next(d for d in docs if d and d.get("kind") == "ConfigMap" and "apisix.yaml" in d.get("data", {}))',
      'json.dump(yaml.safe_load(config["data"]["apisix.yaml"])["routes"], sys.stdout)',
    ].join('\n'), input], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertStreamBoundary(route) {
  assert.equal(route.name, 'public-api-realtime-changes');
  assert.equal(route.labels['gateway.in-falcone.io/family'], 'realtime-changes');
  assert.deepEqual(route.methods, ['GET', 'OPTIONS']);
  assert.equal(route.plugins['openid-connect'], undefined);
  assert.equal(route.plugins['request-validation'], undefined);
  assert.ok(route.plugins.cors);
  assert.ok(route.plugins['client-control'].max_body_size > 0);
  const headers = Object.fromEntries(Object.entries(route.plugins['proxy-rewrite'].headers.set)
    .map(([name, value]) => [name.toLowerCase(), value]));
  for (const name of identityHeaders) assert.equal(headers[name], '', `${name} must be blanked`);
  assert.equal(headers['x-gateway-auth'], '${{GATEWAY_SHARED_SECRET}}');
  assert.equal(route.plugins['proxy-rewrite'].headers.remove?.includes('apikey') ?? false, false);
  const limiter = route.plugins['limit-count'];
  assert.equal(limiter.count, 120);
  assert.equal(limiter.time_window, 60);
  assert.equal(limiter.rejected_code, 429);
  assert.equal(limiter.key_type, 'var_combination');
  assert.equal(limiter.key, '$http_apikey$arg_apikey');
  assert.equal(limiter.allow_degradation, false);
  assert.deepEqual(route.upstream.timeout, { connect: 5, send: 3600, read: 3600 });
  assert.match(Object.keys(route.upstream.nodes)[0], /-control-plane-executor\./);
  assert.equal(route.uri, '/v1/realtime/workspaces/*');
  assert.equal(route.vars.length, 1);
  const [variable, operator, pattern] = route.vars[0];
  assert.equal(variable, 'uri');
  assert.equal(operator, '~~');
  const uri = new RegExp(pattern);
  for (const path of [
    '/v1/realtime/workspaces/a/data/app/collections/notes/changes',
    '/v1/realtime/workspaces/a/data/app/schemas/public/tables/notes/changes',
  ]) assert.ok(uri.test(path), `must route ${path}`);
  for (const path of [
    '/v1/realtime/workspaces/a/mongo-captures/changes',
    '/v1/realtime/workspaces/a/mongo-captures/one',
    '/v1/realtime/tenants/a/mongo-captures/summary/changes',
    '/v1/realtime/workspaces/a/data/app/collections/notes/changes/extra',
    '/v1/realtime/workspaces/a/data/app/schemas/public/tables/notes',
  ]) assert.equal(uri.test(path), false, `must exclude ${path}`);
}

test('default chart publishes the executor-authenticated realtime changes family', () => {
  const text = render(['--show-only', 'templates/bootstrap-payload-configmap.yaml']);
  assertStreamBoundary(routePayload(text, '2016-rt'));
});

test('staging standalone gateway publishes the same bounded stream route', () => {
  const text = render(['-f', `${chart}/values/staging.yaml`, '--show-only', 'templates/apisix-standalone-routes.yaml']);
  assertStreamBoundary(standaloneRoutes(text).find(route => route.id === '2016-rt'));
});

test('stored pre-1087 route values retain the stream boundary without the new family policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'realtime-legacy-bbx-'));
  try {
    const values = join(directory, 'stored-values.json');
    writeFileSync(values, JSON.stringify({
      gatewayPolicy: { familyPolicies: { 'realtime-changes': null } },
      bootstrap: { reconcile: { apisix: { routes: [{
        routeId: '2016-rt', name: 'public-api-realtime-changes', uri: '/v1/realtime/*',
        methods: ['GET', 'OPTIONS'], priority: 340, vars: [['uri', '~~', '/changes$']],
        labels: { 'gateway.in-falcone.io/family': 'realtime', 'gateway.in-falcone.io/route-kind': 'product_api_apikey' },
        plugins: { cors: {}, 'limit-count': {
          count: 120, time_window: 60, rejected_code: 429, key_type: 'var_combination',
          key: '$http_apikey$arg_apikey', allow_degradation: false,
        } },
        upstream: { component: 'controlPlane', port: 8080, dataPlane: true, requiresExecutor: true, sse: true },
      }] } } },
    }));
    const text = render(['-f', values, '--show-only', 'templates/bootstrap-payload-configmap.yaml']);
    assertStreamBoundary(routePayload(text, '2016-rt'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const environment of ['staging', 'prod']) {
  test(`${environment} reconciled routes keep stream safety and capture authentication`, () => {
    const text = render(['-f', `${chart}/values/${environment}.yaml`, '--show-only', 'templates/bootstrap-payload-configmap.yaml']);
    assertStreamBoundary(routePayload(text, '2016-rt'));
    for (const id of ['2012', '2013', '2014', '2015']) {
      const capture = routePayload(text, id);
      assert.ok(capture.plugins['openid-connect'], `${capture.name} must retain OIDC`);
      assert.ok(capture.plugins['request-validation'], `${capture.name} must retain request validation`);
    }
  });
}
