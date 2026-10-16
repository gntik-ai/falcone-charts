import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSuccess, run, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

function scrapeTopology(args = [], release = 'falcone-bbx') {
  const result = run('helm', ['template', release, umbrellaChart,
    '--namespace', 'falcone-bbx', ...args], { timeout: 0 })
  assertSuccess(result, 'render Prometheus scrape limits')
  const objects = yamlDocuments(result.stdout)
  const config = objects.find((object) => object.kind === 'ConfigMap'
    && object.metadata.name === `${release}-prometheus-config`)
  assert.ok(config, 'the mounted Prometheus configuration must exist')
  return { objects, jobs: yamlDocuments(config.data['prometheus.yml'])[0].scrape_configs }
}

test('token-less installs scrape each control-plane workload once through metrics-only headless DNS', () => {
  for (const args of [[], ['--set', 'observability.serviceAccount.automountToken=false'],
    ['--set', 'observability.serviceAccount.automountToken=null'],
    ['--set', 'controlPlane.service.port=18080', '--set', 'controlPlaneExecutor.service.port=18081'],
  ]) {
    const { objects, jobs } = scrapeTopology(args)
    assert.equal(jobs.some((job) => job.job_name === 'falcone-pods'), false,
      'unauthenticated pod discovery must not overlap the workload jobs')
    for (const component of ['control-plane', 'control-plane-executor']) {
      const workload = objects.find((object) => object.kind === 'Deployment'
        && object.metadata.name === `falcone-bbx-${component}`)
      const owners = jobs.filter((job) => job.job_name === `falcone-${component}`
        || job.kubernetes_sd_configs?.some((config) => config.role === 'pod'))
      assert.equal(owners.length, 1, `${component} must have exactly one owning job`)
      const [job] = owners
      assert.equal(job.static_configs, undefined, 'ClusterIP and static targets cannot represent replicas')
      assert.deepEqual(job.dns_sd_configs, [{
        names: [`falcone-bbx-${component}-metrics.falcone-bbx.svc.cluster.local`], type: 'A', port: 8080,
      }])
      assert.deepEqual(job.relabel_configs, [{ target_label: 'component', replacement: component }])
      const service = objects.find((object) => object.kind === 'Service'
        && object.metadata.name === `falcone-bbx-${component}-metrics`)
      assert.ok(service, 'DNS discovery requires a chart-owned metrics Service')
      assert.equal(service.spec.clusterIP, 'None')
      assert.deepEqual(service.spec.selector, workload.spec.selector.matchLabels)
      assert.deepEqual(service.spec.ports, [{ name: 'metrics', port: 8080, targetPort: 8080, protocol: 'TCP' }])
      assert.equal(job.sample_limit, 1000000)
      assert.equal(job.label_value_length_limit, 512)
    }
  }
})

test('headless metrics names stay distinct for long release names and follow component aliases and pod ports', () => {
  for (const release of ['falcone-bbx', `falcone-${'x'.repeat(40)}`]) {
    const { objects, jobs } = scrapeTopology([
      '--set', 'controlPlane.wrapper.componentId=api', '--set', 'controlPlaneExecutor.wrapper.componentId=worker',
      '--set-string', 'controlPlane.podAnnotations.prometheus\\.io/port=9081',
      '--set-string', 'controlPlaneExecutor.podAnnotations.prometheus\\.io/port=9082',
    ], release)
    const services = objects.filter((object) => object.kind === 'Service'
      && object.metadata.name.endsWith('-metrics'))
    assert.equal(new Set(services.map((service) => service.metadata.name)).size, 2)
    for (const [name, component, port] of [
      ['falcone-control-plane', 'api', 9081], ['falcone-control-plane-executor', 'worker', 9082],
    ]) {
      const service = services.find((object) => object.spec.selector['app.kubernetes.io/name'] === component)
      assert.ok(service)
      assert.ok(service.metadata.name.length <= 63)
      const job = jobs.find((entry) => entry.job_name === name)
      assert.deepEqual(job.dns_sd_configs, [{ names: [`${service.metadata.name}.falcone-bbx.svc.cluster.local`], type: 'A', port }])
      assert.deepEqual(job.relabel_configs, [{ target_label: 'component', replacement: component }])
      assert.deepEqual(service.spec.ports, [{ name: 'metrics', port, targetPort: port, protocol: 'TCP' }])
    }
  }
  const { objects } = scrapeTopology([], `falcone-${'x'.repeat(40)}`)
  const names = objects.filter((object) => object.kind === 'Service'
    && object.metadata.name.endsWith('-metrics')).map((object) => object.metadata.name)
  assert.equal(new Set(names).size, 2, 'truncation must not collapse control-plane and executor discovery')
})

