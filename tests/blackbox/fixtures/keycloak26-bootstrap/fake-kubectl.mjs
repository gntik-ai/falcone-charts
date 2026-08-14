#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const logFile = process.env.FALCONE_BBX_KUBECTL_LOG
const traceFile = process.env.FALCONE_BBX_TRACE_LOG
const markerHash = process.env.FALCONE_BBX_MARKER_HASH
const scenario = process.env.FALCONE_BBX_KEYCLOAK_SCENARIO ?? 'success'

let index = 0
if (args[index] === '-n' || args[index] === '--namespace') index += 2
const verb = args[index]
const resource = args[index + 1] ?? null
const name = args[index + 2] ?? null

const call = { name, resource, verb }
appendFileSync(logFile, `${JSON.stringify(call)}\n`)
appendFileSync(traceFile, `${JSON.stringify({ source: 'kubectl', ...call })}\n`)

if (verb === 'get' && resource === 'configmap' && name === 'in-falcone-bootstrap-lock') process.exit(1)

if (verb === 'get' && resource === 'configmap' && name === 'in-falcone-bootstrap-state') {
  if (!scenario.startsWith('fresh-')) process.stdout.write(markerHash)
  process.exit(0)
}

if (verb === 'create' && resource === 'configmap' && name === 'in-falcone-bootstrap-state') {
  process.stdout.write(`apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n`)
  process.exit(0)
}

if (verb === 'apply') {
  for await (const _chunk of process.stdin) {
    // Consume the public dry-run ConfigMap manifest supplied on stdin.
  }
  process.exit(0)
}

if (['create', 'delete', 'label', 'annotate'].includes(verb) && resource === 'configmap') process.exit(0)

process.stderr.write(`[bbx fake kubectl] unsupported public request: ${args.join(' ')}\n`)
process.exit(64)
