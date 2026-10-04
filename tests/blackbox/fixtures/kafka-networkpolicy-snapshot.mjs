import assert from 'node:assert/strict'

// Preserve the immutable umbrella snapshots while asserting the exact #16 addition.
// Removing only this checked policy keeps all pre-existing resources under the old hash.
export function withPriorKafkaNetworkPolicy(objects) {
  const policies = objects.filter((object) => object.kind === 'NetworkPolicy'
    && object.metadata.name === 'falcone-bbx-kafka-internal-only')
  assert.equal(policies.length, 1, 'the default Kafka ingress policy must exist exactly once')
  assert.equal(policies[0].metadata.namespace, 'falcone-bbx')
  assert.equal(policies[0].metadata.labels['app.kubernetes.io/managed-by'], 'Helm')
  assert.equal(policies[0].metadata.labels['app.kubernetes.io/component'], 'kafka')
  assert.deepEqual(policies[0].spec, {
    podSelector: { matchLabels: { 'app.kubernetes.io/name': 'kafka' } },
    policyTypes: ['Ingress'],
    ingress: [{
      from: [
        { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'control-plane' } } },
        { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'control-plane-executor' } } },
        { podSelector: { matchLabels: { 'in-falcone.io/component': 'flow-audit-topic' } } },
        { podSelector: { matchLabels: { 'app.kubernetes.io/name': 'kafka' } } },
      ],
      ports: [{ protocol: 'TCP', port: 9092 }],
    }],
  })
  return objects.filter((object) => object !== policies[0])
}