test('authenticated installs use only namespace-scoped pod discovery with existing component relabeling', () => {
  const { objects, jobs } = scrapeTopology(['--set', 'observability.serviceAccount.automountToken=true'])
  assert.deepEqual(jobs.filter((job) => job.job_name.startsWith('falcone-')
    && job.job_name !== 'falcone-apisix').map((job) => job.job_name), ['falcone-pods'])
  assert.equal(objects.some((object) => object.kind === 'Service'
    && object.metadata.name.endsWith('-metrics') && object.spec.clusterIP === 'None'), false)
  const job = jobs.find((entry) => entry.job_name === 'falcone-pods')
  assert.deepEqual(job.kubernetes_sd_configs, [{ role: 'pod', namespaces: { names: ['falcone-bbx'] } }])
  assert.deepEqual(job.relabel_configs, [
    { source_labels: ['__meta_kubernetes_pod_annotation_prometheus_io_scrape'], action: 'keep', regex: 'true' },
    { source_labels: ['__meta_kubernetes_pod_annotation_prometheus_io_path'], action: 'replace',
      target_label: '__metrics_path__', regex: '(.+)' },
    { source_labels: ['__address__', '__meta_kubernetes_pod_annotation_prometheus_io_port'], action: 'replace',
      regex: '([^:]+)(?::\\d+)?;(\\d+)', replacement: '$1:$2', target_label: '__address__' },
    { source_labels: ['__meta_kubernetes_pod_label_app_kubernetes_io_name'], action: 'replace', target_label: 'component' },
    { source_labels: ['__meta_kubernetes_namespace'], action: 'replace', target_label: 'namespace' },
    { source_labels: ['__meta_kubernetes_pod_name'], action: 'replace', target_label: 'pod' },
  ])
  for (const component of ['control-plane', 'control-plane-executor']) {
    const pod = objects.find((object) => object.kind === 'Deployment'
      && object.metadata.name === `falcone-bbx-${component}`).spec.template
    assert.equal(pod.metadata.annotations['prometheus.io/scrape'], 'true')
    assert.equal(pod.metadata.labels['app.kubernetes.io/name'], component)
  }
})

test('Falcone scrape jobs enforce configurable limits with safe historical defaults', () => {
  for (const podDiscovery of [false, true]) {
    for (const [args, samples, length] of [
      [[], 1000000, 512],
      [['--set', 'observability.scrapeLimits.sampleLimit=750000',
        '--set', 'observability.scrapeLimits.labelValueLengthLimit=1024'], 750000, 1024],
      [['--set', 'observability.scrapeLimits=null'], 1000000, 512],
      [['--set', 'observability.scrapeLimits.sampleLimit=null',
        '--set', 'observability.scrapeLimits.labelValueLengthLimit=null'], 1000000, 512],
    ]) {
      const { jobs } = scrapeTopology([...args, '--set', `observability.serviceAccount.automountToken=${podDiscovery}`])
      const expected = podDiscovery ? ['falcone-pods'] : ['falcone-control-plane', 'falcone-control-plane-executor']
      const falconeJobs = jobs.filter((job) => job.job_name.startsWith('falcone-') && job.job_name !== 'falcone-apisix')
      assert.deepEqual(falconeJobs.map((job) => job.job_name), expected)
      for (const name of expected) {
        const job = jobs.find((entry) => entry.job_name === name)
        assert.ok(job, `${name} must remain configured`)
        assert.equal(job.sample_limit, samples, `${name} sample limit`)
        assert.equal(job.label_value_length_limit, length, `${name} label value length limit`)
      }
      for (const name of ['prometheus', 'falcone-apisix']) {
        const job = jobs.find((entry) => entry.job_name === name)
        assert.equal(job.sample_limit, undefined, `${name} is outside this change`)
        assert.equal(job.label_value_length_limit, undefined, `${name} is outside this change`)
      }
    }
  }
})

test('scrape limits reject values that disable limits or produce invalid Prometheus config', () => {
  for (const key of ['sampleLimit', 'labelValueLengthLimit']) {
    for (const value of ['0', '-1', '1.5', 'invalid']) {
      const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
        '--set', `observability.scrapeLimits.${key}=${value}`], { timeout: 0 })
      assert.notEqual(result.status, 0, `${key}=${value} must be rejected`)
      assert.match(result.stderr, new RegExp(key))
    }
  }
})
