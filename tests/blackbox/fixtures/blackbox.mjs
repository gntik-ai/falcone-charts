import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const fixtureDir = dirname(fileURLToPath(import.meta.url))

export const repoRoot = resolve(fixtureDir, '../../..')
export const umbrellaChart = resolve(repoRoot, 'charts/in-falcone')
export const managedChart = resolve(repoRoot, 'charts/falcone-knative')
export const cli = process.env.FALCONE_KNATIVE_BIN
  ? resolve(process.env.FALCONE_KNATIVE_BIN)
  : resolve(repoRoot, 'bin/falcone-knative')
export const fakeBin = resolve(fixtureDir, 'fake-bin')

export function run(file, args = [], options = {}) {
  return spawnSync(file, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

export function combined(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

export function assertSuccess(result, context) {
  assert.equal(
    result.status,
    0,
    `${context} failed (exit ${result.status}):\n${combined(result)}`,
  )
}

export function assertFailure(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly succeeded:\n${combined(result)}`)
}

export function requireManagedChart() {
  assert.ok(
    existsSync(resolve(managedChart, 'Chart.yaml')),
    `managed chart is absent: expected public chart ${resolve(managedChart, 'Chart.yaml')}`,
  )
}

export function requireCli() {
  assert.ok(existsSync(cli), `managed lifecycle CLI is absent: expected ${cli}`)
  assert.equal(basename(cli), 'falcone-knative', 'public lifecycle executable basename must be falcone-knative')
}

export function yamlDocuments(text) {
  const script = [
    'import json, sys, yaml',
    'docs = [d for d in yaml.safe_load_all(sys.stdin.read()) if d is not None]',
    'json.dump(docs, sys.stdout, default=str)',
  ].join('; ')
  const result = run('python3', ['-c', script], { input: text })
  assertSuccess(result, 'YAML decoding')
  return JSON.parse(result.stdout)
}

export function readYaml(file) {
  const docs = yamlDocuments(readFileSync(file, 'utf8'))
  assert.equal(docs.length, 1, `${file} must contain one YAML document`)
  return docs[0]
}

export function render(chart, args = []) {
  const result = run('helm', ['template', 'falcone-bbx', chart, '--namespace', 'falcone-bbx', ...args])
  assertSuccess(result, `helm template ${chart}`)
  return { text: result.stdout, objects: yamlDocuments(result.stdout) }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function workloadPodSpecs(objects) {
  const specs = []
  for (const object of objects) {
    let podSpec
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet'].includes(object?.kind)) {
      podSpec = object?.spec?.template?.spec
    } else if (object?.kind === 'Job') {
      podSpec = object?.spec?.template?.spec
    } else if (object?.kind === 'CronJob') {
      podSpec = object?.spec?.jobTemplate?.spec?.template?.spec
    }
    if (podSpec) specs.push({ object, podSpec })
  }
  return specs
}

export function allContainers(objects) {
  return workloadPodSpecs(objects).flatMap(({ object, podSpec }) => [
    ...(podSpec.initContainers ?? []).map((container) => ({ object, podSpec, container })),
    ...(podSpec.containers ?? []).map((container) => ({ object, podSpec, container })),
  ])
}

export function imageReferences(objects) {
  return allContainers(objects).map(({ container }) => container.image).filter(Boolean)
}

export function findValuePath(root, predicate, path = []) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null
  const entries = Object.entries(root)
  for (const [key, value] of entries) {
    if (predicate({ key, value, path: [...path, key] })) return [...path, key]
  }
  for (const [key, value] of entries) {
    const found = findValuePath(value, predicate, [...path, key])
    if (found) return found
  }
  return null
}

export function setArg(path, value, string = false) {
  assert.ok(path, 'required public chart value was not found in values.yaml')
  return [string ? '--set-string' : '--set', `${path.join('.')}=${value}`]
}

export function publicManagedValueArgs({ platform, registry, disconnected } = {}) {
  requireManagedChart()
  const values = readYaml(resolve(managedChart, 'values.yaml'))
  const args = []

  if (platform) {
    let path
    if (typeof values.platform === 'string') path = ['platform']
    else if (values.platform && typeof values.platform.type === 'string') path = ['platform', 'type']
    else if (values.global && typeof values.global.platform === 'string') path = ['global', 'platform']
    assert.ok(path, 'falcone-knative values.yaml must expose a public Kubernetes/OpenShift platform selector')
    args.push(...setArg(path, platform, true))
  }

  if (registry) {
    const path = findValuePath(values, ({ key, value, path: candidate }) => (
      typeof value === 'string'
      && /registry/i.test(key)
      && !/status|release/i.test(candidate.join('.'))
    ))
    args.push(...setArg(path, registry, true))
  }

  if (disconnected !== undefined) {
    const path = findValuePath(values, ({ key, value, path: candidate }) => (
      key === 'disconnected'
      && typeof value === 'boolean'
      && !/status/i.test(candidate.join('.'))
    )) ?? findValuePath(values, ({ key, value, path: candidate }) => (
      key === 'enabled'
      && typeof value === 'boolean'
      && candidate.some((part) => /disconnect|airgap|offline/i.test(part))
    ))
    args.push(...setArg(path, String(disconnected)))
  }

  return args
}

function readLog(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

export function invokeCli(args, scenario, extra = {}) {
  requireCli()
  const work = mkdtempSync(resolve(tmpdir(), 'falcone-knative-bbx-'))
  const kubectlLog = resolve(work, 'kubectl.jsonl')
  const helmLog = resolve(work, 'helm.jsonl')
  const curlLog = resolve(work, 'curl.jsonl')
  const realHelm = run('sh', ['-c', 'command -v helm']).stdout.trim()
  const result = run(cli, args, {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      KUBECONFIG: resolve(fixtureDir, 'offline-kubeconfig.yaml'),
      FALCONE_BBX_SCENARIO: scenario,
      FALCONE_BBX_OWNER: 'bbx-owner',
      FALCONE_BBX_KUBECTL_LOG: kubectlLog,
      FALCONE_BBX_HELM_LOG: helmLog,
      FALCONE_BBX_CURL_LOG: curlLog,
      FALCONE_BBX_REAL_HELM: realHelm,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: 'localhost,127.0.0.1',
      ...extra.env,
    },
    ...extra.options,
  })
  return {
    result,
    kubectlCalls: readLog(kubectlLog),
    helmCalls: readLog(helmLog),
    curlCalls: readLog(curlLog),
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  }
}

export const mutationVerbs = new Set([
  'annotate', 'apply', 'create', 'delete', 'edit', 'label', 'patch', 'replace', 'rollout',
  'scale', 'set', 'taint',
])

export function commandVerb(call) {
  return (call.args ?? []).find((arg) => /^[a-z][a-z-]+$/.test(arg) && [
    ...mutationVerbs, 'api-resources', 'auth', 'describe', 'exec', 'get', 'logs', 'version', 'wait',
  ].includes(arg))
}

export function mutationCalls(invocation) {
  return [
    ...invocation.kubectlCalls.filter((call) => mutationVerbs.has(commandVerb(call))),
    ...invocation.helmCalls.filter((call) => ['install', 'upgrade', 'rollback', 'uninstall'].includes(commandVerb(call))),
  ]
}

export function callText(calls) {
  return calls.map((call) => `${(call.args ?? []).join(' ')}\n${call.stdin ?? ''}`).join('\n')
}

export function assertSecretSafe(text) {
  for (const forbidden of ['token', 'kubeconfig', 'credential', 'pull secret', 'tenant name']) {
    assert.doesNotMatch(text.toLowerCase(), new RegExp(`(?:^|[^a-z])${forbidden.replace(' ', '\\s+')}[^a-z]`), `evidence leaked forbidden field: ${forbidden}`)
  }
  assert.ok(Buffer.byteLength(text) <= 16 * 1024, `evidence must be bounded to 16 KiB, got ${Buffer.byteLength(text)}`)
}

export const verifiedTargetArgs = [
  '--api-server', 'https://api.bbx.example.test:6443',
  '--cluster-uid', '00000000-0000-4000-8000-000000000008',
  '--infrastructure-name', 'bbx-ocp421',
  '--infrastructure-id', 'bbx-ocp421-x8',
  '--run-id', 'bbx-issue-8',
  '--release', 'falcone-knative',
  '--status-namespace', 'knative-serving',
  '--status-configmap', 'falcone-knative-status',
]
