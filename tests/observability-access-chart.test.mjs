import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { assertFailure, combined, render, repoRoot, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const defaults = render(umbrellaChart)
const policyName = (component) => `falcone-bbx-${component}-internal-only`

function resource(objects, kind, name) {
  const object = objects.find((entry) => entry.kind === kind && entry.metadata?.name === name)
  assert.ok(object, `${kind}/${name} must exist`)
  return object
}

function policy(objects, component) {
  return resource(objects, 'NetworkPolicy', policyName(component))
}

function container(objects, component) {
  return resource(objects, 'Deployment', `falcone-bbx-${component}`).spec.template.spec.containers
    .find((entry) => entry.name === component)
}

function env(objects, name) {
  return container(objects, 'grafana').env.find((entry) => entry.name === name)?.value
}

function assertRestricted(objects) {
  for (const component of ['observability', 'grafana']) {
    const { spec } = policy(objects, component)
    assert.deepEqual(spec.policyTypes, ['Ingress'])
    assert.equal(spec.egress, undefined, 'scrape, discovery and DNS egress stay unrestricted')
    for (const rule of spec.ingress) {
      assert.ok(rule.from?.length, 'an ingress rule must have explicit sources')
      for (const peer of rule.from) {
        assert.ok(Object.keys(peer).length, 'an empty peer admits every pod')
        for (const key of ['podSelector', 'namespaceSelector']) {
          if (peer[key]) assert.notDeepEqual(peer[key], {}, `${key} must not admit every pod`)
        }
      }
    }
  }
}

test('default Grafana requires login and disables embedding; Prometheus lifecycle is disabled', () => {
  assert.equal(env(defaults.objects, 'GF_AUTH_ANONYMOUS_ENABLED'), 'false')
  assert.equal(env(defaults.objects, 'GF_AUTH_ANONYMOUS_ORG_ROLE'), 'Viewer')
  assert.equal(env(defaults.objects, 'GF_SECURITY_ALLOW_EMBEDDING'), 'false')
  assert.deepEqual(container(defaults.objects, 'observability').args, [
    '--config.file=/etc/prometheus/prometheus.yml',
    '--storage.tsdb.path=/prometheus',
    '--storage.tsdb.retention.time=15d',
  ])
})

test('default policies select the actual release pods and admit only the intended clients', () => {
  for (const component of ['observability', 'grafana']) {
    const deployment = resource(defaults.objects, 'Deployment', `falcone-bbx-${component}`)
    const { spec, metadata } = policy(defaults.objects, component)
    assert.equal(metadata.namespace, 'falcone-bbx')
    assert.equal(metadata.labels['app.kubernetes.io/instance'], 'falcone-bbx')
    assert.deepEqual(spec.podSelector.matchLabels, deployment.spec.selector.matchLabels)
    for (const [key, value] of Object.entries(spec.podSelector.matchLabels)) {
      assert.equal(deployment.spec.template.metadata.labels[key], value)
    }
  }
  const service = resource(defaults.objects, 'Service', 'falcone-bbx-observability')
  assert.deepEqual(policy(defaults.objects, 'observability').spec.ingress, [{
    from: [
      { podSelector: policy(defaults.objects, 'grafana').spec.podSelector },
      { podSelector: policy(defaults.objects, 'observability').spec.podSelector },
    ],
    ports: [{ protocol: 'TCP', port: service.spec.ports[0].targetPort }],
  }])
  assert.deepEqual(policy(defaults.objects, 'grafana').spec.ingress, [])
  assertRestricted(defaults.objects)
})

test('anonymous access, org role and embedding require explicit values', () => {
  const { objects } = render(umbrellaChart, [
    '--set', 'grafana.auth.anonymous.enabled=true',
    '--set', 'grafana.auth.anonymous.orgRole=Editor',
    '--set', 'grafana.security.allowEmbedding=true',
  ])
  assert.equal(env(objects, 'GF_AUTH_ANONYMOUS_ENABLED'), 'true')
  assert.equal(env(objects, 'GF_AUTH_ANONYMOUS_ORG_ROLE'), 'Editor')
  assert.equal(env(objects, 'GF_SECURITY_ALLOW_EMBEDDING'), 'true')
  for (const component of ['observability', 'grafana']) {
    assert.deepEqual(policy(objects, component), policy(defaults.objects, component))
  }
})

test('missing historical Grafana settings retain secure defaults', () => {
  // Helm removes null-valued keys, matching the maps absent in stored old values.
  for (const keys of [
    ['grafana.auth', 'grafana.security', 'grafana.networkPolicy'],
    ['grafana.auth.anonymous', 'grafana.security.allowEmbedding', 'grafana.networkPolicy.enabled'],
    ['grafana.auth.anonymous.enabled', 'grafana.auth.anonymous.orgRole'],
  ]) {
    const { objects } = render(umbrellaChart, keys.flatMap((key) => ['--set', `${key}=null`]))
    assert.deepEqual(objects, defaults.objects)
  }
})

test('partially migrated Grafana settings preserve explicit opt-ins and policy opt-out', () => {
  const { objects } = render(umbrellaChart, [
    '--set', 'grafana.auth.anonymous.enabled=true',
    '--set', 'grafana.auth.anonymous.orgRole=null',
    '--set', 'grafana.security.allowEmbedding=true',
    '--set', 'grafana.networkPolicy.enabled=false',
    '--set', 'grafana.networkPolicy.allowedFrom=null',
  ])
  assert.equal(env(objects, 'GF_AUTH_ANONYMOUS_ENABLED'), 'true')
  assert.equal(env(objects, 'GF_AUTH_ANONYMOUS_ORG_ROLE'), 'Viewer')
  assert.equal(env(objects, 'GF_SECURITY_ALLOW_EMBEDDING'), 'true')
  assert.equal(objects.find((object) => object.kind === 'NetworkPolicy'
    && object.metadata.name === policyName('grafana')), undefined)
  assert.deepEqual(policy(objects, 'observability'), policy(defaults.objects, 'observability'))
})

test('configured peers appear verbatim and only on the component target port', () => {
  const peers = [
    {
      namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'operators' } },
      podSelector: { matchLabels: { app: 'authenticated-proxy' } },
    },
    { podSelector: { matchExpressions: [{ key: 'app', operator: 'In', values: ['monitoring'] }] } },
    { ipBlock: { cidr: '192.0.2.0/24', except: ['192.0.2.1/32'] } },
  ]
  const { objects } = render(umbrellaChart, [
    '--set-json', `observability.networkPolicy.allowedFrom=${JSON.stringify(peers)}`,
    '--set-json', `grafana.networkPolicy.allowedFrom=${JSON.stringify(peers)}`,
    '--set', 'observability.service.port=9191',
  ])
  const prometheusIngress = policy(objects, 'observability').spec.ingress
  assert.deepEqual(prometheusIngress[0].from, [
    ...policy(defaults.objects, 'observability').spec.ingress[0].from, ...peers,
  ])
  const servicePort = resource(objects, 'Service', 'falcone-bbx-observability').spec.ports[0]
  assert.equal(servicePort.port, 9191)
  assert.equal(servicePort.targetPort, 9090)
  assert.deepEqual(prometheusIngress[0].ports, [{ protocol: 'TCP', port: servicePort.targetPort }])
  assert.deepEqual(policy(objects, 'grafana').spec.ingress, [{
    from: peers, ports: [{ protocol: 'TCP', port: 3000 }],
  }])
  assertRestricted(objects)
})

