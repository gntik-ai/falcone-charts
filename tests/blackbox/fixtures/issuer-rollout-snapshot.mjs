import assert from 'node:assert/strict'

// #81: subtract only the three issuer rollout annotations from the default render.
export function withPriorIssuerRollout(objects) {
  const prior = structuredClone(objects)
  for (const component of ['apisix', 'control-plane', 'control-plane-executor']) {
    const pod = prior.find(o => o.kind === 'Deployment' && o.metadata.name === `falcone-bbx-${component}`).spec.template
    const key = 'in-falcone.io/issuer-config-checksum'
    assert.match(pod.metadata.annotations[key], /^[a-f0-9]{64}$/)
    delete pod.metadata.annotations[key]
    if (!Object.keys(pod.metadata.annotations).length) delete pod.metadata.annotations
  }
  return prior
}
