import assert from 'node:assert/strict'
import test from 'node:test'
import { render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const base = ['dev.yaml', 'platform-kubernetes.yaml', 'profiles/all-in-one.yaml']
const args = (profile = true) => [...base, ...(profile ? ['kind-quickstart.yaml'] : [])]
  .flatMap(path => ['-f', `${umbrellaChart}/values/${path}`])
const ingress = objects => objects.find(o => o.kind === 'Ingress')

test('quickstart publishes new API paths and preserves the existing public paths', () => {
  const { objects } = render(umbrellaChart, args())
  const rules = ingress(objects).spec.rules
  for (const [surface, paths, service] of [
    ['api', ['/control-plane', '/v1'], 'apisix'],
    ['realtime', ['/realtime', '/v1/realtime'], 'apisix'],
    ['iam', ['/realms', '/resources', '/js'], 'keycloak'], ['console', ['/'], 'web-console'],
  ]) {
    const rule = rules.find(r => r.host === `${surface}.127.0.0.1.nip.io`)
    assert.ok(rule, surface)
    assert.deepEqual(rule.http.paths.map(p => p.path), paths)
    for (const path of rule.http.paths) {
      assert.equal(path.pathType, 'Prefix')
      assert.deepEqual(path.backend.service, { name: `falcone-bbx-${service}`, port: { name: 'http' } })
    }
  }
  assert.equal(ingress(objects).spec.tls, undefined)
  assert.equal(ingress(render(umbrellaChart, args(false)).objects).spec.rules
    .flatMap(r => r.http.paths).some(p => p.path.startsWith('/v1')), false)
})

test('live negative render keeps the quickstart hosts and HTTP while omitting the new paths', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync('python3', ['-c', `
import json, runpy, sys
surface = runpy.run_path(sys.argv[1])
json.dump(surface['render'](False), sys.stdout)
`, `${umbrellaChart}/../../tests/blackbox/kind-quickstart/kind-quickstart-surface.py`], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  const negative = ingress(JSON.parse(result.stdout))
  assert.equal(negative.spec.tls, undefined)
  assert.deepEqual(negative.spec.rules.map(rule => rule.host).sort(),
    ['api', 'console', 'iam', 'realtime'].map(host => `${host}.127.0.0.1.nip.io`).sort())
  const apiPaths = negative.spec.rules.find(rule => rule.host === 'api.127.0.0.1.nip.io').http.paths
  assert.deepEqual(apiPaths.map(path => path.path), ['/control-plane'])
  assert.equal(apiPaths[0].pathType, 'Prefix')
  assert.deepEqual(apiPaths[0].backend.service, { name: 'falcone-surface-apisix', port: { name: 'http' } })
  assert.equal(negative.spec.rules.flatMap(rule => rule.http.paths).some(path => path.path.startsWith('/v1')), false)
})

const deployment = (objects, component) => objects.find(o => o.kind === 'Deployment' && o.metadata.name === `falcone-bbx-${component}`)
const container = (objects, component) => deployment(objects, component).spec.template.spec.containers[0]
const issuer = 'http://iam.127.0.0.1.nip.io'
const internal = 'http://falcone-bbx-keycloak:8080'

test('canonical public issuer keeps all key fetches internal and preserves control-plane env', () => {
  const { objects } = render(umbrellaChart, args())
  assert.deepEqual(container(objects, 'keycloak').args, ['start', '--http-enabled=true', '--hostname-strict=false',
    `--hostname=${issuer}`, '--hostname-backchannel-dynamic=true'])
  const cp = container(objects, 'control-plane').env
  assert.deepEqual(cp.find(e => e.name === 'KEYCLOAK_ISSUER'), { name: 'KEYCLOAK_ISSUER', value: `${issuer}/realms/in-falcone-platform` })
  assert.equal(cp.find(e => e.name === 'KEYCLOAK_BASE_URL').value, internal)
  assert.equal(cp.find(e => e.name === 'KEYCLOAK_JWKS_URL').value, `${internal}/realms/in-falcone-platform/protocol/openid-connect/certs`)
  const jwt = objects.find(o => o.metadata.name === 'falcone-bbx-executor-jwt-config').data
  assert.equal(jwt.KEYCLOAK_ISSUER, `${issuer}/realms/in-falcone-platform`)
  assert.equal(jwt.KEYCLOAK_JWKS_URL, `${internal}/realms/in-falcone-platform/protocol/openid-connect/certs`)
  const payload = objects.find(o => o.kind === 'ConfigMap' && o.data?.['route-2006.json'])
  const plugin = JSON.parse(payload.data['route-2006.json']).plugins['issuer-jwks-auth']
  assert.equal(plugin.issuer_base_url, issuer)
  assert.equal(plugin.jwks_base_url, internal)
  const oldEnv = container(render(umbrellaChart, args(false)).objects, 'control-plane').env
  assert.equal(oldEnv.some(e => e.name === 'KEYCLOAK_ISSUER'), false)
  assert.deepEqual(cp.filter(e => e.name !== 'KEYCLOAK_ISSUER'), oldEnv)
})

test('issuer config changes roll exactly the three consumers and checksums are deterministic', () => {
  const without = render(umbrellaChart, args(false)).objects
  const withProfile = render(umbrellaChart, args()).objects
  const repeat = render(umbrellaChart, args()).objects
  for (const component of ['control-plane', 'control-plane-executor', 'apisix']) {
    const checksum = objects => deployment(objects, component).spec.template.metadata.annotations?.['in-falcone.io/issuer-config-checksum']
    assert.match(checksum(withProfile) ?? '', /^[0-9a-f]{64}$/)
    assert.equal(checksum(without), undefined, component)
    assert.equal(checksum(withProfile), checksum(repeat), component)
  }
})

test('profiles without a control-plane issuer preserve their pod annotations and environment', () => {
  for (const [profile, values] of [
    ['default', []],
    ['prod-tls', ['-f', `${umbrellaChart}/values/prod.yaml`, '-f', `${umbrellaChart}/../../deploy/kind/values-production.yaml`]],
    ['kind-tls', ['-f', `${umbrellaChart}/../../deploy/kind/values-kind.yaml`, '-f', `${umbrellaChart}/../../deploy/kind/values-production.yaml`]],
    ['three-file quickstart', args(false)],
    ['null issuer', [...args(), '--set', 'controlPlane.keycloakIssuer=null']],
  ]) {
    const { objects } = render(umbrellaChart, values)
    for (const object of objects.filter(o => o.kind === 'Deployment')) {
      assert.equal(object.spec.template.metadata.annotations?.['in-falcone.io/issuer-config-checksum'],
        undefined, `${profile}: ${object.metadata.name}`)
    }
    assert.equal(deployment(objects, 'apisix').spec.template.metadata.annotations, undefined, profile)
    assert.equal(container(objects, 'control-plane').env.some(e => e.name === 'KEYCLOAK_ISSUER'), false, profile)
  }
})

test('optional issuer merges with existing env entries and absent reused key renders safely', () => {
  const duplicate = container(render(umbrellaChart, [...args(),
    '--set', 'controlPlane.env[0].name=KEYCLOAK_ISSUER',
    '--set-string', 'controlPlane.env[0].value=http://previous.example/realms/platform',
  ]).objects, 'control-plane').env.filter(e => e.name === 'KEYCLOAK_ISSUER')
  assert.deepEqual(duplicate, [{ name: 'KEYCLOAK_ISSUER', value: `${issuer}/realms/in-falcone-platform` }])
  const without = render(umbrellaChart, [...args(false), '--set', 'controlPlane.keycloakIssuer=null']).objects
  assert.equal(container(without, 'control-plane').env.some(e => e.name === 'KEYCLOAK_ISSUER'), false)
})

test('CoreDNS setup refuses other contexts and is idempotent at the kubectl boundary', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const work = mkdtempSync(`${tmpdir()}/falcone-kind-dns-`)
  const script = `${umbrellaChart}/../../deploy/kind/quickstart/coredns-nip-io.sh`
  try {
    writeFileSync(`${work}/state.json`, JSON.stringify({ data: { Corefile: '.:53 {\n    errors\n    kubernetes cluster.local in-addr.arpa ip6.arpa {\n      pods insecure\n    }\n    forward . /etc/resolv.conf\n}\n' } }))
    writeFileSync(`${work}/kubectl`, `#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
state = Path(os.environ['DNS_TEST_DIR']) / 'state.json'
log = state.with_name('calls.jsonl')
with log.open('a') as output: output.write(json.dumps(args) + '\\n')
assert args[:2] == ['--context', 'kind-test']
if 'get' in args: print(state.read_text())
elif 'patch' in args:
    patch = json.loads(Path(args[args.index('--patch-file') + 1]).read_text())
    state.write_text(json.dumps(patch))
else: assert 'rollout' in args
`, { mode: 0o755 })
    const invoke = context => spawnSync('bash', [script, context], {
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, DNS_TEST_DIR: work }, encoding: 'utf8',
    })
    for (const context of ['production', 'kind-']) {
      assert.notEqual(invoke(context).status, 0)
    }
    for (let i = 0; i < 2; i++) {
      const result = invoke('kind-test')
      assert.equal(result.status, 0, result.stderr)
    }
    const corefile = JSON.parse(readFileSync(`${work}/state.json`, 'utf8')).data.Corefile
    assert.equal(corefile.split('# BEGIN falcone-kind-nip-io').length - 1, 1)
    assert.equal(corefile.split('rewrite stop').length - 1, 1)
    assert.match(corefile, /ingress-nginx-controller\.ingress-nginx\.svc\.cluster\.local/)
    assert.match(corefile, /answer auto/)
    assert.match(corefile, /kubernetes cluster.local/)
    const calls = readFileSync(`${work}/calls.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(calls.every(call => call[1] === 'kind-test'), 'refused contexts must never reach kubectl')
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('checksums track each consumed issuer config without rolling unrelated consumers', () => {
  const baseline = render(umbrellaChart, args()).objects
  const ttlChange = render(umbrellaChart, [...args(), '--set', 'gatewayPolicy.issuerJwksAuth.cache_ttl=301']).objects
  const cpChange = render(umbrellaChart, [...args(), '--set-string', 'controlPlane.keycloakIssuer=http://other.example/realms/platform']).objects
  const unrelated = render(umbrellaChart, [...args(), '--set-string', 'controlPlane.podAnnotations.other=preserved']).objects
  const checksum = (objects, component) => deployment(objects, component).spec.template.metadata.annotations?.['in-falcone.io/issuer-config-checksum']
  for (const component of ['control-plane', 'control-plane-executor', 'apisix']) {
    assert.equal(checksum(baseline, component) === checksum(ttlChange, component), component !== 'apisix', component)
    assert.equal(checksum(baseline, component) === checksum(cpChange, component), component !== 'control-plane', component)
    assert.equal(checksum(baseline, component), checksum(unrelated, component), component)
  }
  assert.equal(deployment(unrelated, 'control-plane').spec.template.metadata.annotations.other, 'preserved')
})

test('ingress setup accepts kubectl per-object JSON and verifies admission completion after controller readiness', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const work = mkdtempSync(`${tmpdir()}/falcone-kind-ingress-`)
  const script = `${umbrellaChart}/../../deploy/kind/quickstart/ingress-nginx.sh`
  // The pinned upstream manifest sets ttlSecondsAfterFinished: 0 on both Jobs.
  // Model the API's deletion of completed Jobs during the controller rollout.
  const jobs = ['ingress-nginx-admission-create', 'ingress-nginx-admission-patch']
  const manifest = { apiVersion: 'v1', kind: 'List', items: [
    ...jobs.map(name => ({ apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name, namespace: 'ingress-nginx' }, spec: { ttlSecondsAfterFinished: 0 } })),
    { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'ingress-nginx-controller' } },
  ] }
  try {
    // kubectl create -o json prints separate JSON documents, not a List.
    writeFileSync(`${work}/manifest.json`, manifest.items.map(obj => JSON.stringify(obj, null, 2)).join('\n') + '\n')
    writeFileSync(`${work}/kubectl`, `#!/usr/bin/python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
folder = Path(os.environ['INGRESS_TEST_DIR'])
assert args[:2] == ['--context', 'kind-test']
state = folder / 'state.json'
if 'create' in args:
    assert '--dry-run=client' in args
    print((folder / 'manifest.json').read_text())
elif 'apply' in args:
    source = args[args.index('-f') + 1]
    data = json.load(sys.stdin) if source == '-' else json.loads((folder / 'manifest.json').read_text())
    state.write_text(json.dumps(data))
elif 'rollout' in args:
    data = json.loads(state.read_text())
    data['items'] = [obj for obj in data['items'] if obj.get('spec', {}).get('ttlSecondsAfterFinished') != 0]
    state.write_text(json.dumps(data))
elif 'wait' in args:
    assert '--for=condition=complete' in args
    names = {obj['metadata']['name'] for obj in json.loads(state.read_text())['items']}
    for arg in args:
        if arg.startswith('job/'):
            if arg[4:] not in names:
                sys.exit('Error from server (NotFound): jobs.batch "' + arg[4:] + '" not found')
            with (folder / 'completed.jsonl').open('a') as output:
                output.write(json.dumps(arg[4:]) + '\\n')
else:
    sys.exit('unexpected kubectl command: ' + repr(args))
`, { mode: 0o755 })
    const invoke = context => spawnSync('bash', [script, context], {
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, INGRESS_TEST_DIR: work }, encoding: 'utf8',
    })
    for (const context of ['production', 'kind-']) assert.notEqual(invoke(context).status, 0)
    const result = invoke('kind-test')
    assert.equal(result.status, 0, result.stderr)
    const applied = JSON.parse(readFileSync(`${work}/state.json`, 'utf8'))
    assert.deepEqual(applied.items.filter(obj => obj.kind !== 'Job'), manifest.items.filter(obj => obj.kind !== 'Job'))
    const completed = readFileSync(`${work}/completed.jsonl`, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(completed.sort(), jobs.slice().sort())
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('live surface proof exposes setup errors while preserving cleanup and evidence', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const work = mkdtempSync(`${tmpdir()}/falcone-kind-error-`)
  try {
    writeFileSync(`${work}/kind`, `#!/bin/sh
case "$1" in
  create) echo 'setup failed: stand-in diagnostic' >&2; exit 1 ;;
  delete) echo deleted > "$SURFACE_TEST_DIR/deleted" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 })
    const result = spawnSync('python3', [`${umbrellaChart}/../../tests/blackbox/kind-quickstart/kind-quickstart-surface.py`], {
      env: { ...process.env, PATH: `${work}:${process.env.PATH}`, SURFACE_TEST_DIR: work,
        KIND_QUICKSTART_EVIDENCE: `${work}/evidence.json`, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /setup failed: stand-in diagnostic/)
    assert.equal(readFileSync(`${work}/deleted`, 'utf8').trim(), 'deleted')
    const evidence = JSON.parse(readFileSync(`${work}/evidence.json`, 'utf8'))
    assert.equal(evidence.status, 'FAIL')
    assert.equal(evidence.error_type, 'CalledProcessError')
    assert.equal(evidence.cluster_deleted, true)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