test('Prometheus policy follows numeric and named Service targetPort overrides', () => {
  for (const targetPort of [9091, 'http']) {
    const args = ['--set', 'observability.service.port=9191',
      '--set', `observability.service.targetPort=${targetPort}`]
    if (typeof targetPort === 'number') {
      args.push('--set', `observability.ports[0].containerPort=${targetPort}`)
    }
    const { objects } = render(umbrellaChart, args)
    const servicePort = resource(objects, 'Service', 'falcone-bbx-observability').spec.ports[0]
    assert.equal(servicePort.port, 9191)
    assert.equal(servicePort.targetPort, targetPort)
    assert.deepEqual(policy(objects, 'observability').spec.ingress[0].ports,
      [{ protocol: 'TCP', port: servicePort.targetPort }])
    const containerPort = container(objects, 'observability').ports[0]
    assert.equal(typeof targetPort === 'number' ? containerPort.containerPort : containerPort.name, targetPort)
  }
})

test('Prometheus policy and self-peer follow wrapper componentId overrides and name truncation', () => {
  for (const componentId of ['metrics-custom', `metrics-${'x'.repeat(70)}`]) {
    const { objects } = render(umbrellaChart, ['--set', `observability.wrapper.componentId=${componentId}`])
    const deployment = objects.find((object) => object.kind === 'Deployment'
      && object.spec.selector.matchLabels['app.kubernetes.io/name'] === componentId.slice(0, 63))
    assert.ok(deployment)
    const prometheusPolicy = policy(objects, 'observability')
    assert.deepEqual(prometheusPolicy.spec.podSelector.matchLabels, deployment.spec.selector.matchLabels)
    assert.deepEqual(prometheusPolicy.spec.ingress[0].from[1].podSelector, prometheusPolicy.spec.podSelector)
  }
})

