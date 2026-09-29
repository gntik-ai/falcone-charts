import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import YAML from 'yaml'

import { assertFailure, assertSuccess, combined, run, umbrellaChart } from '../fixtures/blackbox.mjs'

const topic = 'falcone.audit.flow-lifecycle'

function render(args = []) {
  const result = run('helm', [
    'template', 'falcone', umbrellaChart, '--namespace', 'in-falcone-staging',
    '--show-only', 'templates/flow-audit-topic-job.yaml',
    '--show-only', 'charts/controlPlaneExecutor/templates/workload.yaml',
    '--show-only', 'charts/kafka/templates/workload.yaml',
    ...args,
  ])
  assertSuccess(result, 'Flow audit chart render')
  return YAML.parseAllDocuments(result.stdout).map((document) => document.toJS()).filter(Boolean)
}

for (const [profile, args] of [
  ['base', []],
  ['staging', ['-f', resolve(umbrellaChart, 'values/staging.yaml')]],
  ['staging GitOps', [
    '-f', resolve(umbrellaChart, 'values/staging.yaml'),
    '-f', resolve(umbrellaChart, 'values/staging-cluster.yaml'),
    '-f', resolve(umbrellaChart, 'values/staging-argocd.yaml'),
  ]],
]) {
  test(`${profile} provisions the platform Flow audit topic and configures the executor`, () => {
    const objects = render(args)
    const jobs = objects.filter((object) => object?.kind === 'Job' && object?.metadata?.labels?.['app.kubernetes.io/component'] === 'flow-audit-topic')
    assert.equal(jobs.length, 1)
    const job = jobs[0]
    assert.equal(job.metadata.annotations['helm.sh/hook'], 'post-install,post-upgrade')
    const provisioner = job.spec.template.spec.containers[0]
    assert.equal(provisioner.env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC')?.value, topic)
    assert.match(provisioner.command[2], /--create --if-not-exists/)
    assert.match(provisioner.command[2], /--describe --topic/)
    assert.match(provisioner.command[2], /--command-config "\$client_config"/)
    assert.match(provisioner.command[2], /class=\$failure_class attempts=\$attempt/)
    assert.doesNotMatch(provisioner.command[2], /cat .*stderr/)
    assert.equal(provisioner.securityContext.readOnlyRootFilesystem, true)
    assert.equal(job.spec.template.spec.securityContext.fsGroup, 1001)
    assert.deepEqual(provisioner.volumeMounts.map((mount) => mount.mountPath).sort(), ['/opt/bitnami/kafka/logs', '/tmp'])
    assert.deepEqual(job.spec.template.spec.volumes.map((volume) => volume.name).sort(), ['kafka-logs', 'tmp'])

    const broker = objects.find((object) => object?.kind === 'StatefulSet' && object?.metadata?.name === 'falcone-kafka')
    assert.ok(broker)
    assert.equal(provisioner.image, broker.spec.template.spec.containers[0].image)

    const executor = objects.find((object) => object?.kind === 'Deployment' && object?.metadata?.name === 'falcone-control-plane-executor')
    assert.ok(executor)
    const container = executor.spec.template.spec.containers[0]
    assert.equal(container.env.find((entry) => entry.name === 'FLOW_AUDIT_TOPIC')?.value, topic)
    if (profile === 'staging') assert.match(container.image, /@sha256:[a-f0-9]{64}$/)
  })
}

test('production transport overlay configures the topic Job for Kafka TLS', () => {
  const objects = render([
    '-f', resolve(umbrellaChart, '../../deploy/kind/values-kind.yaml'),
    '-f', resolve(umbrellaChart, '../../deploy/kind/values-production.yaml'),
  ])
  const job = objects.find((object) => object?.kind === 'Job' && object?.metadata?.labels?.['app.kubernetes.io/component'] === 'flow-audit-topic')
  assert.ok(job)
  const provisioner = job.spec.template.spec.containers[0]
  assert.equal(provisioner.env.find((entry) => entry.name === 'KAFKA_SSL')?.value, 'true')
  assert.equal(provisioner.env.find((entry) => entry.name === 'KAFKA_SSL_CA_FILE')?.value, '/etc/falcone/tls/ca.crt')
  assert.match(provisioner.command[2], /security\.protocol=SSL/)
  assert.match(provisioner.command[2], /ssl\.truststore\.type=PEM/)
  assert.match(provisioner.command[2], /ssl\.truststore\.location=%s/)
  assert.equal(provisioner.volumeMounts.find((mount) => mount.name === 'transport-ca')?.readOnly, true)
  assert.equal(provisioner.volumeMounts.find((mount) => mount.name === 'transport-ca')?.mountPath, '/etc/falcone/tls')
  assert.equal(job.spec.template.spec.volumes.find((volume) => volume.name === 'transport-ca')?.secret?.secretName, 'falcone-transport-ca')
})

test('Flow audit topic cannot enter the tenant events namespace', () => {
  const result = run('helm', [
    'template', 'falcone', umbrellaChart,
    '--set', 'global.flowAuditTopic=evt.workspace.flow-audit',
  ])
  assertFailure(result, 'tenant-prefixed Flow audit topic')
  assert.match(combined(result), /outside the evt\.<workspaceId> tenant namespace/)
})
