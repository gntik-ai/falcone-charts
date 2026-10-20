import assert from 'node:assert/strict'

// Check #970's complete permission additions before subtracting them. Historical
// hashes continue to cover every other rule, binding and rendered object.
export function withPriorFunctionSecretProjection(objects) {
  const prior = structuredClone(objects)
  const roles = prior.filter((object) => object.kind === 'Role'
    && object.metadata.name === 'falcone-bbx-function-executor')
  assert.equal(roles.length, 1, 'the Function executor Role must exist exactly once')
  const role = roles[0]
  assert.deepEqual(role.rules.slice(1, 5), [
    { apiGroups: [''], resources: ['secrets'], verbs: ['create', 'get', 'update', 'patch', 'delete'] },
    { apiGroups: ['serving.knative.dev'], resources: ['configurations'], verbs: ['list'] },
    { apiGroups: ['serving.knative.dev'], resources: ['revisions'], verbs: ['list', 'delete'] },
    { apiGroups: ['apps'], resources: ['deployments', 'replicasets'], verbs: ['list'] },
  ], 'only the exact reviewed Function Secret lifecycle and remediation permissions may be subtracted')
  role.rules.splice(1, 4)
  return prior
}
