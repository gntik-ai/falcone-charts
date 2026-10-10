import assert from 'node:assert/strict'
import test from 'node:test'

import { assertSuccess, run, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

const falconeJobs = ['falcone-control-plane', 'falcone-control-plane-executor', 'falcone-pods']

function scrapeJobs(args = []) {
  const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
    '--namespace', 'falcone-bbx', ...args], { timeout: 0 })
  assertSuccess(result, 'render Prometheus scrape limits')
  const config = yamlDocuments(result.stdout).find((object) => object.kind === 'ConfigMap'
    && object.metadata.name === 'falcone-bbx-prometheus-config')
  assert.ok(config, 'the mounted Prometheus configuration must exist')
  return yamlDocuments(config.data['prometheus.yml'])[0].scrape_configs
}

test('Falcone scrape jobs enforce configurable limits with safe historical defaults', () => {
  for (const [args, samples, length] of [
    [[], 1000000, 512],
    [['--set', 'observability.scrapeLimits.sampleLimit=750000',
      '--set', 'observability.scrapeLimits.labelValueLengthLimit=1024'], 750000, 1024],
    [['--set', 'observability.scrapeLimits=null'], 1000000, 512],
    [['--set', 'observability.scrapeLimits.sampleLimit=null',
      '--set', 'observability.scrapeLimits.labelValueLengthLimit=null'], 1000000, 512],
  ]) {
    const jobs = scrapeJobs(args)
    for (const name of falconeJobs) {
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
