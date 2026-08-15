/**
 * Regression contract for falcone#986.
 *
 * APISIX 3.10 defaults the Prometheus plugin's dedicated export server to
 * enabled, which suppresses the public-api handler. Falcone scrapes the public
 * gateway path instead, so the deployment config must explicitly disable the
 * dedicated server. Because the APISIX entrypoint rewrites config.yaml in
 * standalone mode, the override must be mounted writably (emptyDir overlay
 * populated by an init container), not read-only from a ConfigMap.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { render, umbrellaChart } from '../fixtures/blackbox.mjs'

test('staging disables the APISIX dedicated export server for the scraped public-api path', () => {
  const { objects } = render(umbrellaChart, ['-f', `${umbrellaChart}/values/staging.yaml`])
  const deployment = objects.find((object) => (
    object?.kind === 'Deployment' && /-apisix$/.test(object?.metadata?.name ?? '')
  ))
  assert.ok(deployment, 'APISIX Deployment was not rendered')
  const podSpec = deployment.spec?.template?.spec
  const container = podSpec?.containers?.find((candidate) => candidate.name === 'apisix')
  assert.ok(container, 'apisix container was not rendered')

  // The config.yaml override must be mounted over the writable path (the entrypoint
  // rewrites it in standalone mode, so a read-only ConfigMap mount would crash it).
  const configMount = (container.volumeMounts ?? []).find((mount) => mount.mountPath === '/usr/local/apisix/conf/config.yaml')
  assert.ok(configMount, 'APISIX config.yaml override is not mounted')
  assert.equal(configMount.subPath, 'config.yaml', 'config.yaml mount must target the config.yaml key')
  const overlayVolume = (podSpec.volumes ?? []).find((volume) => volume.name === configMount.name)
  assert.ok(overlayVolume, 'APISIX config.yaml mount references no volume')
  assert.ok(overlayVolume.emptyDir, 'config.yaml must be backed by a writable emptyDir overlay, not a read-only ConfigMap')

  // An init container must populate the writable overlay from the chart-owned ConfigMap.
  const init = (podSpec.initContainers ?? []).find((candidate) => candidate.name === 'apisix-config-overlay')
  assert.ok(init, 'apisix-config-overlay init container was not rendered')

  const config = objects.find((object) => (
    object?.kind === 'ConfigMap' && /-apisix-config-file$/.test(object?.metadata?.name ?? '')
  ))
  assert.ok(config, 'apisix-config-file ConfigMap was not rendered')
  assert.match(
    config.data?.['config.yaml'] ?? '',
    /plugin_attr:\s*\n\s+prometheus:\s*\n\s+enable_export_server:\s*false(?:\s|$)/,
    'config.yaml must set plugin_attr.prometheus.enable_export_server=false',
  )
})

test('Prometheus keeps scraping the APISIX public-api metrics path on port 9080', () => {
  const { objects } = render(umbrellaChart, ['-f', `${umbrellaChart}/values/staging.yaml`])
  const config = objects.find((object) => (
    object?.kind === 'ConfigMap' && /-prometheus-config$/.test(object?.metadata?.name ?? '')
  ))
  assert.ok(config, 'Prometheus ConfigMap was not rendered')
  const prometheus = config.data?.['prometheus.yml'] ?? ''
  assert.match(prometheus, /job_name:\s*falcone-apisix/)
  assert.match(prometheus, /metrics_path:\s*["']?\/apisix\/prometheus\/metrics["']?/)
  assert.match(prometheus, /apisix[^\n]*:9080/)
})
