import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { render, repoRoot, sha256, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

const priorBaseline = '26c5dc19ecbb5054fc3a8565852c89def7f2456793010fe320d0fa046e56087b'
const additions = [
  'ConfigMap/falcone-bbx-in-falcone-flow-audit-grants',
  'Job/falcone-bbx-in-falcone-flow-audit-grants',
  'Job/falcone-bbx-in-falcone-flow-audit-topic',
]
const prometheusConfigName = 'falcone-bbx-prometheus-config'
const observabilityName = 'falcone-bbx-observability'
const rolloutAnnotation = 'in-falcone.io/flow-audit-rules-version'
const ruleFile = '/etc/prometheus/flow-audit.rules.yml'
const ruleFilesBlock = `rule_files:\n  - ${ruleFile}\n`
const ruleNames = ['FalconeFlowAuditBacklog', 'FalconeFlowAuditFailed', 'FalconeFlowAuditRelayStale']

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

function prometheusConfig(objects) {
  return objects.find((object) => object.kind === 'ConfigMap' && object.metadata.name === prometheusConfigName)
}

test('default render adds exactly the reviewed flow-audit objects and bundled rules', () => {
  const { objects } = render(umbrellaChart)
  const added = flowAuditObjects(objects)
  assert.deepEqual(added.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(), additions.slice().sort())
  const prometheus = prometheusConfig(objects)
  assert.deepEqual(yamlDocuments(prometheus.data['prometheus.yml'])[0].rule_files, [ruleFile])
  const rules = yamlDocuments(prometheus.data['flow-audit.rules.yml'])[0].groups
  assert.deepEqual(rules[0].rules.map(({ alert }) => alert), ruleNames)

  const observability = objects.find((object) => object.kind === 'Deployment' && object.metadata.name === observabilityName)
  assert.equal(observability.spec.template.metadata.annotations[rolloutAnnotation], '1')

  // The only changes to pre-existing objects are Prometheus rule loading and its rollout marker.
  const priorObjects = structuredClone(objects.filter((object) => !added.includes(object)))
  const priorPrometheus = prometheusConfig(priorObjects)
  delete priorPrometheus.data['flow-audit.rules.yml']
  assert.ok(priorPrometheus.data['prometheus.yml'].includes(ruleFilesBlock))
  priorPrometheus.data['prometheus.yml'] = priorPrometheus.data['prometheus.yml'].replace(ruleFilesBlock, '')
  const priorObservability = priorObjects.find((object) => object.kind === 'Deployment' && object.metadata.name === observabilityName)
  delete priorObservability.spec.template.metadata.annotations[rolloutAnnotation]
  if (Object.keys(priorObservability.spec.template.metadata.annotations).length === 0) {
    delete priorObservability.spec.template.metadata.annotations
  }
  assert.equal(sha256(JSON.stringify(canonical(priorObjects))), priorBaseline)
  const expected = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/umbrella-default-render.sha256'), 'utf8').trim()
  assert.equal(sha256(JSON.stringify(canonical(objects))), expected)

  const topic = added.find((object) => object.metadata.name.endsWith('-flow-audit-topic'))
  assert.equal(topic.spec.template.spec.containers[0].env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC').value,
    'falcone.audit.flow-lifecycle')
  assert.match(topic.metadata.annotations['helm.sh/hook'], /post-upgrade/)
  assert.equal(topic.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true)
  assert.deepEqual(topic.spec.template.spec.containers[0].volumeMounts.map((mount) => mount.mountPath).sort(),
    ['/opt/bitnami/kafka/logs', '/tmp'])
  const grants = added.find((object) => object.kind === 'ConfigMap')
  assert.match(grants.data['migration.sql'], /REVOKE ALL PRIVILEGES ON TABLE public\.flow_audit_outbox FROM PUBLIC/)
  assert.match(grants.data['migration.sql'], /current_setting\('flow_audit\.executor_role'\)/)
  const grantsJob = added.find((object) => object.kind === 'Job' && object.metadata.name.endsWith('-flow-audit-grants'))
  assert.equal(grantsJob.spec.template.spec.containers[0].env.find((entry) => entry.name === 'FLOW_AUDIT_EXECUTOR_ROLE').valueFrom.secretKeyRef.key,
    'POSTGRESQL_USERNAME')
  for (const job of added.filter((object) => object.kind === 'Job')) {
    assert.equal(job.spec.template.spec.securityContext.seccompProfile.type, 'RuntimeDefault')
  }
})

test('older reused values render the same flow-audit defaults', () => {
  const { objects } = render(umbrellaChart, ['--set', 'flowAudit=null'])
  const added = flowAuditObjects(objects)
  assert.deepEqual(added.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(), additions.slice().sort())
  const topic = added.find((object) => object.metadata.name.endsWith('-flow-audit-topic'))
  assert.equal(topic.spec.template.spec.containers[0].env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC').value,
    'falcone.audit.flow-lifecycle')
  assert.deepEqual(yamlDocuments(prometheusConfig(objects).data['prometheus.yml'])[0].rule_files, [ruleFile])
  const observability = objects.find((object) => object.kind === 'Deployment' && object.metadata.name === observabilityName)
  assert.equal(observability.spec.template.metadata.annotations[rolloutAnnotation], '1')
})

test('operator rule renders only when its CRD is available and matches bundled Prometheus', () => {
  const { objects } = render(umbrellaChart, ['--api-versions', 'monitoring.coreos.com/v1/PrometheusRule'])
  const added = flowAuditObjects(objects)
  assert.deepEqual(added.map(({ kind, metadata }) => `${kind}/${metadata.name}`).sort(),
    [...additions, 'PrometheusRule/falcone-bbx-in-falcone-flow-audit'].sort())
  const rule = added.find((object) => object.kind === 'PrometheusRule')
  assert.deepEqual(rule.spec.groups, yamlDocuments(prometheusConfig(objects).data['flow-audit.rules.yml'])[0].groups)
})

test('disabled alerts leave no rule file or operator rule', () => {
  const { objects } = render(umbrellaChart, ['--set', 'flowAudit.alerts.enabled=false',
    '--api-versions', 'monitoring.coreos.com/v1/PrometheusRule'])
  assert.equal(flowAuditObjects(objects).some((object) => object.kind === 'PrometheusRule'), false)
  const prometheus = prometheusConfig(objects)
  assert.equal(prometheus.data['flow-audit.rules.yml'], undefined)
  assert.equal(yamlDocuments(prometheus.data['prometheus.yml'])[0].rule_files, undefined)
})
