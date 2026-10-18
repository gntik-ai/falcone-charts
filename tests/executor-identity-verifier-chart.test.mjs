import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { render, repoRoot, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

function executorEnv(objects) {
  const deployment = objects.find(object => object.kind === 'Deployment'
    && object.metadata.name === 'falcone-bbx-control-plane-executor')
  assert.ok(deployment, 'executor Deployment must render')
  return deployment.spec.template.spec.containers[0].env
}

for (const [profile, args] of [
  ['default', []],
  ['staging', ['-f', resolve(umbrellaChart, 'values/staging-argocd.yaml')]],
]) {
  test(`${profile} configures JWT verification without the development opt-in`, () => {
    const { objects } = render(umbrellaChart, args)
    const config = objects.find(object => object.kind === 'ConfigMap'
      && object.metadata.name === 'falcone-bbx-executor-jwt-config')
    assert.ok(config, 'executor JWT ConfigMap must render')
    assert.equal(typeof config.data.KEYCLOAK_JWKS_URL, 'string')
    assert.ok(config.data.KEYCLOAK_JWKS_URL.trim().length > 0, 'executor JWKS URL must be non-empty')
    const env = executorEnv(objects)
    assert.deepEqual(env.filter(entry => entry.name === 'KEYCLOAK_JWKS_URL'), [{
      name: 'KEYCLOAK_JWKS_URL',
      valueFrom: { configMapKeyRef: { name: config.metadata.name, key: 'KEYCLOAK_JWKS_URL' } },
    }])
    assert.equal(env.some(entry => entry.name === 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY'), false)
  })
}

test('kind-advanced explicitly permits unverified identity for local development', () => {
  const { objects } = render(umbrellaChart, [
    '-f', resolve(repoRoot, 'deploy/kind/values-kind.yaml'),
    '-f', resolve(repoRoot, 'deploy/kind/values-kind-advanced.yaml'),
  ])
  assert.deepEqual(executorEnv(objects).filter(entry => entry.name === 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY'),
    [{ name: 'EXECUTOR_ALLOW_UNVERIFIED_IDENTITY', value: 'true' }])
})
