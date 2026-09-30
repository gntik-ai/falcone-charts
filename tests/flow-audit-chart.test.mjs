import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { render, repoRoot, sha256, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const priorBaseline = '26c5dc19ecbb5054fc3a8565852c89def7f2456793010fe320d0fa046e56087b'
const additions = [
  'ConfigMap/falcone-bbx-in-falcone-flow-audit-grants',
  'Job/falcone-bbx-in-falcone-flow-audit-grants',
  'Job/falcone-bbx-in-falcone-flow-audit-topic',
  'PrometheusRule/falcone-bbx-in-falcone-flow-audit',
]

function canonical(value, field = '') {
  if (field === 'propagatedAuthHeaders' && typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean).sort().join(',')
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], key)]))
  }
  return value
}

function flowAuditObjects(objects) {
  return objects.filter((object) => String(object.metadata?.labels?.['in-falcone.io/component'] ?? '').startsWith('flow-audit-'))
}

test('default render adds exactly the reviewed flow-audit objects', () => {
  const { objects } = render(umbrellaChart)
  const added = flowAuditObjects(objects)
  assert.deepEqual(added.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(), additions.slice().sort())
  assert.equal(sha256(JSON.stringify(canonical(objects.filter((object) => !added.includes(object))))), priorBaseline)
  const expected = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/umbrella-default-render.sha256'), 'utf8').trim()
  assert.equal(sha256(JSON.stringify(canonical(objects))), expected)

  const topic = added.find((object) => object.metadata.name.endsWith('-flow-audit-topic'))
  const env = topic.spec.template.spec.containers[0].env
  assert.equal(env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC').value, 'falcone.audit.flow-lifecycle')
  assert.match(topic.metadata.annotations['helm.sh/hook'], /post-upgrade/)
  const grants = added.find((object) => object.kind === 'ConfigMap')
  assert.match(grants.data['migration.sql'], /REVOKE ALL PRIVILEGES ON TABLE public\.flow_audit_outbox FROM PUBLIC/)
  assert.match(grants.data['migration.sql'], /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.flow_audit_outbox TO falcone/)
  const rule = added.find((object) => object.kind === 'PrometheusRule')
  assert.deepEqual(rule.spec.groups[0].rules.map(({ alert }) => alert), [
    'FalconeFlowAuditBacklog', 'FalconeFlowAuditFailed', 'FalconeFlowAuditRelayStale',
  ])
})

test('older reused values render the same flow-audit defaults', () => {
  const { objects } = render(umbrellaChart, ['--set', 'flowAudit=null'])
  const added = flowAuditObjects(objects)
  assert.deepEqual(added.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(), additions.slice().sort())
  const topic = added.find((object) => object.metadata.name.endsWith('-flow-audit-topic'))
  assert.equal(topic.spec.template.spec.containers[0].env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC').value,
    'falcone.audit.flow-lifecycle')
})
