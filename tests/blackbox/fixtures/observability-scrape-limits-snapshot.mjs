import assert from 'node:assert/strict'

// Preserve the approved historical render hash while subtracting only #982's
// independently tested scrape limits from the mounted Prometheus configuration.
export function withPriorScrapeLimits(objects) {
  const prior = withPriorScrapeTopology(objects)
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

// Subtract only #18's independently tested default topology. Never regenerate the
// approved historical hashes or hide unrelated Service/configuration changes.
function withPriorScrapeTopology(objects) {
  const prior = structuredClone(objects)
  const config = prior.find((object) => object.kind === 'ConfigMap'
    && object.metadata.name === 'falcone-bbx-prometheus-config')
  assert.ok(config)
  assert.doesNotMatch(config.data['prometheus.yml'], /job_name: falcone-pods/)
  const services = []
  for (const component of ['control-plane', 'control-plane-executor']) {
    const service = prior.find((object) => object.kind === 'Service'
      && object.metadata.name === `falcone-bbx-${component}-metrics`)
    assert.ok(service, 'the reviewed headless Service must exist')
    assert.deepEqual(service, {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: `falcone-bbx-${component}-metrics`, labels: config.metadata.labels },
      spec: {
        clusterIP: 'None',
        selector: { 'app.kubernetes.io/name': component, 'app.kubernetes.io/instance': 'falcone-bbx' },
        ports: [{ name: 'metrics', port: 8080, targetPort: 8080, protocol: 'TCP' }],
      },
    })
    services.push(service)
    const prefix = `  - job_name: falcone-${component}\n    metrics_path: /metrics\n    sample_limit: 1000000\n    label_value_length_limit: 512\n`
    const discovery = `${prefix}    dns_sd_configs:\n      - names: ['falcone-bbx-${component}-metrics.falcone-bbx.svc.cluster.local']\n        type: A\n        port: 8080\n    relabel_configs:\n      - target_label: component\n        replacement: ${component}\n`
    const legacy = `${prefix}    static_configs:\n      - targets: ['falcone-bbx-${component}.falcone-bbx.svc.cluster.local:8080']\n        labels:\n          component: ${component === 'control-plane' ? component : 'executor'}\n`
    assert.ok(config.data['prometheus.yml'].includes(discovery), 'subtract only the reviewed DNS job')
    config.data['prometheus.yml'] = config.data['prometheus.yml'].replace(discovery, legacy)
  }
  config.data['prometheus.yml'] += priorPodJob
  return prior.filter((object) => !services.includes(object))
}

const priorPodJob = String.raw`  - job_name: falcone-pods
    sample_limit: 1000000
    label_value_length_limit: 512
    kubernetes_sd_configs:
      - role: pod
        namespaces:
          names:
            - falcone-bbx
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: "true"
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - source_labels: [__meta_kubernetes_pod_label_app_kubernetes_io_name]
        action: replace
        target_label: component
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        action: replace
        target_label: pod
`
