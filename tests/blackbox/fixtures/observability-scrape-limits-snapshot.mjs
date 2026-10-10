import assert from 'node:assert/strict'

// Preserve the approved historical render hash while subtracting only #982's
// independently tested scrape limits from the mounted Prometheus configuration.
export function withPriorScrapeLimits(objects) {
  const prior = structuredClone(objects)
  const config = prior.find((object) => object.kind === 'ConfigMap'
    && object.metadata.name === 'falcone-bbx-prometheus-config')
  assert.ok(config, 'the mounted Prometheus config must remain present')
  for (const name of ['falcone-control-plane', 'falcone-control-plane-executor', 'falcone-pods']) {
    const prefix = `  - job_name: ${name}\n${name === 'falcone-pods' ? '' : '    metrics_path: /metrics\n'}`
    const limited = `${prefix}    sample_limit: 1000000\n    label_value_length_limit: 512\n`
    assert.ok(config.data['prometheus.yml'].includes(limited), `${name} must enforce the reviewed defaults`)
    config.data['prometheus.yml'] = config.data['prometheus.yml'].replace(limited, prefix)
  }
  return prior
}
