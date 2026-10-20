import assert from 'node:assert/strict'
import { sha256 } from './blackbox.mjs'
import { withPriorFunctionSecretProjection } from './function-secret-projection-snapshot.mjs'

// Compose #970's checked RBAC delta with #19's independently tested baseline
// file, auto-reload flags and checksum annotation; retain historical hashes.
export function withPriorBaselineAlerts(objects) {
  const prior = withPriorFunctionSecretProjection(objects)
  const config = prior.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-prometheus-config')
  assert.ok(config)
  assert.equal(sha256(config.data['baseline.rules.yml']), 'dfa8afbcf3920113105f18e0a9714df6718212330ff48cd8b20a12ef53c7959f')
  delete config.data['baseline.rules.yml']
  const entry = '  - /etc/prometheus/baseline.rules.yml\n'
  assert.ok(config.data['prometheus.yml'].includes(entry))
  config.data['prometheus.yml'] = config.data['prometheus.yml'].replace(entry, '')
  const pod = prior.find((o) => o.kind === 'Deployment' && o.metadata.name === 'falcone-bbx-observability').spec.template
  const checksum = 'in-falcone.io/alert-rules-checksum'
  assert.match(pod.metadata.annotations[checksum], /^[a-f0-9]{64}$/)
  delete pod.metadata.annotations[checksum]
  const flags = ['--enable-feature=auto-reload-config', '--config.auto-reload-interval=30s']
  for (const flag of flags) assert.equal(pod.spec.containers[0].args.filter((arg) => arg === flag).length, 1)
  pod.spec.containers[0].args = pod.spec.containers[0].args.filter((arg) => !flags.includes(arg))
  return prior
}