test('each policy can be disabled independently without changing any other resource', () => {
  for (const component of ['observability', 'grafana']) {
    const { objects } = render(umbrellaChart, ['--set', `${component}.networkPolicy.enabled=false`])
    assert.deepEqual(objects, defaults.objects.filter((object) => (
      object.kind !== 'NetworkPolicy' || object.metadata.name !== policyName(component)
    )), 'datasource, scrape config, workloads and the other policy must stay identical')
  }
})

test('schema rejects peers that would admit every pod and non-boolean security toggles', () => {
  const invalidPeers = [
    {}, { podSelector: {} }, { namespaceSelector: {} },
    { podSelector: { matchLabels: {} } }, { namespaceSelector: { matchExpressions: [] } },
  ]
  for (const component of ['observability', 'grafana']) {
    for (const peer of invalidPeers) {
      const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
        '--set-json', `${component}.networkPolicy.allowedFrom=${JSON.stringify([peer])}`])
      assertFailure(result, `${component} unrestricted peer`)
      assert.match(combined(result), /allowedFrom/)
    }
  }
  for (const key of [
    'grafana.auth.anonymous.enabled', 'grafana.security.allowEmbedding',
    'grafana.networkPolicy.enabled', 'observability.networkPolicy.enabled',
  ]) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set-string', `${key}=true`])
    assertFailure(result, `${key} non-boolean value`)
    assert.match(combined(result), /boolean/)
  }
})

test('kind, OpenShift and every staging overlay pass Helm schema validation with secure defaults', () => {
  const overlays = [
    'deploy/kind/values-kind.yaml',
    'deploy/openshift/values-openshift.yaml',
    ...readdirSync(resolve(umbrellaChart, 'values')).filter((name) => /^staging.*\.yaml$/.test(name))
      .map((name) => `charts/in-falcone/values/${name}`),
  ]
  for (const overlay of overlays) {
    const { objects } = render(umbrellaChart, ['-f', resolve(repoRoot, overlay)])
    assert.equal(env(objects, 'GF_AUTH_ANONYMOUS_ENABLED'), 'false', overlay)
    assert.equal(env(objects, 'GF_SECURITY_ALLOW_EMBEDDING'), 'false', overlay)
    assert.ok(!container(objects, 'observability').args.includes('--web.enable-lifecycle'), overlay)
    assertRestricted(objects)
  }
})
