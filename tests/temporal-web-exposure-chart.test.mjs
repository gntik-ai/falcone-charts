import assert from 'node:assert/strict'
import test from 'node:test'

import { assertFailure, combined, render, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const webName = 'falcone-bbx-temporal-web'
const defaults = render(umbrellaChart)

function web(objects, kind) {
  return objects.find((object) => object.kind === kind && object.metadata?.name === webName)
}

function writeActionsValue(objects) {
  const container = web(objects, 'Deployment').spec.template.spec.containers.find((entry) => entry.name === 'temporal-web')
  return container.env.find((entry) => entry.name === 'TEMPORAL_DISABLE_WRITE_ACTIONS')?.value
}

function otherTemporalDocuments(text) {
  return text.split(/^---\s*$/m).filter((document) => (
    document.includes('# Source: in-falcone/templates/temporal/')
    && !document.includes(`  name: ${webName}\n`)
  ))
}

test('default UI has read-only settings and a default-deny ingress policy selecting its real pod', () => {
  const deployment = web(defaults.objects, 'Deployment')
  const policy = web(defaults.objects, 'NetworkPolicy')
  assert.ok(deployment)
  assert.ok(web(defaults.objects, 'Service'))
  assert.ok(policy)
  assert.deepEqual(policy.spec.policyTypes, ['Ingress'])
  assert.deepEqual(policy.spec.ingress, [])
  assert.deepEqual(policy.spec.podSelector.matchLabels, deployment.spec.selector.matchLabels)
  assert.deepEqual(policy.spec.podSelector.matchLabels, {
    'app.kubernetes.io/instance': 'falcone-bbx',
    'app.kubernetes.io/name': 'temporal-web',
    'temporal.io/role': 'web',
  })
  for (const [key, value] of Object.entries(policy.spec.podSelector.matchLabels)) {
    assert.equal(deployment.spec.template.metadata.labels[key], value)
  }
  assert.equal(writeActionsValue(defaults.objects), 'true')
  assert.equal(policy.spec.egress, undefined, 'UI egress to the frontend stays unrestricted')
  const frontend = defaults.objects.find((object) => object.kind === 'NetworkPolicy' && object.metadata.name.endsWith('-temporal-frontend'))
  assert.ok(frontend.spec.ingress[0].from.some((peer) => (
    peer.podSelector?.matchLabels?.['in-falcone.io/component'] === deployment.spec.template.metadata.labels['in-falcone.io/component']
  )), 'the existing frontend peer still admits the UI')
})

test('write actions can be opted into while keeping the default-deny UI policy', () => {
  const { objects } = render(umbrellaChart, ['--set', 'temporal.ui.disableWriteActions=false'])
  assert.equal(writeActionsValue(objects), 'false')
  assert.deepEqual(web(objects, 'NetworkPolicy'), web(defaults.objects, 'NetworkPolicy'))
})

test('allowedFrom admits only the configured peers on the UI target port', () => {
  const peers = [{
    namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'operators' } },
    podSelector: { matchLabels: { app: 'authenticated-proxy' } },
  }]
  const { objects } = render(umbrellaChart, [
    '--set-json', `temporal.ui.networkPolicy.allowedFrom=${JSON.stringify(peers)}`,
    '--set', 'temporal.ui.service.targetPort=9090',
  ])
  assert.deepEqual(web(objects, 'NetworkPolicy').spec.ingress, [{
    from: peers,
    ports: [{ protocol: 'TCP', port: 9090 }],
  }])
})

test('disabling the UI removes its Deployment, Service and policy without changing other Temporal resources', () => {
  const disabled = render(umbrellaChart, ['--set', 'temporal.ui.enabled=false'])
  for (const kind of ['Deployment', 'Service', 'NetworkPolicy']) {
    assert.equal(web(disabled.objects, kind), undefined)
  }
  assert.deepEqual(otherTemporalDocuments(disabled.text), otherTemporalDocuments(defaults.text))
})

test('read-only UI supports disabling NetworkPolicy explicitly', () => {
  const { objects } = render(umbrellaChart, ['--set', 'temporal.networkPolicy.enabled=false'])
  assert.equal(writeActionsValue(objects), 'true')
  assert.equal(web(objects, 'NetworkPolicy'), undefined)
})

test('non-boolean UI settings fail schema and template validation clearly', () => {
  for (const key of ['enabled', 'disableWriteActions']) {
    for (const extra of [[], ['--skip-schema-validation']]) {
      const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
        '--set-string', `temporal.ui.${key}=yes`, ...extra])
      assertFailure(result, `non-boolean temporal.ui.${key}`)
      assert.match(combined(result), new RegExp(`(?:temporal\\.ui\\.|temporal/ui/)${key}.*boolean`))
    }
  }
})

test('write-enabled UI fails closed when NetworkPolicy is disabled', () => {
  const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
    '--set', 'temporal.networkPolicy.enabled=false',
    '--set', 'temporal.ui.disableWriteActions=false'])
  assertFailure(result, 'write-enabled UI without NetworkPolicy')
  assert.match(combined(result), /write actions require the UI to be NetworkPolicy-restricted/)
})

test('string NetworkPolicy toggles cannot bypass the write-action safety gate', () => {
  const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
    '--set-string', 'temporal.networkPolicy.enabled=false',
    '--set', 'temporal.ui.disableWriteActions=false'])
  assertFailure(result, 'non-boolean NetworkPolicy toggle')
  assert.match(combined(result), /temporal.networkPolicy.enabled must be a boolean/)
})
