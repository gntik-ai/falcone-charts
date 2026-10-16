import assert from 'node:assert/strict'
import test from 'node:test'
import { render, run, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

const expectedRules = [
  ['FalconeScrapeTargetDown', '5m', 'warning', 'A Falcone scrape target is down'],
  ['FalconeControlPlaneUnavailable', '5m', 'critical', 'No control-plane metrics target is up'],
  ['FalconeExecutorUnavailable', '5m', 'critical', 'No control-plane-executor metrics target is up'],
  ['FalconeHighErrorRatio', '10m', 'warning', 'Falcone HTTP 5xx ratio is above the threshold'],
  ['FalconeGatewayHighErrorRatio', '10m', 'warning', 'Gateway 5xx ratio is above the threshold'],
  ['FalconeLatencyObjectiveBreach', '15m', 'warning', 'Too many Falcone requests are slower than the latency threshold'],
  ['FalconeTSDBHeadSeriesOverBudget', '15m', 'warning', 'Prometheus head series exceed the configured budget'],
  ['FalconeScrapeSampleLimitHit', '0m', 'warning', 'A scrape exceeded observability.scrapeLimits.sampleLimit and was rejected'],
  ['FalconeRuleEvaluationFailures', '0m', 'warning', 'Prometheus rule evaluation is failing'],
  ['FalconePrometheusConfigReloadFailed', '5m', 'warning', 'Prometheus failed to reload its configuration'],
  ['FalconeSecretBackendAuthDegraded', '5m', 'critical', 'Control-plane secret-backend authentication is degraded'],
  ['FalconeSecretBackendAuthFailing', '0m', 'warning', 'Control-plane secret-backend authentication is failing repeatedly'],
]
const config = (objects) => objects.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-prometheus-config')
const group = (objects) => yamlDocuments(config(objects).data['baseline.rules.yml'])[0].groups[0]
const ruleFiles = (objects) => yamlDocuments(config(objects).data['prometheus.yml'])[0].rule_files
const workload = (objects, name = 'observability') => objects.find((o) => o.kind === 'Deployment' && o.spec.template.metadata.labels['app.kubernetes.io/name'] === name)
const expr = (objects, index) => group(objects).rules[index - 1].expr

test('defaults load the twelve specified baseline alerts alongside flow-audit', () => {
  const { objects } = render(umbrellaChart)
  assert.deepEqual(ruleFiles(objects), ['/etc/prometheus/flow-audit.rules.yml', '/etc/prometheus/baseline.rules.yml'])
  assert.equal(group(objects).name, 'falcone-baseline')
  assert.deepEqual(group(objects).rules.map((r) => [r.alert, r.for, r.labels.severity, r.annotations.summary]), expectedRules)
  for (const rule of group(objects).rules) assert.doesNotMatch(rule.expr, /kube_|alertmanager/)
  assert.equal(expr(objects, 2), 'absent(up{job="falcone-control-plane"} == 1)')
  assert.equal(expr(objects, 3), 'absent(up{job="falcone-control-plane-executor"} == 1)')
  assert.ok(!objects.some((o) => o.kind === 'PrometheusRule'))
})

test('operator rule is capability-gated and identical to the bundled group', () => {
  const { objects } = render(umbrellaChart, ['--api-versions', 'monitoring.coreos.com/v1/PrometheusRule'])
  const operator = objects.find((o) => o.kind === 'PrometheusRule' && o.metadata.name.endsWith('-baseline'))
  assert.ok(operator)
  assert.deepEqual(operator.spec.groups, [group(objects)])
})

const reloadFlags = ['--enable-feature=auto-reload-config', '--config.auto-reload-interval=30s']
const checksumKey = 'in-falcone.io/alert-rules-checksum'
function assertReload(objects, name = 'observability') {
  const pod = workload(objects, name).spec.template
  const container = pod.spec.containers[0]
  for (const flag of reloadFlags) assert.equal(container.args.filter((a) => a === flag).length, 1)
  assert.ok(!container.args.includes('--web.enable-lifecycle'))
  assert.match(pod.metadata.annotations[checksumKey], /^[a-f0-9]{64}$/)
  const mount = container.volumeMounts.find((m) => m.mountPath === '/etc/prometheus')
  assert.ok(mount)
  assert.equal(mount.subPath, undefined)
  assert.equal(mount.subPathExpr, undefined)
  return pod.metadata.annotations[checksumKey]
}

test('Prometheus always reloads rules with default args and checksum', () => {
  const { objects } = render(umbrellaChart)
  assertReload(objects)
  // Other dependencies must never inherit the Prometheus flags or annotation.
  const cp = workload(objects, 'control-plane').spec.template
  assert.equal(cp.metadata.annotations[checksumKey], undefined)
  assert.ok(!(cp.spec.containers[0].args ?? []).some((a) => reloadFlags.includes(a)))
})

test('args overrides and component aliases retain automatic reload', () => {
  const override = ['--set-json', 'observability.args=["--config.file=/etc/prometheus/prometheus.yml"]']
  assertReload(render(umbrellaChart, override).objects)
  const podArgs = [...override, '--set', 'observability.serviceAccount.automountToken=true', '--set', 'controlPlane.wrapper.componentId=api']
  const { objects } = render(umbrellaChart, podArgs)
  assert.equal(expr(objects, 2), 'absent(up{job="falcone-pods",component="api"} == 1)')
  assertReload(objects)
  assertReload(render(umbrellaChart, [...override, '--set', 'observability.wrapper.componentId=metrics-custom']).objects, 'metrics-custom')
  // A partial override must not duplicate a supplied flag.
  assertReload(render(umbrellaChart, ['--set-json', `observability.args=${JSON.stringify([reloadFlags[0]])}`]).objects)
})

test('checksum is deterministic and responds to baseline enablement and thresholds', () => {
  const checksum = (args = []) => assertReload(render(umbrellaChart, args).objects)
  const original = checksum()
  assert.equal(checksum(), original)
  assert.notEqual(checksum(['--set', 'observability.alerts.enabled=false']), original)
  assert.notEqual(checksum(['--set', 'observability.alerts.errorRatio=0.12']), original)
})

test('threshold values drive the rendered expressions and missing stored keys use defaults', () => {
  const { objects } = render(umbrellaChart, ['--set', 'observability.alerts.errorRatio=0.12',
    '--set', 'observability.alerts.latencyThresholdSeconds=2.5', '--set', 'observability.alerts.latencyObjective=0.99',
    '--set', 'observability.alerts.headSeriesBudget=123456', '--set', 'observability.alerts.secretAuthFailureThreshold=7'])
  assert.ok(expr(objects, 4).endsWith(' > 0.12'))
  assert.ok(expr(objects, 5).endsWith(' > 0.12'))
  assert.equal(expr(objects, 6), String.raw`1 - (sum by (component) (rate(falcone_http_request_duration_seconds_bucket{le=~"2.5(\\.0)?"}[30m])) / sum by (component) (rate(falcone_http_request_duration_seconds_count[30m]))) > (1 - 0.99)`)
  assert.equal(expr(objects, 7), 'prometheus_tsdb_head_series > 123456')
  assert.ok(expr(objects, 12).endsWith(' >= 7'))
  const defaults = render(umbrellaChart).objects
  const reused = render(umbrellaChart, ['--set', 'observability.alerts=null']).objects
  assert.deepEqual(group(reused), group(defaults))
  assertReload(reused)
  assert.match(expr(defaults, 6), /le=~"1\(\\\\\.0\)\?"/)
  for (const t of ['0.25', '0.5', '1', '2.5', '5', '10']) {
    const rendered = render(umbrellaChart, ['--set', `observability.alerts.latencyThresholdSeconds=${t}`]).objects
    assert.ok(expr(rendered, 6).includes(`le=~"${t}(\\\\.0)?"`))
  }
})

for (const id of ['x'.repeat(70), `${'x'.repeat(62)}-${'x'.repeat(7)}`]) {
  for (const podDiscovery of [false, true]) {
    test(`availability matches rendered pod identities for ${id.length}-char ID (${id[62]}) with pod discovery ${podDiscovery}`, () => {
      const { objects } = render(umbrellaChart, ['--set', `observability.serviceAccount.automountToken=${podDiscovery}`,
        '--set-string', `controlPlane.wrapper.componentId=${id}`, '--set-string', `controlPlaneExecutor.wrapper.componentId=${id}e`])
      const deployments = objects.filter((o) => o.kind === 'Deployment')
      for (const [index, alias, job] of [[2, 'controlPlane', 'falcone-control-plane'], [3, 'controlPlaneExecutor', 'falcone-control-plane-executor']]) {
        // Chart alias identifies the caller; the actual pod label is the independent oracle.
        const deployment = deployments.find((o) => o.metadata.labels['helm.sh/chart'].startsWith(`${alias}-`))
        assert.ok(deployment)
        const label = deployment.spec.template.metadata.labels['app.kubernetes.io/name']
        assert.equal(expr(objects, index), podDiscovery
          ? `absent(up{job="falcone-pods",component="${label}"} == 1)`
          : `absent(up{job="${job}"} == 1)`)
      }
      assert.deepEqual(group(objects).rules.map((r) => r.alert), expectedRules.map((r) => r[0]))
    })
  }
}

test('each toggle removes only its file and both off omit rule_files', () => {
  const capability = ['--api-versions', 'monitoring.coreos.com/v1/PrometheusRule']
  const baselineOff = render(umbrellaChart, [...capability, '--set', 'observability.alerts.enabled=false']).objects
  assert.equal(config(baselineOff).data['baseline.rules.yml'], undefined)
  assert.deepEqual(ruleFiles(baselineOff), ['/etc/prometheus/flow-audit.rules.yml'])
  assert.ok(!baselineOff.some((o) => o.kind === 'PrometheusRule' && o.metadata.name.endsWith('-baseline')))
  const auditOff = render(umbrellaChart, ['--set', 'flowAudit.alerts.enabled=false']).objects
  assert.equal(config(auditOff).data['flow-audit.rules.yml'], undefined)
  assert.deepEqual(ruleFiles(auditOff), ['/etc/prometheus/baseline.rules.yml'])
  const bothOff = render(umbrellaChart, ['--set', 'flowAudit.alerts.enabled=false', '--set', 'observability.alerts.enabled=false']).objects
  assert.equal(ruleFiles(bothOff), undefined)
  assert.doesNotMatch(config(bothOff).data['prometheus.yml'], /rule_files:/)
})


test('invalid histogram thresholds fail clearly', () => {
  for (const threshold of ['0.75', '0', '-1', 'invalid']) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', `observability.alerts.latencyThresholdSeconds=${threshold}`])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /observability.alerts.latencyThresholdSeconds must be one of 0.25, 0.5, 1, 2.5, 5 or 10/)
  }
})


test('disabled baseline still rejects an invalid histogram threshold', () => {
  const result = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', 'observability.alerts.enabled=false',
    '--set', 'observability.alerts.latencyThresholdSeconds=0.75'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /observability.alerts.latencyThresholdSeconds must be one of/)
})
