import assert from 'node:assert/strict'
import test from 'node:test'
import { render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'
import { withPriorJwtPolicy } from './blackbox/fixtures/jwt-policy-snapshot.mjs'

test('historical render normalization rejects unreviewed JWT policy changes', () => {
  const { objects } = render(umbrellaChart)
  const config = docs => docs.find(o => o.kind === 'ConfigMap' && o.metadata.name.endsWith('-executor-jwt-config'))
  const deployment = docs => docs.find(o => o.kind === 'Deployment' && o.metadata.name.endsWith('-control-plane'))
  const script = docs => docs.find(o => o.kind === 'ConfigMap' && o.data?.['bootstrap.sh'])
  for (const mutate of [
    docs => { config(docs).data.KEYCLOAK_PLATFORM_AUDIENCES = '["foreign"]' },
    docs => { deployment(docs).spec.template.spec.containers[0].env.find(e => e.name === 'KEYCLOAK_ISSUER').valueFrom.configMapKeyRef.name = 'foreign' },
    docs => { script(docs).data['bootstrap.sh'] = script(docs).data['bootstrap.sh'].replace('ensure_console_audience "$token"', ':') },
  ]) {
    const changed = structuredClone(objects)
    mutate(changed)
    assert.throws(() => withPriorJwtPolicy(changed))
  }
})

test('historical render normalization preserves unrelated drift and the original render', () => {
  const { objects } = render(umbrellaChart)
  const script = docs => docs.find(o => o.kind === 'ConfigMap' && o.data?.['bootstrap.sh'])
  script(objects).data['bootstrap.sh'] += '\n# unrelated drift\n'
  const original = structuredClone(objects)
  const prior = withPriorJwtPolicy(objects)
  assert.ok(script(prior).data['bootstrap.sh'].endsWith('\n# unrelated drift\n'))
  assert.deepEqual(objects, original)
})
