import assert from 'node:assert/strict'

// Preserve the existing umbrella snapshots while asserting the exact #15 delta.
// All resources other than the new policy and write-disable env remain covered.
export function withPriorTemporalWeb(objects) {
  const prior = structuredClone(objects)
  const name = 'falcone-bbx-temporal-web'
  const policies = prior.filter((object) => object.kind === 'NetworkPolicy' && object.metadata.name === name)
  assert.equal(policies.length, 1, 'the reviewed default UI ingress policy must exist exactly once')
  const deployment = prior.find((object) => object.kind === 'Deployment' && object.metadata.name === name)
  assert.ok(deployment, 'the default UI Deployment remains installed')
  assert.deepEqual(policies[0].metadata.labels, deployment.metadata.labels)
  assert.deepEqual(policies[0].spec, {
    podSelector: { matchLabels: deployment.spec.selector.matchLabels },
    policyTypes: ['Ingress'],
    ingress: [],
  })
  const container = deployment.spec.template.spec.containers.find((entry) => entry.name === 'temporal-web')
  assert.deepEqual(container.env.filter((entry) => entry.name === 'TEMPORAL_DISABLE_WRITE_ACTIONS'), [
    { name: 'TEMPORAL_DISABLE_WRITE_ACTIONS', value: 'true' },
  ])
  container.env = container.env.filter((entry) => entry.name !== 'TEMPORAL_DISABLE_WRITE_ACTIONS')
  return prior.filter((object) => object !== policies[0])
}
