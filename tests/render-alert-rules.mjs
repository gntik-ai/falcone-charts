import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, umbrellaChart } from './blackbox/fixtures/blackbox.mjs'

const [directory, ...args] = process.argv.slice(2)
if (!directory) throw new Error('Usage: node tests/render-alert-rules.mjs <directory> [helm template arguments]')
const { objects } = render(umbrellaChart, args)
const config = objects.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'falcone-bbx-prometheus-config')
mkdirSync(directory, { recursive: true })
for (const file of ['flow-audit.rules.yml', 'baseline.rules.yml']) {
  if (!config?.data[file]) throw new Error(`Rendered Prometheus configuration is missing ${file}`)
  writeFileSync(resolve(directory, file), config.data[file])
}
