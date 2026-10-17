import assert from 'node:assert/strict'
import test from 'node:test'
import { withPriorApisixStandaloneDefault } from './blackbox/fixtures/apisix-standalone-default-snapshot.mjs'
import { assertSuccess, readYaml, repoRoot, run, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

const configName = 'falcone-apisix-standalone'
const streams = ['public-api-realtime-collection-changes', 'public-api-realtime-table-changes']
const defaults = readYaml(`${umbrellaChart}/values.yaml`)
const routeIds = readYaml(`${umbrellaChart}/files/apisix/standalone/apisix.yaml`).routes
  .map((route) => String(route.id)).filter((id) => id !== '2016-rt')

function render(args = [], namespace = 'falcone') {
  const result = run('helm', ['template', 'falcone', umbrellaChart, '--namespace', namespace, ...args], { timeout: 0 })
  assertSuccess(result, 'standalone route render')
  // Only public ConfigMaps and the gateway Deployment are inspected; no Secret values are emitted.
  return yamlDocuments(result.stdout).filter((object) => object.kind !== 'Secret')
}

function gateway(objects) {
  const deployments = objects.filter((object) => object.kind === 'Deployment' && object.metadata.name === 'falcone-apisix')
  assert.equal(deployments.length, 1)
  return deployments[0].spec.template.spec
}

function routeConfig(objects) {
  const configs = objects.filter((object) => object.kind === 'ConfigMap' && object.metadata.name === configName)
  assert.equal(configs.length, 1, 'standalone APISIX must receive exactly one chart-owned route table')
  assert.deepEqual(Object.keys(configs[0].data), ['apisix.yaml'])
  return configs[0].data['apisix.yaml']
}

function assertRoutes(objects, mode, configuredRoutes, namespace = 'falcone') {
  const text = routeConfig(objects)
  const routes = yamlDocuments(text)[0].routes
  for (const id of routeIds) assert.equal(routes.filter((route) => String(route.id) === id).length, 1, `route ${id}`)
  assert.equal(routes.some((route) => String(route.id) === '2016-rt'), false)
  for (const name of streams) {
    const configured = configuredRoutes.find((route) => route.name === name)
    const enabled = !configured?.enabledInModes || configured.enabledInModes.includes(mode)
    assert.equal(routes.filter((route) => route.id === name).length, enabled ? 1 : 0, `${name} in mode ${mode}`)
    assert.equal(routes.filter((route) => route.name === name).length, enabled ? 1 : 0)
  }
  const hosts = [...text.matchAll(/([a-zA-Z0-9.-]+)\.svc\.cluster\.local/g)].map(([host]) => host)
  assert.ok(hosts.length > 0)
  for (const host of hosts) assert.ok(host.endsWith(`.${namespace}.svc.cluster.local`), `upstream ${host} uses release namespace`)
  if (namespace !== 'falcone') assert.equal(text.includes('.falcone.svc.cluster.local'), false)

  const pod = gateway(objects)
  const apisix = pod.containers.find((container) => container.name === 'apisix')
  assert.ok(apisix)
  assert.deepEqual(apisix.env.filter((entry) => entry.name === 'APISIX_STAND_ALONE'), [{ name: 'APISIX_STAND_ALONE', value: 'true' }])
  assert.deepEqual(pod.volumes.filter((volume) => volume.name === 'standalone-config'), [
    { name: 'standalone-config', configMap: { name: configName, defaultMode: 420 } },
  ])
  assert.deepEqual(apisix.volumeMounts.filter((mount) => mount.name === 'standalone-config' || mount.mountPath === '/usr/local/apisix/conf/apisix.yaml'), [
    { name: 'standalone-config', mountPath: '/usr/local/apisix/conf/apisix.yaml', subPath: 'apisix.yaml' },
  ])
}

test('defaults provision the standalone route table and mount', () => {
  assertRoutes(render(), defaults.gatewayPolicy.passthrough.mode, defaults.bootstrap.reconcile.apisix.routes)
})

test('kind retains its externally managed route table and single mount', () => {
  const objects = render(['-f', `${repoRoot}/deploy/kind/values-kind.yaml`])
  assert.equal(objects.some((object) => object.kind === 'ConfigMap' && object.metadata.name === configName), false)
  const pod = gateway(objects)
  assert.deepEqual(pod.volumes.filter((volume) => volume.name === 'standalone-config'), [
    { name: 'standalone-config', configMap: { name: configName } },
  ])
  assert.deepEqual(pod.containers.find((container) => container.name === 'apisix').volumeMounts
    .filter((mount) => mount.name === 'standalone-config' || mount.mountPath === '/usr/local/apisix/conf/apisix.yaml'), [
      { name: 'standalone-config', mountPath: '/usr/local/apisix/conf/apisix.yaml', subPath: 'apisix.yaml' },
    ])
})

for (const profile of [
  'prod', 'dev', 'sandbox', 'airgap', 'customer-reference', 'platform-kubernetes',
  'platform-kubernetes-loadbalancer', 'platform-openshift', 'staging',
  'profiles/all-in-one', 'profiles/ha', 'profiles/standard',
]) {
  test(`${profile} provisions the standalone route table and mount`, () => {
    const path = `${umbrellaChart}/values/${profile}.yaml`
    const overlay = readYaml(path)
    assertRoutes(render(['-f', path]), overlay.gatewayPolicy?.passthrough?.mode ?? defaults.gatewayPolicy.passthrough.mode,
      overlay.bootstrap?.reconcile?.apisix?.routes ?? defaults.bootstrap.reconcile.apisix.routes)
  })
}

test('standalone upstreams follow a different release namespace', () => {
  assertRoutes(render([], 'route-test'), defaults.gatewayPolicy.passthrough.mode,
    defaults.bootstrap.reconcile.apisix.routes, 'route-test')
})

test('stream kill switch omits only the disabled route in the active gateway mode', () => {
  const routes = defaults.bootstrap.reconcile.apisix.routes.map((route) => route.name === streams[0]
    ? { ...route, enabledInModes: [] } : route)
  assertRoutes(render(['--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(routes)}`]),
    defaults.gatewayPolicy.passthrough.mode, routes)
})

test('standalone streams honor enabledInModes when passthrough is disabled', () => {
  const routes = defaults.bootstrap.reconcile.apisix.routes.map((route) => route.name === streams[0]
    ? { ...route, enabledInModes: ['enabled'] } : route)
  assertRoutes(render(['--set', 'gatewayPolicy.passthrough.mode=disabled',
    '--set-json', `bootstrap.reconcile.apisix.routes=${JSON.stringify(routes)}`]), 'disabled', routes)
})

test('old reused values may keep external route management without a route mount', () => {
  const volumes = [
    { name: 'apisix-config-source', configMap: { name: '{{ .Release.Name }}-apisix-config-file' } },
    { name: 'apisix-config-overlay', emptyDir: {} },
    { name: 'issuer-jwks-auth', configMap: { name: '{{ .Release.Name }}-issuer-jwks-auth' } },
  ]
  const mounts = [
    { name: 'apisix-config-overlay', mountPath: '/usr/local/apisix/conf/config.yaml', subPath: 'config.yaml' },
    { name: 'issuer-jwks-auth', mountPath: '/usr/local/apisix/falcone/apisix/plugins/issuer-jwks-auth.lua', subPath: 'issuer-jwks-auth.lua', readOnly: true },
  ]
  const objects = render(['--set', 'apisix.manageStandaloneRoutes=false',
    '--set-json', `apisix.extraVolumes=${JSON.stringify(volumes)}`,
    '--set-json', `apisix.extraVolumeMounts=${JSON.stringify(mounts)}`])
  assert.equal(objects.some((object) => object.kind === 'ConfigMap' && object.metadata.name === configName), false)
  const pod = gateway(objects)
  assert.equal(pod.volumes.some((volume) => volume.name === 'standalone-config'), false)
  assert.equal(pod.containers.find((container) => container.name === 'apisix').volumeMounts
    .some((mount) => mount.name === 'standalone-config' || mount.mountPath === '/usr/local/apisix/conf/apisix.yaml'), false)
})

test('snapshot subtraction rejects changes to each reviewed addition and preserves unrelated fields', () => {
  // Historical hash chains use this release and namespace.
  const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--namespace', 'falcone-bbx'], { timeout: 0 })
  assertSuccess(result, 'snapshot render')
  const objects = yamlDocuments(result.stdout).filter((object) => object.kind !== 'Secret')
  const prior = withPriorApisixStandaloneDefault(objects)
  assert.equal(objects.length - prior.length, 1)
  for (const mutate of [
    (copy) => { copy.find((o) => o.metadata.name === configName).metadata.labels.extra = 'unexpected' },
    (copy) => { copy.find((o) => o.metadata.name === configName).data.extra = 'unexpected' },
    (copy) => { copy.find((o) => o.metadata.name === configName).data['apisix.yaml'] += '\n# unexpected' },
    (copy) => { copy.find((o) => o.kind === 'Deployment' && o.metadata.name === 'falcone-bbx-apisix').spec.template.spec.volumes[0].configMap.defaultMode = 256 },
    (copy) => { copy.find((o) => o.kind === 'Deployment' && o.metadata.name === 'falcone-bbx-apisix').spec.template.spec.containers.find((c) => c.name === 'apisix').volumeMounts[0].readOnly = true },
  ]) {
    const copy = structuredClone(objects)
    mutate(copy)
    assert.throws(() => withPriorApisixStandaloneDefault(copy), assert.AssertionError)
  }
  const copy = structuredClone(objects)
  copy.find((o) => o.kind === 'Deployment' && o.metadata.name === 'falcone-bbx-apisix').spec.replicas = 17
  assert.equal(withPriorApisixStandaloneDefault(copy).find((o) => o.kind === 'Deployment'
    && o.metadata.name === 'falcone-bbx-apisix').spec.replicas, 17)
  assert.deepEqual(withPriorApisixStandaloneDefault(objects), prior, 'subtraction must not mutate its input')
})
