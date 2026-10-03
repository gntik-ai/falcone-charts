import assert from 'node:assert/strict'

// Keep the immutable root-identity snapshots. Assert the exact reviewed identity
// delta before comparing every other byte against those snapshots.
export function withPriorIdentityRule(objects) {
  const prior = structuredClone(objects)
  const rules = prior.filter((object) => object.kind === 'Ingress')
    .flatMap((object) => object.spec.rules ?? [])
    .filter((rule) => rule.host === 'iam.dev.in-falcone.example.com')
  assert.equal(rules.length, 1, 'default identity must have exactly one Ingress rule')
  const service = { name: 'falcone-bbx-keycloak', port: { name: 'http' } }
  assert.deepEqual(rules[0].http.paths, ['/realms', '/resources', '/js'].map((path) => ({
    path, pathType: 'Prefix', backend: { service },
  })), 'snapshot exception is limited to the reviewed identity paths and backend')
  rules[0].http.paths = [{ path: '/', pathType: 'Prefix', backend: { service } }]
  return prior
}
