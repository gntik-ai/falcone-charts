/**
 * Public black-box contract for gntik-ai/falcone-charts#8.
 *
 * The suite invokes only Helm, the repository-distributed bin/falcone-knative executable, and a
 * process-isolated fake kubectl/helm/curl PATH. It never addresses a real Kubernetes API server.
 */
import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'

import {
  allContainers,
  assertFailure,
  assertSecretSafe,
  assertSuccess,
  callText,
  cli,
  combined,
  imageReferences,
  invokeCli,
  managedChart,
  mutationCalls,
  publicManagedValueArgs,
  readYaml,
  render,
  repoRoot,
  requireCli,
  requireManagedChart,
  run,
  sha256,
  umbrellaChart,
  verifiedTargetArgs,
  workloadPodSpecs,
  yamlDocuments,
} from '../fixtures/blackbox.mjs'

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function canonical(value, field = '') {
  if (field === 'propagatedAuthHeaders' && typeof value === 'string') {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean).sort().join(',')
  }
  if (Array.isArray(value)) return value.map((entry) => canonical(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], key)]))
  }
  return value
}

function packageManagedChart() {
  requireManagedChart()
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-knative-package-bbx-'))
  const result = run('helm', ['package', managedChart, '--destination', directory])
  assertSuccess(result, 'helm package charts/falcone-knative')
  const archives = readdirSync(directory).filter((name) => /^falcone-knative-.+\.tgz$/.test(name))
  assert.equal(archives.length, 1, 'Helm must publish exactly one separate falcone-knative package')
  const archive = resolve(directory, archives[0])
  const extract = resolve(directory, 'extract')
  const unpack = run('mkdir', ['-p', extract])
  assertSuccess(unpack, 'create package extraction directory')
  const untar = run('tar', ['-xzf', archive, '-C', extract])
  assertSuccess(untar, 'extract public falcone-knative Helm package')
  return { archive, chartRoot: resolve(extract, 'falcone-knative'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

function envMap(container) {
  return new Map((container.env ?? []).map((entry) => [entry.name, entry.value]))
}

function runtimeContainers(objects) {
  return allContainers(objects).filter(({ container }) => envMap(container).has('KNATIVE_RUNTIME_MODE'))
}

function assertNoServingLayerObjects(objects) {
  const forbiddenKinds = new Set([
    'ClusterServiceVersion', 'KnativeServing', 'OperatorGroup', 'Subscription',
  ])
  for (const object of objects) {
    assert.ok(!forbiddenKinds.has(object.kind), `umbrella rendered forbidden serving lifecycle kind ${object.kind}`)
    assert.notEqual(object.apiVersion, 'serving.knative.dev/v1', 'umbrella rendered a Knative Service')
    if (object.apiVersion === 'apiextensions.k8s.io/v1') {
      assert.doesNotMatch(JSON.stringify(object), /serving\.knative\.dev|knative|kourier/i, 'umbrella must not render managed Knative CRDs')
    }
    if (String(object.apiVersion).startsWith('admissionregistration.k8s.io/')) {
      assert.doesNotMatch(JSON.stringify(object), /knative|kourier/i, 'umbrella rendered a Knative admission webhook')
    }
  }
}

function findIndex(text, pattern, label) {
  const match = pattern.exec(text)
  assert.ok(match, `staged install log is missing ${label}`)
  return match.index
}

function assertLifecycleFailure(invocation, expected) {
  assertFailure(invocation.result, expected)
  const evidence = combined(invocation.result)
  assertSecretSafe(evidence)
  return evidence
}

function appliedConfigMaps(invocation) {
  const documents = []
  for (const call of invocation.kubectlCalls) {
    if (!call.stdin?.trim()) continue
    try {
      for (const document of yamlDocuments(call.stdin)) {
        if (document?.kind === 'ConfigMap') documents.push(document)
        if (document?.kind === 'List') documents.push(...(document.items ?? []).filter((item) => item?.kind === 'ConfigMap'))
      }
    } catch {
      // stdin for a public command need not always be YAML; only applied ConfigMaps are relevant.
    }
  }
  return documents
}

function runtimeDocument(configMap) {
  for (const value of Object.values(configMap?.data ?? {})) {
    try {
      const parsed = JSON.parse(value)
      if (parsed?.schemaVersion === 'falcone.knative-runtime/v1') return parsed
    } catch {}
  }
  return null
}

function appliedKnativeServices(invocation) {
  const services = []
  for (const call of invocation.kubectlCalls) {
    if (!call.stdin?.trim()) continue
    try {
      for (const document of yamlDocuments(call.stdin)) {
        const objects = document?.kind === 'List' ? (document.items ?? []) : [document]
        services.push(...objects.filter((object) => (
          object?.apiVersion === 'serving.knative.dev/v1'
          && object?.kind === 'Service'
        )))
      }
    } catch {
      // Only public Knative Service documents submitted to kubectl are relevant.
    }
  }
  return services
}

function lifecycleSmokeImage(invocation) {
  const services = appliedKnativeServices(invocation).filter((service) => (
    Object.keys(service.metadata?.labels ?? {}).some((key) => /lifecycle.*smoke|smoke.*lifecycle/i.test(key))
    || /smoke/i.test(service.metadata?.name ?? '')
  ))
  assert.equal(services.length, 1, 'lifecycle must submit exactly one isolated smoke Knative Service')
  const containers = services[0].spec?.template?.spec?.containers ?? []
  assert.equal(containers.length, 1, 'smoke Knative Service must have exactly one test container')
  assert.equal(typeof containers[0].image, 'string', 'smoke Knative Service lacks its public image reference')
  return containers[0].image
}

function stagedBundleCalls(invocation) {
  return invocation.kubectlCalls.filter((call) => (
    (call.args ?? []).some((arg) => /\/bundle\/stages\/\d+-.+\.yaml$/.test(arg))
  ))
}

function helmValueArgs(call) {
  const result = []
  for (let index = 0; index < (call?.args ?? []).length; index += 1) {
    if (['--set', '--set-string'].includes(call.args[index])) {
      result.push(call.args[index], call.args[index + 1])
      index += 1
    }
  }
  return result
}

function helmSuppliedValues(call) {
  const args = helmValueArgs(call)
  return args.filter((_, index) => index % 2 === 1)
}

function renderedProjectorScript(objects) {
  const scripts = objects.flatMap((object) => (
    object.kind === 'ConfigMap'
      ? Object.entries(object.data ?? {}).filter(([, value]) => /falcone\.knative-runtime\/v1/.test(String(value)) && /while\s+true/.test(String(value)))
      : []
  ))
  assert.equal(scripts.length, 1, 'managed chart must render exactly one long-lived runtime projector script')
  return scripts[0][1]
}

function executeProjector(scriptText, scenario) {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-knative-projector-bbx-'))
  const script = resolve(directory, 'projector.sh')
  const log = resolve(directory, 'projector-curl.jsonl')
  const projectorBin = resolve(repoRoot, 'tests/blackbox/managed-knative/fixtures/projector-bin')
  writeFileSync(script, scriptText, { mode: 0o755 })
  const result = run('sh', [script], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${projectorBin}:${process.env.PATH}`,
      FALCONE_BBX_PROJECTOR_LOG: log,
      FALCONE_BBX_PROJECTOR_SCENARIO: scenario,
    },
    timeout: 5_000,
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { result, calls, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

function submittedText(call) {
  return `${call?.stdin ?? ''}\n${call?.fileInput ?? ''}`
}

function submittedObjects(call) {
  const text = submittedText(call).trim()
  if (!text) return []
  return yamlDocuments(text).flatMap((document) => document?.kind === 'List' ? (document.items ?? []) : [document])
}

function registrationHookObjects(mode, owner = 'bbx-owner', extraArgs = []) {
  const { objects } = render(umbrellaChart, [
    '--set-string', `global.knativeRuntime.mode=${mode}`,
    '--set-string', `global.knativeRuntime.owner=${owner}`,
    ...extraArgs,
  ])
  return objects.filter((object) => object.metadata?.labels?.['in-falcone.io/component'] === 'knative-runtime-registration')
}

function hookEvents(object) {
  return String(object?.metadata?.annotations?.['helm.sh/hook'] ?? '')
    .split(',')
    .map((event) => event.trim())
    .filter(Boolean)
}

function isNamespaceRegistrationJob(object) {
  const events = hookEvents(object)
  return object?.kind === 'Job'
    && events.includes('pre-install')
    && events.includes('pre-upgrade')
    && !events.includes('pre-delete')
    && /falcone\.io\/knative-runtime-projection/.test(JSON.stringify(object.spec ?? {}))
}

function assertRegistrationOwnerContract(contract, resolvedOwner) {
  const directOwner = new RegExp(`falcone\\.io/knative-owner(?:["'=:\\s]+)${resolvedOwner}`, 'i').test(contract)
  const ownerVariable = contract.includes(resolvedOwner)
    && /falcone\.io\/knative-owner=\$(?:\{)?owner(?:\})?/i.test(contract)
  assert.ok(directOwner || ownerVariable, `registration does not bind its owner label to resolved owner ${resolvedOwner}`)
}

function executeRegistrationJob(job, scenario) {
  const execution = executeRegistrationJobAttempts(job, scenario, 1)
  return {
    result: execution.results[0],
    kubectlCalls: execution.attemptCalls[0],
    helmCalls: [],
    cleanup: execution.cleanup,
  }
}

function executeRegistrationJobAttempts(job, scenario, attempts) {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-knative-registration-bbx-'))
  const log = resolve(directory, 'kubectl.jsonl')
  const containers = job?.spec?.template?.spec?.containers ?? []
  assert.equal(containers.length, 1, 'namespace registration hook must expose one public command container')
  const command = containers[0].command ?? []
  assert.ok(command.length > 0, 'namespace registration hook container lacks a public command')
  const results = []
  const attemptCalls = []
  let priorCallCount = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    results.push(run(command[0], [...command.slice(1), ...(containers[0].args ?? [])], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${resolve(repoRoot, 'tests/blackbox/fixtures/fake-bin')}:${process.env.PATH}`,
        KUBECONFIG: resolve(repoRoot, 'tests/blackbox/fixtures/offline-kubeconfig.yaml'),
        FALCONE_BBX_SCENARIO: scenario,
        FALCONE_BBX_OWNER: 'bbx-owner',
        FALCONE_BBX_KUBECTL_LOG: log,
      },
    }))
    let allCalls = []
    try {
      allCalls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {}
    attemptCalls.push(allCalls.slice(priorCallCount))
    priorCallCount = allCalls.length
  }
  return { results, attemptCalls, helmCalls: [], cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

function callTargetsDeployment(call, deployment) {
  const args = call?.args ?? []
  if (!args.includes('scale')) return false
  const namespaceIndex = Math.max(args.indexOf('-n'), args.indexOf('--namespace'))
  const namespace = namespaceIndex >= 0 ? args[namespaceIndex + 1] : ''
  if (namespace !== deployment.metadata?.namespace) return false
  if (args.some((arg) => arg === `deployment/${deployment.metadata?.name}` || arg === deployment.metadata?.name)) return true
  const selectorIndex = args.indexOf('-l') >= 0 ? args.indexOf('-l') : args.indexOf('--selector')
  if (selectorIndex < 0) return false
  const requirements = String(args[selectorIndex + 1] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=')
      return separator > 0 ? [entry.slice(0, separator), entry.slice(separator + 1)] : null
    })
  return requirements.length > 0
    && requirements.every((requirement) => (
      requirement !== null
      && requirement[1] !== ''
      && deployment.metadata?.labels?.[requirement[0]] === requirement[1]
    ))
}

// bbx-8-001 | fn-managed-knative-separate-release | OpenSpec #### Scenario: Managed bundle is never an umbrella dependency
test('separate falcone-knative chart packages independently and never enters umbrella dependencies', () => {
  requireManagedChart()
  const managed = readYaml(resolve(managedChart, 'Chart.yaml'))
  const umbrella = readYaml(resolve(umbrellaChart, 'Chart.yaml'))
  assert.equal(managed.apiVersion, 'v2')
  assert.equal(managed.name, 'falcone-knative')
  assert.equal(managed.type, 'application')
  assert.match(String(managed.version), /^\d+\.\d+\.\d+(?:[-+].+)?$/)
  assert.ok(!(umbrella.dependencies ?? []).some((dependency) => dependency.name === 'falcone-knative' || dependency.alias === 'falcone-knative'))

  const packaged = packageManagedChart()
  try {
    assert.ok(statSync(packaged.archive).size > 0)
    assert.equal(readYaml(resolve(packaged.chartRoot, 'Chart.yaml')).name, 'falcone-knative')
  } finally {
    packaged.cleanup()
  }
})

// bbx-8-002 | fn-managed-knative-modes | OpenSpec #### Scenario: Default disabled render is unchanged
test('umbrella schema exposes exactly managed, external, disabled and defaults to disabled', () => {
  const schema = JSON.parse(readFileSync(resolve(umbrellaChart, 'values.schema.json'), 'utf8'))
  const values = readYaml(resolve(umbrellaChart, 'values.yaml'))
  const runtimeSchema = schema?.properties?.global?.properties?.knativeRuntime
  const modeSchema = runtimeSchema?.properties?.mode
  assert.ok(modeSchema, 'values.schema.json lacks public global.knativeRuntime.mode')
  assert.deepEqual([...modeSchema.enum].sort(), ['disabled', 'external', 'managed'])
  assert.equal(modeSchema.default, 'disabled')
  assert.equal(values?.global?.knativeRuntime?.mode, 'disabled')
  assert.equal(values?.global?.knativeRuntime?.owner, '', 'owner must default empty so templates resolve it to the actual Helm release name')
  assert.equal(runtimeSchema?.properties?.owner?.default, '', 'owner schema default must remain empty to prevent cross-release owner collisions')
  assert.equal(values?.global?.knativeRuntime?.statusConfigMapName, 'falcone-knative-runtime')
  assert.equal(runtimeSchema?.properties?.statusConfigMapName?.default, 'falcone-knative-runtime')

  const invalid = run('helm', ['template', 'falcone-bbx', umbrellaChart, '--namespace', 'falcone-bbx', '--set-string', 'global.knativeRuntime.mode=implicit'])
  assertFailure(invalid, 'invalid Knative runtime mode')
  assert.match(combined(invalid), /global\.knativeRuntime\.mode|managed|external|disabled/i)
})

// bbx-8-003 | fn-managed-knative-default-compatibility | OpenSpec #### Scenario: Disabled mode adds no mount or env change
test('default umbrella stays at its pre-change baseline and explicit disabled adds no runtime wiring', () => {
  const baseline = readFileSync(resolve(repoRoot, 'tests/blackbox/fixtures/umbrella-default-render.sha256'), 'utf8').trim()
  const defaults = render(umbrellaChart)
  const disabled = render(umbrellaChart, ['--set-string', 'global.knativeRuntime.mode=disabled'])
  const defaultCanonical = JSON.stringify(canonical(defaults.objects))
  assert.equal(sha256(defaultCanonical), baseline, 'default umbrella render drifted from the pre-change public baseline')
  assert.equal(runtimeContainers(defaults.objects).length, 0)
  assert.equal(runtimeContainers(disabled.objects).length, 0)
  assert.doesNotMatch(defaults.text, /falcone\.knative-(?:runtime|lifecycle)\/v1/)
  assert.doesNotMatch(disabled.text, /falcone\.knative-(?:runtime|lifecycle)\/v1/)
})

// bbx-8-004 | fn-managed-knative-umbrella-boundary | OpenSpec #### Scenario: Managed mode adds no umbrella dependency
test('all umbrella modes render no managed Serving, Kourier, OLM, CRD, or admission lifecycle object', () => {
  for (const mode of ['disabled', 'external', 'managed']) {
    const output = render(umbrellaChart, ['--set-string', `global.knativeRuntime.mode=${mode}`])
    assertNoServingLayerObjects(output.objects)
  }
})

// bbx-8-005 | fn-managed-knative-fresh-mount | OpenSpec #### Scenario: Missing projection fails closed
test('managed and external app-visible status is guarded against expired or unhealthy leased source', () => {
  for (const mode of ['managed', 'external']) {
    const output = render(umbrellaChart, ['--set-string', `global.knativeRuntime.mode=${mode}`])
    const consumers = runtimeContainers(output.objects)
    assert.ok(consumers.length >= 2, `${mode} must wire controlPlane and controlPlaneExecutor`)

    for (const { object, podSpec, container } of consumers) {
      assert.equal(envMap(container).get('KNATIVE_RUNTIME_MODE'), mode)
      assert.equal(envMap(container).get('KNATIVE_RUNTIME_STATUS_FILE') ?? '/var/run/falcone/knative/status.json', '/var/run/falcone/knative/status.json')
      const targetMount = (container.volumeMounts ?? []).find((mount) => mount.mountPath === '/var/run/falcone/knative' || mount.mountPath === '/var/run/falcone/knative/')
      assert.ok(targetMount, `${object.kind}/${object.metadata.name} must mount the app-visible status directory`)
      assert.equal(targetMount.subPath, undefined, 'app-visible runtime directory must never use subPath')
      const targetVolume = (podSpec.volumes ?? []).find((volume) => volume.name === targetMount.name)
      assert.ok(targetVolume?.emptyDir, 'app-visible status must be a writable materialized volume, not a stale direct ConfigMap mount')
      assert.equal(targetVolume.configMap, undefined)

      const guards = (podSpec.containers ?? []).filter((candidate) => candidate.name !== container.name && (candidate.volumeMounts ?? []).some((mount) => mount.name === targetMount.name))
      assert.equal(guards.length, 1, `${object.kind}/${object.metadata.name} must have exactly one lease health guard/materializer`)
      const guard = guards[0]
      const sourceMount = (guard.volumeMounts ?? []).find((mount) => mount.name !== targetMount.name && mount.readOnly === true)
      assert.ok(sourceMount, 'health guard must consume an owner-checked source read-only')
      const sourceVolume = (podSpec.volumes ?? []).find((volume) => volume.name === sourceMount.name)
      assert.equal(sourceVolume?.configMap?.optional, true, 'leased source ConfigMap must be optional so absence fails closed without blocking pod start')
      assert.ok(!(container.volumeMounts ?? []).some((mount) => mount.name === sourceMount.name), 'application must not directly mount the potentially stale source')
      assert.ok(!(guard.volumeMounts ?? []).some((mount) => /^kube-api-access/.test(mount.name)), 'guard must not receive a Kubernetes API token')
      assert.equal(guard.securityContext?.allowPrivilegeEscalation, false)
      assert.equal(guard.securityContext?.readOnlyRootFilesystem, true)
      const guardContract = JSON.stringify({ command: guard.command, args: guard.args, env: guard.env }).toLowerCase()
      assert.match(guardContract, /validuntil|lease/, 'guard must evaluate the lease deadline')
      assert.match(guardContract, /atomic|materializ|replace|remove/, 'guard must atomically replace/remove app-visible ready state on expiry or health loss')
    }
  }
})

// bbx-8-006 | fn-managed-knative-namespace-registration | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('active modes link owner-scoped namespace registration to their unowned projected status source', () => {
  const releaseNamespace = 'falcone-bbx'
  const cases = [
    { mode: 'managed', ownerArgs: [], resolvedOwner: 'falcone-bbx' },
    { mode: 'external', ownerArgs: ['--set-string', 'global.knativeRuntime.owner=bbx-external-owner'], resolvedOwner: 'bbx-external-owner' },
  ]

  for (const { mode, ownerArgs, resolvedOwner } of cases) {
    const statusConfigMapName = 'falcone-knative-runtime'
    const { objects } = render(umbrellaChart, [
      '--set-string', `global.knativeRuntime.mode=${mode}`,
      ...ownerArgs,
    ])

    assert.ok(
      !objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === releaseNamespace),
      `${mode} must register the namespace pre-created by helm --create-namespace, not render it as an ordinary Helm Namespace`,
    )

    const consumers = runtimeContainers(objects)
    assert.ok(consumers.length >= 2, `${mode} must expose projected status to controlPlane and controlPlaneExecutor`)
    for (const { object, podSpec } of consumers) {
      const projectedSources = (podSpec.volumes ?? []).filter((volume) => volume.configMap?.name === statusConfigMapName)
      assert.equal(projectedSources.length, 1, `${object.kind}/${object.metadata.name} must consume the configured projected status source exactly once`)
      assert.equal(projectedSources[0].configMap.optional, true, 'projected status source must remain optional so absence can fail closed')
    }

    assert.ok(
      !objects.some((object) => (
        object.kind === 'ConfigMap'
        && (
          object.metadata?.name === statusConfigMapName
          || Object.values(object.data ?? {}).some((value) => String(value).includes('falcone.knative-runtime/v1'))
        )
      )),
      `${mode} umbrella must leave the projected runtime-status ConfigMap to the lifecycle/projector`,
    )

    const registrationJobs = objects.filter(isNamespaceRegistrationJob)
    assert.equal(registrationJobs.length, 1, `${mode} must register its projected-status namespace exactly once`)
    assert.ok(!hookEvents(registrationJobs[0]).includes('pre-delete'), `${mode} registration count included its uninstall revoker`)
    const registrationContract = JSON.stringify(registrationJobs[0].spec)
    assert.match(registrationContract, new RegExp(`(?:namespace|namespaces)[^\\n]*${releaseNamespace}|${releaseNamespace}[^\\n]*(?:namespace|namespaces)`, 'i'))
    assert.match(registrationContract, /falcone\.io\/knative-runtime-projection(?:["'=:\\s]+)enabled/i)
    assertRegistrationOwnerContract(registrationContract, resolvedOwner)
  }
})

// bbx-8-007 | fn-managed-knative-lifecycle-status | OpenSpec #### Scenario: Lifecycle status is published Helm-owned after smoke
test('separate chart renders the exact Helm-owned lifecycle status schema but not compatible by default', () => {
  const { objects } = render(managedChart)
  const statusMaps = objects.filter((object) => object.kind === 'ConfigMap' && Object.values(object.data ?? {}).some((value) => String(value).includes('falcone.knative-lifecycle/v1')))
  assert.equal(statusMaps.length, 1)
  const configMap = statusMaps[0]
  assert.equal(configMap.metadata.namespace ?? 'knative-serving', 'knative-serving')
  assert.equal(configMap.metadata.labels?.['app.kubernetes.io/managed-by'], 'Helm')
  assert.equal(configMap.metadata.labels?.['app.kubernetes.io/instance'], 'falcone-bbx')
  assert.ok(configMap.metadata.labels?.['app.kubernetes.io/version'])
  assert.equal(configMap.metadata.annotations?.['meta.helm.sh/release-name'], 'falcone-bbx')
  assert.equal(configMap.metadata.annotations?.['meta.helm.sh/release-namespace'], 'knative-serving')
  const value = Object.values(configMap.data).find((entry) => String(entry).includes('falcone.knative-lifecycle/v1'))
  const status = JSON.parse(value)
  assert.deepEqual(Object.keys(status).sort(), ['clusterIdentity', 'lifecycleExecutable', 'release', 'runId', 'schemaVersion', 'status', 'version'])
  assert.deepEqual(Object.keys(status.clusterIdentity).sort(), ['apiUrl', 'clusterUid', 'infrastructureId', 'infrastructureName'])
  assert.deepEqual(Object.keys(status.lifecycleExecutable).sort(), ['name', 'sha256', 'version'])
  assert.equal(status.schemaVersion, 'falcone.knative-lifecycle/v1')
  assert.equal(status.lifecycleExecutable.name, 'falcone-knative')
  assert.notEqual(status.status, 'compatible', 'Helm render alone cannot claim smoke-proven compatibility')
  assertSecretSafe(JSON.stringify(status))
})

// bbx-8-008 | fn-managed-knative-supply-chain | OpenSpec #### Scenario: Provenance lock is complete and reproducible
test('published managed chart carries complete provenance, licenses, SBOMs, image lock, and executable identity', () => {
  const packaged = packageManagedChart()
  try {
    const files = walk(packaged.chartRoot)
    const relative = files.map((file) => file.slice(packaged.chartRoot.length + 1))
    assert.ok(relative.some((name) => /provenance.*\.(?:json|ya?ml)$/i.test(name)), 'package lacks provenance lock')
    assert.ok(relative.some((name) => /image.*lock.*\.(?:json|ya?ml)$/i.test(name)), 'package lacks complete image lock')
    assert.ok(relative.some((name) => /sbom.*\.(?:json|spdx|cdx)/i.test(name)), 'package lacks SBOM')
    assert.ok(relative.some((name) => /licenses?|license-inventory/i.test(name)), 'package lacks license inventory')
    const supplyChainText = files.filter((file) => /provenance|lock|sbom|license/i.test(basename(file))).map((file) => readFileSync(file, 'utf8')).join('\n')
    assert.match(supplyChainText, /1\.22\.1/)
    assert.match(supplyChainText, /revision|commit/i)
    assert.match(supplyChainText, /original/i)
    assert.match(supplyChainText, /patched/i)
    assert.match(supplyChainText, /sha256:[a-f0-9]{64}|[a-f0-9]{64}/i)
    requireCli()
    const version = run(cli, ['--version'])
    assertSuccess(version, 'falcone-knative --version')
    assert.match(version.stdout, /falcone-knative\s+v?\d+\.\d+\.\d+/i)
    assert.match(supplyChainText, new RegExp(sha256(readFileSync(cli))))
  } finally {
    packaged.cleanup()
  }
})

// bbx-8-009 | fn-managed-knative-digest-lock | OpenSpec #### Scenario: Mutable image is rejected
test('every managed image including Envoy is digest-only', () => {
  const { objects } = render(managedChart)
  const images = imageReferences(objects)
  assert.ok(images.length > 0)
  assert.ok(images.some((image) => /envoy/i.test(image)), 'render must include the locked Envoy gateway image')
  for (const image of images) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/i, `mutable or malformed image: ${image}`)
    assert.doesNotMatch(image.replace(/@sha256:.+$/, ''), /:[^/]+$/, `tag retained before digest: ${image}`)
  }
  assert.doesNotMatch(images.join('\n'), /envoy:v1\.37-latest/i)
})

// bbx-8-010 | fn-managed-knative-disconnected | OpenSpec #### Scenario: Harbor rewrite preserves the digest
test('disconnected Harbor render rewrites every repository while preserving every digest', () => {
  const original = imageReferences(render(managedChart).objects)
  const args = publicManagedValueArgs({ registry: 'harbor.bbx.example.test/falcone', disconnected: true })
  const mirrored = imageReferences(render(managedChart, args).objects)
  assert.equal(mirrored.length, original.length)
  const originalDigests = original.map((image) => image.split('@')[1]).sort()
  const mirroredDigests = mirrored.map((image) => image.split('@')[1]).sort()
  assert.deepEqual(mirroredDigests, originalDigests)
  for (const image of mirrored) {
    assert.match(image, /^harbor\.bbx\.example\.test\/falcone\//)
    assert.match(image, /@sha256:[a-f0-9]{64}$/i)
    assert.doesNotMatch(image, /docker\.io|gcr\.io|ghcr\.io|quay\.io|registry\.k8s\.io/i)
  }
})

// bbx-8-011 | fn-managed-knative-restricted-v2 | OpenSpec #### Scenario: Security controls remain enforced
test('OpenShift restricted-v2 render removes fixed Kourier UID/GID and retains mandatory controls', () => {
  const args = publicManagedValueArgs({ platform: 'openshift' })
  const { objects, text } = render(managedChart, args)
  assert.doesNotMatch(text, /runAsUser:\s*65534|runAsGroup:\s*65534/)
  assert.ok(!objects.some((object) => object.kind === 'SecurityContextConstraints'), 'custom SCC is forbidden')
  const containers = allContainers(objects)
  assert.ok(containers.length > 0)
  for (const { object, podSpec, container } of containers) {
    const podSecurity = podSpec.securityContext ?? {}
    const security = container.securityContext ?? {}
    assert.equal(security.runAsNonRoot ?? podSecurity.runAsNonRoot, true, `${object.kind}/${object.metadata.name}/${container.name} must run non-root`)
    assert.equal(security.allowPrivilegeEscalation, false, `${container.name} allows privilege escalation`)
    assert.equal(security.seccompProfile?.type ?? podSecurity.seccompProfile?.type, 'RuntimeDefault')
    assert.ok((security.capabilities?.drop ?? []).includes('ALL'), `${container.name} must drop ALL capabilities`)
    assert.notEqual(security.privileged, true)
  }
})

// bbx-8-012 | fn-managed-knative-no-operator | OpenSpec #### Scenario: Managed lifecycle uses no Operator
test('managed chart contains no OLM or long-lived Falcone Knative reconciler', () => {
  const { objects } = render(managedChart)
  const forbidden = new Set(['ClusterServiceVersion', 'KnativeServing', 'Operator', 'OperatorGroup', 'Subscription'])
  assert.ok(!objects.some((object) => forbidden.has(object.kind)))
  for (const { object } of workloadPodSpecs(objects)) {
    if (/projector|status|health/i.test(object.metadata.name)) continue
    assert.doesNotMatch(object.metadata.name, /falcone.*knative.*(?:operator|reconciler|controller)/i)
  }
})

// bbx-8-013 | fn-managed-knative-projector-rbac | OpenSpec #### Scenario: The projector is read-only against the serving layer
test('projector cluster RBAC is read-only and cannot mutate ConfigMaps or serving resources across namespaces', () => {
  const { objects } = render(managedChart, ['--set-string', 'owner=bbx-owner'])
  const projector = objects.find((object) => object.kind === 'ServiceAccount' && /status-projector/.test(object.metadata?.name ?? ''))
  assert.ok(projector, 'status projector service account is absent')
  const bindings = objects.filter((object) => (
    object.kind === 'ClusterRoleBinding'
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === projector.metadata.name
      && subject.namespace === projector.metadata.namespace
    ))
  ))
  assert.ok(bindings.length > 0, 'status projector cluster read binding is absent')
  const roleNames = new Set(bindings.map((binding) => binding.roleRef?.name))
  const roles = objects.filter((object) => object.kind === 'ClusterRole' && roleNames.has(object.metadata?.name))
  assert.ok(roles.length > 0, 'status projector ClusterRole is absent')
  for (const role of roles) {
    for (const rule of role.rules ?? []) {
      const writes = (rule.verbs ?? []).filter((verb) => ['create', 'delete', 'patch', 'update'].includes(verb))
      assert.deepEqual(writes, [], `projector ClusterRole ${role.metadata.name} grants cross-namespace mutation`)
      if ((rule.apiGroups ?? []).includes('') && (rule.resources ?? []).includes('configmaps')) {
        assert.ok((rule.verbs ?? []).every((verb) => ['get', 'list', 'watch'].includes(verb)))
      }
      if ((rule.apiGroups ?? []).some((group) => group === 'serving.knative.dev' || group === 'apiextensions.k8s.io' || group === 'admissionregistration.k8s.io')) {
        assert.ok((rule.verbs ?? []).every((verb) => ['get', 'list', 'watch'].includes(verb)), 'projector can mutate serving-layer resources')
      }
    }
  }

  const statusBindings = objects.filter((object) => (
    object.kind === 'RoleBinding'
    && object.metadata?.namespace === projector.metadata.namespace
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === projector.metadata.name
      && subject.namespace === projector.metadata.namespace
    ))
  ))
  const statusRoleNames = new Set(statusBindings.map((binding) => binding.roleRef?.name))
  const statusRoles = objects.filter((object) => (
    object.kind === 'Role'
    && object.metadata?.namespace === projector.metadata.namespace
    && statusRoleNames.has(object.metadata?.name)
  ))
  const lifecycleReads = statusRoles.flatMap((role) => role.rules ?? []).filter((rule) => (
    (rule.apiGroups ?? []).includes('')
    && (rule.resources ?? []).includes('configmaps')
    && (rule.resourceNames ?? []).includes('falcone-knative-status')
    && (rule.verbs ?? []).includes('get')
  ))
  assert.equal(lifecycleReads.length, 1, 'projector requires one namespace-scoped lifecycle status read')
  assert.ok(!(lifecycleReads[0].verbs ?? []).some((verb) => ['create', 'delete', 'patch', 'update'].includes(verb)))
})

// bbx-8-014 | fn-managed-knative-cli-surface | OpenSpec #### Scenario: Lifecycle executable identity is verifiable
test('repository CLI has exact basename and exposes the complete versioned public command surface', () => {
  requireCli()
  const version = run(cli, ['--version'])
  assertSuccess(version, 'falcone-knative --version')
  assert.match(version.stdout, /^falcone-knative\s+v?\d+\.\d+\.\d+/i)
  const help = run(cli, ['--help'])
  assertSuccess(help, 'falcone-knative --help')
  for (const command of ['preflight', 'install', 'upgrade', 'rollback', 'uninstall', 'purge', 'handoff', 'acceptance']) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`))
  }
})

// bbx-8-015 | fn-managed-knative-fixed-matrix | OpenSpec #### Scenario: Initial matrix is accepted
test('supported 1.22.1 / Kubernetes 1.34 / OpenShift 4.21 restricted-v2 preflight is read-only and accepted', () => {
  const invocation = invokeCli(['preflight', '--mode', 'managed', '--owner', 'bbx-owner', '--output', 'json'], 'clean-supported', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    assertSuccess(invocation.result, 'supported managed preflight')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(combined(invocation.result), /1\.22\.1/)
    assert.match(combined(invocation.result), /1\.34/)
    assert.match(combined(invocation.result), /4\.21/)
    assert.match(combined(invocation.result), /restricted-v2/i)
  } finally { invocation.cleanup() }
})

// bbx-8-016 | fn-managed-knative-fixed-matrix | OpenSpec #### Scenario: Unvalidated platform combination fails closed
test('unsupported matrix is rejected before every kubectl or Helm mutation', () => {
  for (const scenario of ['unsupported-kubernetes', 'unsupported-openshift']) {
    const invocation = invokeCli(['preflight', '--mode', 'managed', '--owner', 'bbx-owner', '--output', 'json'], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(invocation, scenario)
      assert.equal(mutationCalls(invocation).length, 0)
      assert.match(evidence, /detected/i)
      assert.match(evidence, /supported/i)
      assert.match(evidence, scenario === 'unsupported-kubernetes' ? /1\.33/ : /4\.20/)
      assert.match(evidence, scenario === 'unsupported-kubernetes' ? /1\.34/ : /4\.21/)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-017 | fn-managed-knative-preflight-authority | OpenSpec #### Scenario: Namespace-only installer is denied before mutation
test('namespace-only authority fails preflight with the missing cluster permission and zero mutation', () => {
  const invocation = invokeCli(['preflight', '--mode', 'managed', '--owner', 'bbx-owner', '--output', 'json'], 'namespace-only', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'namespace-only preflight')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /permission|cluster.?scope|authority/i)
  } finally { invocation.cleanup() }
})

// bbx-8-018 | fn-managed-knative-exclusive-ownership | OpenSpec #### Scenario: Existing Operator or foreign ownership is not adopted
test('OLM, Serverless, raw, foreign-Falcone, unknown, partial, and undecided ownership are never adopted', () => {
  for (const scenario of ['owner-olm', 'owner-serverless', 'owner-raw', 'owner-other-falcone', 'owner-unknown', 'owner-partial', 'existing-undecided']) {
    const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(invocation, `ownership collision ${scenario}`)
      assert.equal(mutationCalls(invocation).length, 0, `${scenario} mutated the fake cluster before rejecting ownership`)
      assert.match(evidence, /external|disabled|handoff|migration/i)
      assert.match(evidence, /owner|existing|adopt|decision/i)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-019 | fn-managed-knative-external-canary | OpenSpec #### Scenario: Existing installation requires an explicit decision
test('external validation reads and invokes only the supplied existing canary and never creates validation resources', () => {
  const invocation = invokeCli([
    'preflight', '--mode', 'external', '--owner', 'bbx-owner', '--external-canary', 'knative-serving/external-canary', '--output', 'json',
  ], 'external-canary-ready', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    assertSuccess(invocation.result, 'external canary validation')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(callText(invocation.kubectlCalls), /get.*(?:ksvc|serving\.knative\.dev)/i)
    assert.ok(invocation.curlCalls.length > 0 || /exec/.test(callText(invocation.kubectlCalls)), 'existing canary was not invoked')
    assert.doesNotMatch(callText(invocation.kubectlCalls), /create|apply|delete/)
  } finally { invocation.cleanup() }

  const missing = invokeCli([
    'preflight', '--mode', 'external', '--owner', 'bbx-owner', '--external-canary', 'knative-serving/external-canary', '--output', 'json',
  ], 'external-canary-missing', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(missing, 'missing external canary')
    assert.equal(mutationCalls(missing).length, 0)
    assert.match(evidence, /unverified|missing|canary/i)
    assert.doesNotMatch(evidence, /"state"\s*:\s*"ready"/)
  } finally { missing.cleanup() }
})

// bbx-8-020 | fn-managed-knative-staged-install | OpenSpec #### Scenario: Admission and data plane are proven by a smoke ksvc before readiness
test('managed install enforces CRD, webhook, admission, Serving, Kourier, smoke, then ready ordering', () => {
  const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'staged managed install')
    const calls = invocation.kubectlCalls
    const contract = (call) => `${(call.args ?? []).join(' ')}\n${submittedText(call)}`
    const findCall = (label, predicate, after = -1) => {
      const index = calls.findIndex((call, candidate) => candidate > after && predicate(call, contract(call)))
      assert.ok(index >= 0, `staged install log is missing ${label}`)
      return index
    }

    const firstMutation = calls.findIndex((call) => (
      mutationCalls({ kubectlCalls: [call], helmCalls: [] }).length > 0
    ))
    assert.ok(firstMutation >= 0, 'install never reached its first owner acquisition mutation')
    const requiredPreflightReads = [
      /\bget\s+namespaces\b/i,
      /\bget\s+clusterroles[^\n]*clusterrolebindings/i,
      /\bget\s+vwc,mwc\b/i,
      /\bget\s+customresourcedefinitions/i,
      /\bget\s+deployments\.apps[^\n]*statefulsets\.apps[^\n]*daemonsets\.apps[^\n]*services/i,
      /\bget\s+configmaps,secrets,serviceaccounts,roles[^\n]*rolebindings[^\n]*horizontalpodautoscalers[^\n]*poddisruptionbudgets/i,
      /\bget\s+certificates\.networking\.internal\.knative\.dev[^\n]*images\.caching\.internal\.knative\.dev/i,
      /\bget\s+configmaps\s+-n\s+knative-serving/i,
    ]
    for (const expectedRead of requiredPreflightReads) {
      const index = calls.findIndex((call) => expectedRead.test(contract(call)))
      assert.ok(index >= 0 && index < firstMutation, `full read-only preflight did not complete before mutation: ${expectedRead}`)
    }
    assert.equal(
      calls.slice(0, firstMutation).some((call) => mutationCalls({ kubectlCalls: [call], helmCalls: [] }).length > 0),
      false,
      'install mutated during preflight',
    )

    const crds = findCall('CRD stage mutation', (call, text) => (call.args ?? []).includes('apply') && /stages\/01-crds\.yaml/.test(text), firstMutation)
    const established = findCall('CRD Established gate', (call, text) => (call.args ?? []).includes('wait') && /Established/.test(text), crds)
    const webhook = findCall('webhook backend stage mutation', (call, text) => (call.args ?? []).includes('apply') && /stages\/03-webhook-backend\.yaml/.test(text), established)
    const webhookAvailable = findCall('webhook Deployment gate', (call, text) => (call.args ?? []).includes('wait') && /deployment\/webhook/.test(text), webhook)
    const endpoint = findCall('exact webhook Endpoint gate', (call, text) => (call.args ?? []).includes('get') && /endpoints?\s+webhook\b/.test(text), webhookAvailable)
    const certificate = findCall('exact webhook certificate Secret gate', (call, text) => (call.args ?? []).includes('get') && /secrets?\s+webhook-certs\b/.test(text), webhookAvailable)
    const endpointAndCertificateGate = Math.max(endpoint, certificate)
    const admission = findCall('AdmissionRegistration stage mutation', (call, text) => (call.args ?? []).includes('apply') && /stages\/04-admissionregistration\.yaml/.test(text), endpointAndCertificateGate)
    const admissionProbe = findCall('server-side admission dry-run', (call, text) => (call.args ?? []).includes('create') && /dry-run=server/.test(text), admission)
    const serving = findCall('remaining Serving controller stage mutation', (call, text) => (call.args ?? []).includes('apply') && /stages\/05-serving-controllers\.yaml/.test(text), admissionProbe)
    const servingAvailable = findCall('Serving controller gate', (call, text) => (call.args ?? []).includes('wait') && /deployment\/controller/.test(text), serving)
    const kourier = findCall('Kourier stage mutation', (call, text) => (call.args ?? []).includes('apply') && /stages\/06-kourier\.yaml/.test(text), servingAvailable)
    const kourierController = findCall('Kourier controller gate', (call, text) => (call.args ?? []).includes('wait') && /deployment\/net-kourier-controller/.test(text), kourier)
    const gateway = findCall('Kourier gateway gate', (call, text) => (call.args ?? []).includes('wait') && /deployment\/3scale-kourier-gateway/.test(text), kourier)
    const dataPlaneGate = Math.max(kourierController, gateway)
    const smoke = findCall('isolated smoke Knative Service mutation', (call, text) => (
      (call.args ?? []).includes('apply')
      && /"apiVersion"\s*:\s*"serving\.knative\.dev\/v1"/.test(text)
      && /falcone-knative-smoke-/.test(text)
    ), dataPlaneGate)
    const smokeReady = findCall('smoke Knative Service Ready gate', (call, text) => (call.args ?? []).includes('wait') && /ksvc\/falcone-knative-smoke-/.test(text), smoke)
    const smokeInvocation = findCall('smoke data-plane invocation', (call) => (call.args ?? []).includes('exec'), smokeReady)

    const finalCalls = invocation.helmCalls.filter((call) => (
      /status\.state=compatible/.test((call.args ?? []).join(' '))
      && /lifecycle\.smokeVerified=true/.test((call.args ?? []).join(' '))
    ))
    assert.equal(finalCalls.length, 1, 'ready/compatible publication was not uniquely gated by smoke success')
    assert.deepEqual(
      [crds, established, webhook, webhookAvailable, endpointAndCertificateGate, admission, admissionProbe, serving, servingAvailable, kourier, dataPlaneGate, smoke, smokeReady, smokeInvocation],
      [...[crds, established, webhook, webhookAvailable, endpointAndCertificateGate, admission, admissionProbe, serving, servingAvailable, kourier, dataPlaneGate, smoke, smokeReady, smokeInvocation]].sort((a, b) => a - b),
      'managed lifecycle stage order is unsafe',
    )
  } finally { invocation.cleanup() }
})

// bbx-8-021 | fn-managed-knative-stage-failure | OpenSpec #### Scenario: A failed stage is not a successful install
test('CRD, webhook, Kourier, and smoke failures stop downstream work and never publish ready', () => {
  for (const scenario of ['stage-crd-fail', 'stage-webhook-fail', 'stage-kourier-fail', 'stage-smoke-fail']) {
    const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], scenario)
    try {
      const evidence = assertLifecycleFailure(invocation, scenario)
      const log = `${callText(invocation.kubectlCalls)}\n${evidence}`
      assert.match(log, new RegExp(scenario.replace('stage-', '').replace('-fail', ''), 'i'))
      assert.doesNotMatch(log, /(?:state|status)["':= ]+(?:ready|compatible)/i)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-022 | fn-managed-knative-runtime-status | OpenSpec #### Scenario: A transition updates every registered projection
test('successful install projects exact bounded leased runtime status only to registered matching-owner namespaces', () => {
  const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'managed projection install')
    const maps = appliedConfigMaps(invocation).filter((configMap) => runtimeDocument(configMap))
    assert.equal(maps.length, 2, 'exactly the two registered matching-owner namespaces must receive projection')
    assert.deepEqual(maps.map((map) => map.metadata.namespace).sort(), ['falcone-app-a', 'falcone-app-b'])
    for (const map of maps) {
      const document = runtimeDocument(map)
      assert.deepEqual(Object.keys(document).sort(), ['compatibility', 'mode', 'observedAt', 'owner', 'readiness', 'schemaVersion', 'validUntil', 'version'])
      assert.deepEqual(Object.keys(document.readiness).sort(), ['lastTransitionAt', 'reason', 'stage', 'state'])
      assert.equal(document.schemaVersion, 'falcone.knative-runtime/v1')
      assert.equal(document.mode, 'managed')
      assert.equal(document.owner, 'bbx-owner')
      assert.equal(document.version, '1.22.1')
      assert.equal(document.compatibility, 'compatible')
      assert.equal(document.readiness.state, 'ready')
      assert.match(document.readiness.reason, /^[A-Z][A-Z0-9_]{0,63}$/)
      const observed = Date.parse(document.observedAt)
      const validUntil = Date.parse(document.validUntil)
      assert.ok(Number.isFinite(observed) && Number.isFinite(validUntil) && validUntil > observed)
      assert.ok(validUntil - observed <= 5 * 60_000, 'runtime lease must be bounded to at most five minutes')
      assertSecretSafe(JSON.stringify(document))
    }
    assert.doesNotMatch(callText(invocation.kubectlCalls), /falcone-unregistered.*falcone\.knative-runtime\/v1|falcone-foreign.*falcone\.knative-runtime\/v1/i)
  } finally { invocation.cleanup() }
})

// bbx-8-023 | fn-managed-knative-upgrade | OpenSpec #### Scenario: Upgrade skipping a minor version is rejected
test('skipped-minor upgrade is rejected before mutation with required intermediate sequence', () => {
  const invocation = invokeCli(['upgrade', '--from-version', '1.20.0', '--to-version', '1.22.1', '--owner', 'bbx-owner', '--output', 'json'], 'clean-supported', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'skipped-minor upgrade')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /1\.21/)
    assert.match(evidence, /intermediate|one.?minor|sequence/i)
  } finally { invocation.cleanup() }
})

// bbx-8-024 | fn-managed-knative-rollback | OpenSpec #### Scenario: Irreversible storage migration blocks incompatible downgrade
test('irreversible stored-version migration blocks binary rollback before mutation', () => {
  const invocation = invokeCli(['rollback', '--to-version', '1.21.0', '--owner', 'bbx-owner', '--recovery-point', 'bbx-recovery-8', '--output', 'json'], 'irreversible-storage-migration', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'incompatible rollback')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /stored|storage|migration/i)
    assert.match(evidence, /restore|forward.?repair/i)
    assert.match(evidence, /bbx-recovery-8|recovery.?point/i)
  } finally { invocation.cleanup() }
})

// bbx-8-025 | fn-managed-knative-uninstall | OpenSpec #### Scenario: Default uninstall retains durable state
test('default uninstall retains CRDs and tenant workloads and reports every retained class', () => {
  const invocation = invokeCli(['uninstall', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'installed-managed')
  try {
    assertSuccess(invocation.result, 'retain-by-default uninstall')
    const log = `${callText(invocation.kubectlCalls)}\n${combined(invocation.result)}`
    assert.match(log, /retain/i)
    assert.match(log, /customresourcedefinition|\bcrds?\b/i)
    assert.match(log, /tenant|knative service|workload/i)
    assert.doesNotMatch(callText(invocation.kubectlCalls.filter((call) => (call.args ?? []).includes('delete'))), /customresourcedefinition|services\.serving\.knative\.dev|\bksvc\b/i)
  } finally { invocation.cleanup() }
})

// bbx-8-026 | fn-managed-knative-purge | OpenSpec #### Scenario: Destructive purge requires a separate confirmation
test('purge enumerates impact and backup prerequisites but refuses without distinct confirmation', () => {
  const invocation = invokeCli(['purge', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'installed-managed', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'unconfirmed destructive purge')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /customresourcedefinition|\bcrds?\b/i)
    assert.match(evidence, /tenant|workload/i)
    assert.match(evidence, /backup/i)
    assert.match(evidence, /confirm/i)
    assert.match(evidence, /separate|distinct/i)
  } finally { invocation.cleanup() }
})

// bbx-8-027 | fn-managed-knative-handoff | OpenSpec #### Scenario: Handoff prevents simultaneous ownership
test('post-mutation handoff failure remains quiesced and never restarts the previous owner', () => {
  const invocation = invokeCli([
    'handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner',
    '--backup-evidence', 'bbx-backup-8', '--output', 'json',
  ], 'handoff-target-fail')
  try {
    const evidence = assertLifecycleFailure(invocation, 'failed owner handoff')
    const log = `${callText(invocation.kubectlCalls)}\n${evidence}`
    const backup = findIndex(log, /backup|recovery.?point/i, 'handoff backup')
    const quiesce = findIndex(log, /quiesc/i, 'handoff quiesce')
    const release = findIndex(log, /release.*owner|owner.*release/i, 'ownership release')
    assert.ok(backup < quiesce && quiesce < release)
    assert.match(evidence, /quiesc/i)
    assert.match(evidence, /restore|forward.?repair/i)
    assert.doesNotMatch(evidence, /previous owner.*(?:started|resumed)|falcone owner.*(?:started|resumed)/i)
  } finally { invocation.cleanup() }
})

// bbx-8-028 | fn-managed-knative-acceptance-hooks | OpenSpec #### Scenario: Acceptance outage drives the projection unavailable
test('all exact #933 acceptance hooks accept only verified-target argv and remain secret-safe', () => {
  for (const operation of ['outage', 'restart', 'recover', 'replacement-conflict']) {
    const invocation = invokeCli(['acceptance', operation, ...verifiedTargetArgs], `acceptance-${operation}`)
    try {
      assertSuccess(invocation.result, `acceptance ${operation}`)
      const evidence = combined(invocation.result)
      assertSecretSafe(evidence)
      assert.match(evidence, new RegExp(operation))
      assert.match(evidence, /actor/i)
      assert.match(evidence, /action/i)
      assert.match(evidence, /mode/i)
      assert.match(evidence, /owner/i)
      assert.match(evidence, /bundle/i)
      assert.match(evidence, /stage/i)
      assert.match(evidence, /result/i)
      assert.match(evidence, /correlationId/i)
      if (operation === 'outage' || operation === 'restart') assert.doesNotMatch(evidence, /"state"\s*:\s*"ready"/)
      if (operation === 'recover') {
        assert.match(evidence, /ready/i)
        assert.match(evidence, /lastTransitionAt|transition/i)
      }
      if (operation === 'replacement-conflict') {
        assert.doesNotMatch(evidence, /tenant|workspace|ksvc/i)
        assert.match(evidence, /owner|replacement/i)
      }
    } finally { invocation.cleanup() }
  }
})

// bbx-8-029 | fn-managed-knative-verified-target | OpenSpec #### Scenario: Replacement-conflict hook is tenant-safe
test('acceptance rejects missing or mismatched verified-target flags before mutation', () => {
  const missing = invokeCli(['acceptance', 'outage', ...verifiedTargetArgs.slice(2)], 'acceptance-outage', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(missing, 'acceptance missing --api-server')
    assert.equal(mutationCalls(missing).length, 0)
    assert.match(evidence, /api-server|verified target/i)
  } finally { missing.cleanup() }

  const mismatchArgs = [...verifiedTargetArgs]
  mismatchArgs[mismatchArgs.indexOf('--cluster-uid') + 1] = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const mismatch = invokeCli(['acceptance', 'recover', ...mismatchArgs], 'acceptance-recover', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(mismatch, 'acceptance mismatched cluster UID')
    assert.equal(mutationCalls(mismatch).length, 0)
    assert.match(evidence, /cluster-uid|cluster identity|verified target/i)
  } finally { mismatch.cleanup() }
})

// bbx-8-030 | fn-managed-knative-smoke-image-lock | OpenSpec #### Scenario: Disconnected installation uses only the mirror
test('lifecycle smoke ksvc uses an image-lock digest and rewrites that exact image to the disconnected registry', () => {
  const mirror = 'harbor.bbx.example.test/falcone'
  const common = ['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json']
  const connected = invokeCli(common, 'clean-supported')
  const disconnected = invokeCli([
    ...common,
    '--registry-mirror', mirror,
    '--disconnected',
  ], 'clean-supported')
  try {
    assertSuccess(connected.result, 'connected lifecycle smoke install')
    assertSuccess(disconnected.result, 'disconnected lifecycle smoke install')

    const connectedImage = lifecycleSmokeImage(connected)
    const disconnectedImage = lifecycleSmokeImage(disconnected)
    const imageLock = JSON.parse(readFileSync(resolve(managedChart, 'provenance/image-lock.json'), 'utf8'))
    const locked = (imageLock.images ?? []).filter((entry) => entry.source === connectedImage)

    assert.equal(locked.length, 1, `smoke image is not uniquely attested by provenance/image-lock.json: ${connectedImage}`)
    assert.doesNotMatch(connectedImage, /registry\.invalid/i, 'lifecycle smoke may not use a placeholder registry')
    assert.match(connectedImage, /@sha256:[a-f0-9]{64}$/i, 'connected smoke image must be digest-only')
    assert.match(disconnectedImage, /@sha256:[a-f0-9]{64}$/i, 'disconnected smoke image must be digest-only')
    assert.equal(connectedImage.split('@')[1], locked[0].digest, 'connected smoke digest differs from the image lock')
    assert.equal(disconnectedImage, `${mirror}/${locked[0].mirrorRepository}@${locked[0].digest}`)
    assert.equal(disconnectedImage.split('@')[1], connectedImage.split('@')[1], 'registry rewrite changed the locked smoke digest')
    assert.doesNotMatch(disconnectedImage, /registry\.invalid|docker\.io|gcr\.io|ghcr\.io|quay\.io|registry\.k8s\.io/i)
  } finally {
    connected.cleanup()
    disconnected.cleanup()
  }
})

// bbx-8-031 | fn-managed-knative-executable-attestation | OpenSpec #### Scenario: Lifecycle executable identity is verifiable
test('the SHA-attested falcone-knative executable remains functional when copied out of the repository', () => {
  requireCli()
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-knative-standalone-bbx-'))
  const standalone = resolve(directory, 'falcone-knative')
  try {
    copyFileSync(cli, standalone)
    chmodSync(standalone, 0o755)

    const rendered = render(managedChart)
    const statusMap = rendered.objects.find((object) => (
      object.kind === 'ConfigMap'
      && Object.values(object.data ?? {}).some((value) => String(value).includes('falcone.knative-lifecycle/v1'))
    ))
    assert.ok(statusMap, 'rendered chart lacks lifecycle status attestation')
    const lifecycle = JSON.parse(Object.values(statusMap.data).find((value) => String(value).includes('falcone.knative-lifecycle/v1')))
    assert.equal(lifecycle.lifecycleExecutable.sha256, sha256(readFileSync(standalone)), 'published SHA does not identify the distributed executable')

    const repositoryVersion = run(cli, ['--version'])
    const standaloneVersion = run(standalone, ['--version'], { cwd: directory })
    assertSuccess(repositoryVersion, 'repository falcone-knative --version')
    assertSuccess(standaloneVersion, 'standalone copied falcone-knative --version')
    assert.equal(standaloneVersion.stdout, repositoryVersion.stdout)
    assert.match(standaloneVersion.stdout, /^falcone-knative\s+v?\d+\.\d+\.\d+/i)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// bbx-8-032 | fn-managed-knative-projector-ownership | OpenSpec #### Scenario: An unregistered or foreign-owned namespace is refused
test('rendered long-lived projector refuses a pre-existing runtime ConfigMap owned by another lifecycle before PUT', () => {
  const { objects } = render(managedChart)
  const execution = executeProjector(renderedProjectorScript(objects), 'foreign-runtime-owner')
  try {
    const runtimePath = '/api/v1/namespaces/falcone-app-a/configmaps/falcone-knative-runtime'
    assert.ok(execution.calls.some((call) => call.method === 'GET' && call.url.endsWith(runtimePath)), 'projector never inspected the pre-existing runtime ConfigMap')
    const overwrites = execution.calls.filter((call) => ['POST', 'PUT', 'PATCH'].includes(call.method) && call.url.endsWith(runtimePath))
    assert.deepEqual(overwrites, [], 'projector attempted to overwrite a runtime ConfigMap labeled for foreign-lifecycle-owner')
  } finally { execution.cleanup() }
})

// bbx-8-033 | fn-managed-knative-cli-chart-values | OpenSpec #### Scenario: Harbor rewrite preserves the digest
test('CLI supplies the public supplyChain.registry chart value for a disconnected mirror', () => {
  const mirror = 'harbor.bbx.example.test/falcone'
  const invocation = invokeCli([
    'install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative',
    '--registry-mirror', mirror, '--disconnected', '--output', 'json',
  ], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'disconnected managed install')
    const helm = invocation.helmCalls.find((call) => (call.args ?? []).some((arg) => ['install', 'upgrade'].includes(arg)))
    assert.ok(helm, 'CLI did not invoke the public Helm lifecycle')
    const supplied = helmSuppliedValues(helm)
    assert.ok(supplied.includes(`supplyChain.registry=${mirror}`), `CLI did not supply public value supplyChain.registry: ${supplied.join(', ')}`)
    assert.ok(!supplied.some((value) => /^supplyChain\.registryMirror=/.test(value)), 'CLI supplied nonexistent chart value supplyChain.registryMirror')
    assert.ok(supplied.includes('supplyChain.disconnected=true'))
    assert.ok(supplied.includes('owner=bbx-owner'), 'final Helm publication must use the CLI-verified lifecycle owner')
    assert.ok(supplied.includes('status.namespace=knative-serving'), 'final Helm publication must preserve the verified status namespace')
    assert.ok(supplied.includes('status.name=falcone-knative-status'), 'final Helm publication must preserve the verified status ConfigMap name')
  } finally { invocation.cleanup() }
})

// bbx-8-034 | fn-managed-knative-staged-materialization | OpenSpec #### Scenario: Disconnected installation uses only the mirror
test('disconnected install materializes owner and mirror-only locked images into every staged kubectl mutation', () => {
  const owner = 'bbx-owner'
  const mirror = 'harbor.bbx.example.test/falcone'
  const invocation = invokeCli([
    'install', '--mode', 'managed', '--owner', owner, '--release', 'falcone-knative',
    '--registry-mirror', mirror, '--disconnected', '--output', 'json',
  ], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'disconnected staged install')
    const stages = stagedBundleCalls(invocation)
    assert.equal(stages.length, 6, 'CLI must submit each of the six ordered bundle stages')
    const stageText = stages.map((call) => call.fileInput).join('\n')
    assert.ok(stageText.length > 0, 'kubectl received only opaque stage paths rather than materialized manifests')
    assert.doesNotMatch(stageText, /__FALCONE_OWNER__/, 'unexpanded lifecycle owner placeholder reached kubectl')
    assert.match(stageText, new RegExp(`falcone\\.io/knative-owner["']?\\s*:\\s*["']?${owner}`))

    const imageLock = JSON.parse(readFileSync(resolve(managedChart, 'provenance/image-lock.json'), 'utf8'))
    const stagedLocks = (imageLock.images ?? []).filter((entry) => (entry.locations ?? []).some((location) => location.startsWith('bundle/stages/')))
    assert.ok(stagedLocks.length > 0, 'image lock contains no staged bundle images')
    for (const locked of stagedLocks) {
      const expected = `${mirror}/${locked.mirrorRepository}@${locked.digest}`
      assert.match(stageText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `kubectl input omitted rewritten lock entry ${locked.name}`)
      assert.doesNotMatch(stageText, new RegExp(locked.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `public source survived for ${locked.name}`)
    }
    assert.doesNotMatch(stageText, /registry\.invalid|(?:docker|gcr|ghcr|quay)\.io\/|registry\.k8s\.io\//i)

    const smoke = lifecycleSmokeImage(invocation)
    const smokeLocks = (imageLock.images ?? []).filter((entry) => entry.source === smoke || smoke === `${mirror}/${entry.mirrorRepository}@${entry.digest}`)
    assert.equal(smokeLocks.length, 1, 'submitted smoke image is absent from the image lock')
    assert.equal(smoke, `${mirror}/${smokeLocks[0].mirrorRepository}@${smokeLocks[0].digest}`)
  } finally { invocation.cleanup() }
})

// bbx-8-035 | fn-managed-knative-readiness-targets | OpenSpec #### Scenario: Failure-policy webhooks are enabled only after their backend is ready
test('readiness gates target the actual webhook, TLS Secret, Serving controller, and Kourier resources rendered by the bundle', () => {
  const { objects } = render(managedChart)
  const exists = (kind, namespace, name) => objects.some((object) => object.kind === kind && object.metadata?.namespace === namespace && object.metadata?.name === name)
  assert.ok(exists('Deployment', 'knative-serving', 'webhook'))
  assert.ok(exists('Service', 'knative-serving', 'webhook'))
  assert.ok(exists('Deployment', 'knative-serving', 'controller'))
  assert.ok(exists('Deployment', 'knative-serving', 'net-kourier-controller'))
  assert.ok(exists('Deployment', 'kourier-system', '3scale-kourier-gateway'))

  const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'resource-reconciled staged install')
    const hasCall = (...parts) => invocation.kubectlCalls.some((call) => parts.every((part) => (call.args ?? []).some((arg) => part.test(arg))))
    assert.ok(hasCall(/^wait$/, /^deployment\/webhook$/, /^knative-serving$/))
    assert.ok(hasCall(/^get$/, /^endpoints?$/, /^webhook$/, /^knative-serving$/))
    assert.ok(hasCall(/^get$/, /^secrets?$/, /^webhook-certs$/, /^knative-serving$/), 'TLS gate must inspect the webhook-generated webhook-certs Secret')
    assert.ok(hasCall(/^wait$/, /^deployment\/controller$/, /^knative-serving$/))
    assert.ok(hasCall(/^wait$/, /^deployment\/net-kourier-controller$/, /^knative-serving$/))
    assert.ok(hasCall(/^wait$/, /^deployment\/3scale-kourier-gateway$/, /^kourier-system$/))
    assert.doesNotMatch(callText(invocation.kubectlCalls), /deployment\/serving-webhook|endpoints?\s+serving-webhook|certificate\/serving-webhook|deployment\/serving-controller/i)
  } finally { invocation.cleanup() }
})

// bbx-8-036 | fn-managed-knative-webhook-fail-closed | OpenSpec #### Scenario: Failure-policy webhooks are enabled only after their backend is ready
test('empty webhook endpoints and empty AdmissionRegistration CA bundles stop downstream stages', () => {
  const cases = [
    { scenario: 'stage-webhook-endpoints-empty', mustApply: '03-webhook-backend.yaml', mustNotApply: '04-admissionregistration.yaml', evidence: /endpoint|address/i },
    { scenario: 'stage-ca-bundle-empty', mustApply: '04-admissionregistration.yaml', mustNotApply: '05-serving-controllers.yaml', evidence: /ca.?bundle|certificate authority/i },
  ]
  for (const expected of cases) {
    const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], expected.scenario)
    try {
      const evidence = assertLifecycleFailure(invocation, expected.scenario)
      const args = invocation.kubectlCalls.map((call) => (call.args ?? []).join(' ')).join('\n')
      assert.match(args, new RegExp(expected.mustApply.replace('.', '\\.')))
      assert.doesNotMatch(args, new RegExp(expected.mustNotApply.replace('.', '\\.')))
      assert.match(evidence, expected.evidence)
      assert.doesNotMatch(evidence, /"(?:state|status)"\s*:\s*"(?:ready|compatible)"/i)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-037 | fn-managed-knative-admission-probe | OpenSpec #### Scenario: Failure-policy webhooks are enabled only after their backend is ready
test('post-CA admission gate performs a server-side dry-run Knative write before Serving controllers start', () => {
  const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'admission-probed install')
    const calls = invocation.kubectlCalls
    const admission = calls.findIndex((call) => (call.args ?? []).some((arg) => /04-admissionregistration\.yaml$/.test(arg)))
    const serving = calls.findIndex((call) => (call.args ?? []).some((arg) => /05-serving-controllers\.yaml$/.test(arg)))
    assert.ok(admission >= 0 && serving > admission, 'AdmissionRegistration and Serving stage boundary is absent')
    const gatedCalls = calls.slice(admission + 1, serving)
    const gatedText = gatedCalls.map((call) => (call.args ?? []).join(' ')).join('\n')
    for (const name of ['config.webhook.serving.knative.dev', 'webhook.serving.knative.dev', 'validation.webhook.serving.knative.dev']) {
      assert.match(gatedText, new RegExp(`get[^\\n]*${name.replaceAll('.', '\\.')}`), `CA gate did not inspect ${name}`)
    }
    const probes = gatedCalls.filter((call) => (
      (call.args ?? []).some((arg) => /^--dry-run(?:=server)?$/.test(arg) || arg === '--dry-run=server')
      && /serving\.knative\.dev\/v1/.test(call.stdin ?? '')
      && /"?kind"?\s*:\s*"?Service/i.test(call.stdin ?? '')
    ))
    assert.equal(probes.length, 1, 'admission probe must be one server-side dry-run Knative Service write')
  } finally { invocation.cleanup() }
})

// bbx-8-038 | fn-managed-knative-inventory-scope | OpenSpec #### Scenario: Clean cluster passes preflight and records one owner
test('preflight ignores unrelated CRDs, RBAC, and admission webhooks while remaining read-only', () => {
  const invocation = invokeCli(['preflight', '--mode', 'managed', '--owner', 'bbx-owner', '--output', 'json'], 'inventory-unrelated-only', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    assertSuccess(invocation.result, 'clean preflight with unrelated cluster extensions')
    assert.equal(mutationCalls(invocation).length, 0)
    const inventoryQueries = invocation.kubectlCalls.map((call) => (call.args ?? []).join(' ')).join('\n')
    assert.match(inventoryQueries, /customresourcedefinitions/i)
    assert.match(inventoryQueries, /clusterroles/i)
    assert.match(inventoryQueries, /vwc,mwc|validatingwebhook|mutatingwebhook/i)
  } finally { invocation.cleanup() }
})

// bbx-8-039 | fn-managed-knative-complete-inventory | OpenSpec #### Scenario: Existing Operator or foreign ownership is not adopted
test('known bundle namespace, Serverless RBAC, and partial webhook inventory each fail before mutation', () => {
  for (const scenario of ['inventory-known-bundle-namespace', 'inventory-serverless-rbac', 'inventory-partial-webhook']) {
    const invocation = invokeCli(['preflight', '--mode', 'managed', '--owner', 'bbx-owner', '--output', 'json'], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(invocation, scenario)
      assert.equal(mutationCalls(invocation).length, 0)
      assert.match(evidence, /owner|existing|operator|partial|handoff|external|disabled/i)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-040 | fn-managed-knative-final-publication | OpenSpec #### Scenario: Lifecycle status is published Helm-owned after smoke
test('the exact final Helm release renders compatible status, projector, and the adopted safe runtime bundle', () => {
  const invocation = invokeCli(['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json'], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'managed install before final publication replay')
    const finalCall = invocation.helmCalls.find((call) => helmSuppliedValues(call).includes('status.state=compatible'))
    assert.ok(finalCall, 'CLI never invoked Helm for compatible lifecycle publication')
    const replay = run('helm', [
      'template', 'falcone-knative', managedChart, '--namespace', 'knative-serving',
      ...helmValueArgs(finalCall),
    ])
    assertSuccess(replay, 'exact CLI final Helm values')
    const objects = yamlDocuments(replay.stdout)
    const lifecycleMaps = objects.filter((object) => object.kind === 'ConfigMap' && Object.values(object.data ?? {}).some((value) => String(value).includes('falcone.knative-lifecycle/v1')))
    assert.equal(lifecycleMaps.length, 1)
    const lifecycle = JSON.parse(Object.values(lifecycleMaps[0].data).find((value) => String(value).includes('falcone.knative-lifecycle/v1')))
    assert.equal(lifecycle.status, 'compatible')
    assert.equal(lifecycleMaps[0].metadata.labels?.['falcone.io/knative-owner'], 'bbx-owner')
    assert.ok(objects.some((object) => object.kind === 'Deployment' && /projector/i.test(object.metadata?.name ?? '')), 'final render omitted long-lived projector')
    assert.ok(objects.some((object) => object.kind === 'ConfigMap' && Object.values(object.data ?? {}).some((value) => /while\s+true/.test(String(value)))), 'final render omitted projector executable')
    assert.ok(objects.some((object) => object.kind === 'Deployment' && object.metadata?.name === 'controller'), 'final Helm release omitted the Serving controller')
    assert.ok(objects.some((object) => object.kind === 'Deployment' && object.metadata?.name === 'net-kourier-controller'), 'final Helm release omitted the Kourier controller')
    assert.ok(objects.some((object) => object.kind === 'Deployment' && object.metadata?.name === '3scale-kourier-gateway'), 'final Helm release omitted the Kourier gateway')
    assert.ok(!objects.some((object) => object.kind === 'CustomResourceDefinition'), 'final Helm release adopted retained CRDs')
    assert.ok(!objects.some((object) => object.kind === 'Namespace'), 'final Helm release adopted retained namespaces')
  } finally { invocation.cleanup() }
})

// bbx-8-041 | fn-managed-knative-upgrade-same-owner | OpenSpec #### Scenario: Upgrade skipping a minor version is rejected
test('same-owner 1.21.1 to 1.22.1 upgrade reuses exclusive ownership, records recovery, gates storage, and smokes before ready', () => {
  const invocation = invokeCli([
    'upgrade', '--from-version', '1.21.1', '--to-version', '1.22.1', '--owner', 'bbx-owner',
    '--release', 'falcone-knative', '--recovery-point', 'bbx-recovery-8', '--output', 'json',
  ], 'upgrade-same-owner')
  try {
    assertSuccess(invocation.result, 'same-owner one-minor upgrade')
    const ownershipCreates = invocation.kubectlCalls.filter((call) => (
      (call.args ?? []).includes('create') && /falcone-knative-ownership/.test(call.stdin ?? '')
    ))
    assert.deepEqual(ownershipCreates, [], 'upgrade attempted to create/adopt a second exclusive owner marker')
    const recovery = appliedConfigMaps(invocation).find((map) => map.metadata?.name === 'bbx-recovery-8')
    assert.ok(recovery, 'upgrade did not persist the requested recovery point')
    assert.match(JSON.stringify(recovery.data ?? {}), /inventory|stored|version|image|config/i)
    const log = `${callText(invocation.kubectlCalls)}\n${combined(invocation.result)}`
    const storageGate = findIndex(log, /storedVersions|stored.?version|storage.?migration|customresourcedefinition/i, 'stored-version compatibility gate')
    const recoveryIndex = findIndex(log, /bbx-recovery-8|recovery.?point/i, 'recovery point')
    const smoke = findIndex(log, /ksvc|smoke/i, 'upgrade smoke gate')
    const ready = findIndex(log, /(?:state|stage|status)["':= ]+(?:ready|compatible)/i, 'upgrade ready publication')
    assert.ok(storageGate < recoveryIndex && recoveryIndex < smoke && smoke < ready)
  } finally { invocation.cleanup() }
})

// bbx-8-042 | fn-managed-knative-upgrade-storage-gate | OpenSpec #### Scenario: Irreversible storage migration blocks incompatible downgrade
test('upgrade rejects an unsupported stored CRD version before recovery or bundle mutation', () => {
  const invocation = invokeCli([
    'upgrade', '--from-version', '1.21.1', '--to-version', '1.22.1', '--owner', 'bbx-owner',
    '--release', 'falcone-knative', '--recovery-point', 'bbx-recovery-8', '--output', 'json',
  ], 'upgrade-stored-version-incompatible', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'unsupported stored-version upgrade')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /stored|storage|v1alpha0/i)
    assert.doesNotMatch(evidence, /"(?:state|status)"\s*:\s*"(?:ready|compatible)"/i)
  } finally { invocation.cleanup() }
})

// bbx-8-043 | fn-managed-knative-transition-selectors | OpenSpec #### Scenario: A transition updates every registered projection
test('outage/recovery selectors and handoff exact targets match rendered managed controllers before projection', () => {
  const { objects } = render(managedChart, ['--set-string', 'owner=bbx-owner'])
  const required = ['controller', 'net-kourier-controller'].map((name) => objects.find((object) => (
    object.kind === 'Deployment' && object.metadata?.namespace === 'knative-serving' && object.metadata?.name === name
  )))
  assert.ok(required.every(Boolean), 'rendered managed controller inventory is incomplete')

  const invocations = [
    { targeting: 'selector', invocation: invokeCli(['acceptance', 'outage', ...verifiedTargetArgs], 'acceptance-outage') },
    { targeting: 'selector', invocation: invokeCli(['acceptance', 'recover', ...verifiedTargetArgs], 'acceptance-recover') },
    {
      targeting: 'exact',
      invocation: invokeCli([
        'handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner',
        '--backup-evidence', 'bbx-backup-8', '--output', 'json',
      ], 'handoff-target-fail'),
    },
  ]
  try {
    for (const { targeting, invocation } of invocations) {
      if (targeting === 'selector') {
        const selectorCalls = invocation.kubectlCalls.filter((call) => (call.args ?? []).includes('-l') && (call.args ?? []).includes('scale'))
        assert.ok(selectorCalls.length > 0, 'transition did not select managed Serving controllers')
        for (const call of selectorCalls) {
          const selector = call.args[call.args.indexOf('-l') + 1]
          const requirements = selector.split(',').map((entry) => {
            const separator = entry.indexOf('=')
            return [entry.slice(0, separator), entry.slice(separator + 1)]
          })
          assert.ok(
            required.every((object) => requirements.every(([key, value]) => object.metadata?.labels?.[key] === value)),
            `selector ${selector} does not match rendered controller and Kourier workloads`,
          )
        }
      } else {
        for (const deployment of required) {
          assert.ok(
            invocation.kubectlCalls.some((call) => callTargetsDeployment(call, deployment)),
            `handoff did not target verified writer ${deployment.metadata.namespace}/${deployment.metadata.name}`,
          )
        }
      }
      const firstScale = invocation.kubectlCalls.findIndex((call) => (call.args ?? []).includes('scale'))
      const firstProjection = invocation.kubectlCalls.findIndex((call) => /falcone\.knative-runtime\/v1/.test(call.stdin ?? ''))
      if (firstProjection >= 0) assert.ok(firstScale >= 0 && firstScale < firstProjection, 'transition projected status before targeting workloads')
    }
  } finally {
    for (const { invocation } of invocations) invocation.cleanup()
  }
})

// bbx-8-044 | fn-managed-knative-projector-live-readiness | OpenSpec #### Scenario: Projection never fabricates readiness
test('compatible lifecycle evidence cannot refresh stale ready while a live managed controller is unavailable', () => {
  const { objects } = render(managedChart)
  const execution = executeProjector(renderedProjectorScript(objects), 'serving-controller-outage')
  try {
    const requiredReads = [
      '/apis/apps/v1/namespaces/knative-serving/deployments/controller',
      '/apis/apps/v1/namespaces/knative-serving/deployments/net-kourier-controller',
      '/apis/apps/v1/namespaces/kourier-system/deployments/3scale-kourier-gateway',
      '/api/v1/namespaces/knative-serving/endpoints/webhook',
    ]
    for (const path of requiredReads) {
      assert.ok(execution.calls.some((call) => call.method === 'GET' && call.url.endsWith(path)), `projector omitted live readiness read ${path}`)
    }
    const runtimePath = '/api/v1/namespaces/falcone-app-a/configmaps/falcone-knative-runtime'
    const writes = execution.calls.filter((call) => call.method === 'PUT' && call.url.endsWith(runtimePath))
    assert.equal(writes.length, 1, 'same-owner outage must replace the stale ready projection exactly once')
    const configMap = JSON.parse(writes[0].body)
    const document = runtimeDocument(configMap)
    assert.ok(document, 'projector PUT lacks falcone.knative-runtime/v1')
    assert.equal(document.readiness.state, 'unavailable')
    assert.notEqual(document.readiness.state, 'ready')
    assert.match(document.readiness.reason, /controller|serving|probe|unavailable/i)
  } finally { execution.cleanup() }
})

// bbx-8-045 | fn-managed-knative-create-namespace-registration | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('active modes register a pre-created release namespace idempotently without making it an ordinary Helm Namespace', () => {
  const releaseNamespace = 'falcone-bbx'
  for (const mode of ['managed', 'external']) {
    const resolvedOwner = `bbx-${mode}-owner`
    const { objects } = render(umbrellaChart, [
      '--set-string', `global.knativeRuntime.mode=${mode}`,
      '--set-string', `global.knativeRuntime.owner=${resolvedOwner}`,
    ])

    assert.ok(
      !objects.some((object) => object.kind === 'Namespace' && object.metadata?.name === releaseNamespace),
      `${mode} renders ${releaseNamespace} as an ordinary Helm-owned Namespace that conflicts with helm --create-namespace`,
    )

    const hooks = objects.filter((object) => object.metadata?.annotations?.['helm.sh/hook'])
    const registrationJobs = hooks.filter(isNamespaceRegistrationJob)
    assert.equal(registrationJobs.length, 1, `${mode} must render exactly one namespace-registration hook Job`)
    const job = registrationJobs[0]
    assert.ok(!hookEvents(job).includes('pre-delete'), `${mode} registration count included its uninstall revoker`)
    assert.equal(job.metadata.namespace ?? releaseNamespace, releaseNamespace)
    const podSpec = job.spec?.template?.spec
    assert.ok(podSpec?.serviceAccountName, 'namespace-registration Job must use a dedicated service account')
    const contract = JSON.stringify([
      ...(podSpec.initContainers ?? []).map((container) => ({ command: container.command, args: container.args, env: container.env })),
      ...(podSpec.containers ?? []).map((container) => ({ command: container.command, args: container.args, env: container.env })),
    ])
    assert.match(contract, new RegExp(`(?:namespace|namespaces)[^\\n]*${releaseNamespace}|${releaseNamespace}[^\\n]*(?:namespace|namespaces)`, 'i'))
    assert.match(contract, /falcone\.io\/knative-runtime-projection(?:["'=:\\s]+)enabled/i)
    assertRegistrationOwnerContract(contract, resolvedOwner)
    assert.match(contract, /--overwrite|\bpatch\b|\bapply\b/i, 'registration must be idempotent on an already-created Namespace')
    assert.doesNotMatch(contract, /--all(?:-namespaces)?|["']-A["']/i, 'registration must never select every namespace')

    const bindings = hooks.filter((object) => (
      object.kind === 'ClusterRoleBinding'
      && object.roleRef?.kind === 'ClusterRole'
      && (object.subjects ?? []).some((subject) => (
        subject.kind === 'ServiceAccount'
        && subject.name === podSpec.serviceAccountName
        && subject.namespace === releaseNamespace
      ))
    ))
    assert.equal(bindings.length, 1, `${mode} registration service account must be bound exactly once`)
    const subjects = bindings[0].subjects ?? []
    assert.deepEqual(subjects.map((subject) => ({ kind: subject.kind, name: subject.name, namespace: subject.namespace })), [{
      kind: 'ServiceAccount',
      name: podSpec.serviceAccountName,
      namespace: releaseNamespace,
    }])

    const namespaceRoles = hooks.filter((object) => (
      object.kind === 'ClusterRole'
      && object.metadata?.name === bindings[0].roleRef.name
      && (object.rules ?? []).some((rule) => (
        (rule.apiGroups ?? []).includes('')
        && (rule.resources ?? []).includes('namespaces')
        && (rule.verbs ?? []).some((verb) => ['patch', 'update'].includes(verb))
      ))
    ))
    assert.equal(namespaceRoles.length, 1, `${mode} registration must have one hook-scoped namespace writer`)
    const namespaceRole = namespaceRoles[0]
    for (const rule of namespaceRole.rules ?? []) {
      if (!(rule.resources ?? []).includes('namespaces')) continue
      assert.deepEqual(rule.resourceNames ?? [], [releaseNamespace], 'registration RBAC may mutate only .Release.Namespace')
      assert.ok(!(rule.verbs ?? []).some((verb) => ['create', 'delete', 'deletecollection'].includes(verb)))
    }
  }

  const disabled = render(umbrellaChart, ['--set-string', 'global.knativeRuntime.mode=disabled'])
  assert.ok(!disabled.objects.some((object) => (
    object.metadata?.annotations?.['helm.sh/hook']
    && /falcone\.io\/knative-runtime-projection/.test(JSON.stringify(object))
  )), 'disabled mode must not add namespace-registration hooks to the baseline render')
})

// bbx-8-046 | fn-managed-knative-projector-api-isolation | OpenSpec #### Scenario: The projector is read-only against the serving layer
test('Kubernetes RBAC, not a projector label check alone, confines runtime writes to each registered namespace', () => {
  const { objects: managedObjects } = render(managedChart, ['--set-string', 'owner=bbx-owner'])
  const projectorServiceAccount = managedObjects.find((object) => (
    object.kind === 'ServiceAccount' && /status-projector/.test(object.metadata?.name ?? '')
  ))
  assert.ok(projectorServiceAccount, 'managed chart lacks the projector service account')

  const clusterBindings = managedObjects.filter((object) => (
    object.kind === 'ClusterRoleBinding'
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === projectorServiceAccount.metadata.name
      && subject.namespace === projectorServiceAccount.metadata.namespace
    ))
  ))
  const clusterRoleNames = new Set(clusterBindings.map((binding) => binding.roleRef?.name))
  const clusterRoles = managedObjects.filter((object) => object.kind === 'ClusterRole' && clusterRoleNames.has(object.metadata?.name))
  for (const role of clusterRoles) {
    for (const rule of role.rules ?? []) {
      if (!(rule.resources ?? []).includes('configmaps')) continue
      assert.ok(
        !(rule.verbs ?? []).some((verb) => ['create', 'update', 'patch', 'delete', 'deletecollection'].includes(verb)),
        `projector ClusterRole ${role.metadata.name} grants cross-namespace ConfigMap writes despite resourceNames not being namespace scope`,
      )
    }
  }

  const registration = registrationHookObjects('managed')
  const targetRoles = registration.filter((object) => (
    object.kind === 'Role'
    && object.metadata?.namespace === 'falcone-bbx'
    && (object.rules ?? []).some((rule) => (
      (rule.apiGroups ?? []).includes('')
      && (rule.resources ?? []).includes('configmaps')
      && (rule.resourceNames ?? []).includes('falcone-knative-runtime')
      && (rule.verbs ?? []).some((verb) => ['update', 'patch'].includes(verb))
    ))
  ))
  assert.equal(targetRoles.length, 1, 'registered namespace must expose exactly one namespace-scoped runtime writer Role')
  const role = targetRoles[0]
  for (const rule of role.rules ?? []) {
    if (!(rule.resources ?? []).includes('configmaps')) continue
    assert.deepEqual(rule.resourceNames ?? [], ['falcone-knative-runtime'])
    assert.ok(!(rule.verbs ?? []).some((verb) => ['delete', 'deletecollection'].includes(verb)))
  }

  const targetBindings = registration.filter((object) => (
    object.kind === 'RoleBinding'
    && object.metadata?.namespace === 'falcone-bbx'
    && object.roleRef?.kind === 'Role'
    && object.roleRef?.name === role.metadata.name
  ))
  assert.equal(targetBindings.length, 1, 'registered namespace must bind its runtime writer Role exactly once')
  assert.deepEqual((targetBindings[0].subjects ?? []).map((subject) => ({
    kind: subject.kind, name: subject.name, namespace: subject.namespace,
  })), [{
    kind: 'ServiceAccount',
    name: projectorServiceAccount.metadata.name,
    namespace: projectorServiceAccount.metadata.namespace,
  }])
  assert.equal(targetBindings[0].metadata?.labels?.['falcone.io/knative-owner'], 'bbx-owner')
})

// bbx-8-047 | fn-managed-knative-registration-ownership | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('namespace registration is repeatable for the same owner and refuses a foreign owner with zero mutation', () => {
  const jobs = registrationHookObjects('managed').filter(isNamespaceRegistrationJob)
  assert.equal(jobs.length, 1, 'managed mode must expose exactly one namespace registration Job')
  assert.ok(!hookEvents(jobs[0]).includes('pre-delete'), 'registration execution selected the uninstall revoker')

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sameOwner = executeRegistrationJob(jobs[0], 'registration-same-owner')
    try {
      assertSuccess(sameOwner.result, `same-owner namespace registration attempt ${attempt}`)
      const writes = mutationCalls(sameOwner)
      for (const call of writes) {
        const contract = `${(call.args ?? []).join(' ')}\n${submittedText(call)}`
        assert.match(contract, /falcone\.io\/knative-owner(?:=|["':\s]+)bbx-owner/i)
        assert.doesNotMatch(contract, /foreign-owner/i)
      }
    } finally { sameOwner.cleanup() }
  }

  const foreignOwner = executeRegistrationJob(jobs[0], 'registration-foreign-owner')
  try {
    const evidence = assertLifecycleFailure(foreignOwner, 'foreign-owned namespace registration')
    assert.equal(mutationCalls(foreignOwner).length, 0, 'foreign owner refusal must occur before namespace label/annotation mutation')
    assert.match(evidence, /foreign|different|owner|refus|conflict/i)
  } finally { foreignOwner.cleanup() }
})

// bbx-8-048 | fn-managed-knative-registration-revocation | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('registration privilege is ephemeral and active-to-disabled or uninstall revokes the owner registration', () => {
  const isKnativeHook = (object) => (
    hookEvents(object).length > 0
    && /falcone\.io\/knative-(?:runtime-projection|owner)/.test(JSON.stringify(object))
  )
  const defaultDisabled = render(umbrellaChart)
  const explicitDisabled = render(umbrellaChart, ['--set-string', 'global.knativeRuntime.mode=disabled'])
  assert.ok(!defaultDisabled.objects.some(isKnativeHook), 'default disabled render added a Knative registration/revocation hook')
  assert.ok(!explicitDisabled.objects.some(isKnativeHook), 'ordinary explicit disabled render added a Knative registration/revocation hook')

  const values = readYaml(resolve(umbrellaChart, 'values.yaml'))
  const schema = JSON.parse(readFileSync(resolve(umbrellaChart, 'values.schema.json'), 'utf8'))
  const unregisterSchema = schema?.properties?.global?.properties?.knativeRuntime?.properties?.unregister
  assert.ok(unregisterSchema, 'values schema lacks the explicit global.knativeRuntime.unregister transition gate')
  assert.equal(unregisterSchema.type, 'boolean')
  assert.equal(unregisterSchema.default, false)
  assert.equal(values?.global?.knativeRuntime?.unregister, false)

  for (const mode of ['managed', 'external']) {
    const invalid = run('helm', [
      'template', 'falcone-bbx', umbrellaChart, '--namespace', 'falcone-bbx',
      '--set-string', `global.knativeRuntime.mode=${mode}`,
      '--set', 'global.knativeRuntime.unregister=true',
    ])
    assertFailure(invalid, `${mode} with unregister=true`)
    assert.match(combined(invalid), /unregister|disabled|knativeRuntime/i)
  }

  const active = registrationHookObjects('managed')
  const privilegeObjects = active.filter((object) => ['ServiceAccount', 'ClusterRole', 'ClusterRoleBinding', 'Job'].includes(object.kind))
  assert.ok(privilegeObjects.length >= 4, 'registration hook privilege set is incomplete')
  for (const object of privilegeObjects) {
    const policy = object.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? ''
    assert.match(policy, /hook-succeeded/, `${object.kind}/${object.metadata?.name} remains reusable after a successful hook`)
    assert.match(policy, /hook-failed/, `${object.kind}/${object.metadata?.name} remains reusable after a refused/failed hook`)
  }

  const isRevoker = (object, requiredHook) => {
    if (object.kind !== 'Job') return false
    const hooks = object.metadata?.annotations?.['helm.sh/hook'] ?? ''
    if (!hooks.split(',').includes(requiredHook)) return false
    const contract = JSON.stringify(object.spec?.template?.spec?.containers ?? [])
    return /falcone\.io\/knative-runtime-projection/.test(contract)
      && /falcone\.io\/knative-owner/.test(contract)
      && /(?:label[^\n]*(?:-|remove)|patch[^\n]*(?:remove|null))/i.test(contract)
  }

  const uninstallRevokers = active.filter((object) => isRevoker(object, 'pre-delete'))
  assert.equal(uninstallRevokers.length, 1, 'active release must revoke namespace registration during uninstall')

  const unregisteringDisabled = registrationHookObjects('disabled', 'bbx-owner', [
    '--set', 'global.knativeRuntime.unregister=true',
  ])
  const disableRevokers = unregisteringDisabled.filter((object) => isRevoker(object, 'pre-upgrade'))
  assert.equal(disableRevokers.length, 1, 'disabled + unregister=true must revoke the previous active namespace registration')
  for (const revoker of [...uninstallRevokers, ...disableRevokers]) {
    const contract = JSON.stringify(revoker.spec?.template?.spec?.containers ?? [])
    assert.match(contract, /(?:get|jsonpath|go-template)[^\n]*falcone\.io\/knative-owner|falcone\.io\/knative-owner[^\n]*(?:get|jsonpath|go-template)/i)
    assert.match(contract, /bbx-owner/i, 'revocation may remove only its own owner registration')
  }
})

// bbx-8-049 | fn-managed-knative-mutation-ownership | OpenSpec #### Scenario: Existing Operator or foreign ownership is not adopted
test('every mutation of an existing managed runtime requires the matching exclusive owner marker before mutation', () => {
  const cases = [
    ['install', ['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json']],
    ['upgrade', ['upgrade', '--from-version', '1.21.1', '--to-version', '1.22.1', '--owner', 'bbx-owner', '--recovery-point', 'bbx-recovery-8', '--output', 'json']],
    ['rollback', ['rollback', '--to-version', '1.22.1', '--owner', 'bbx-owner', '--recovery-point', 'bbx-recovery-8', '--output', 'json']],
    ['uninstall', ['uninstall', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json']],
    ['confirmed purge', ['purge', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--backup-evidence', 'bbx-backup-8', '--confirm-purge', 'PURGE-falcone-knative-bbx-owner', '--output', 'json']],
    ['handoff', ['handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner', '--backup-evidence', 'bbx-backup-8', '--output', 'json']],
    ['acceptance outage', ['acceptance', 'outage', ...verifiedTargetArgs]],
  ]

  for (const [label, args] of cases) {
    const invocation = invokeCli(args, 'owner-marker-absent-existing', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(invocation, `${label} without exclusive owner marker`)
      assert.equal(mutationCalls(invocation).length, 0, `${label} mutated before proving the exclusive owner marker`)
      assert.match(evidence, /exclusive.*owner|owner.*marker|ownership.*missing|owner.*absent/i)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-050 | fn-managed-knative-handoff-exclusive-transfer | OpenSpec #### Scenario: Handoff prevents simultaneous ownership
test('successful handoff quiesces the serving plane, gateway, and projector, transfers complete state, and denies the old owner', () => {
  const invocation = invokeCli([
    'handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner',
    '--backup-evidence', 'bbx-backup-8', '--output', 'json',
  ], 'handoff-success')
  try {
    assertSuccess(invocation.result, 'exclusive Falcone-to-Operator handoff')
    const rendered = run('helm', [
      'template', 'falcone-knative', managedChart, '--namespace', 'knative-serving', '--set-string', 'owner=bbx-owner',
    ])
    assertSuccess(rendered, 'render exact default handoff release')
    const objects = yamlDocuments(rendered.stdout)
    const requiredNames = ['controller', 'net-kourier-controller', '3scale-kourier-gateway']
    const requiredDeployments = requiredNames.map((name) => objects.find((object) => (
      object.kind === 'Deployment' && object.metadata?.name === name
    )))
    requiredDeployments.push(objects.find((object) => (
      object.kind === 'Deployment' && /status-projector/.test(object.metadata?.name ?? '')
    )))
    assert.ok(requiredDeployments.every(Boolean), 'rendered handoff quiesce inventory is incomplete')
    for (const deployment of requiredDeployments) {
      assert.ok(
        invocation.kubectlCalls.some((call) => callTargetsDeployment(call, deployment)),
        `handoff did not quiesce ${deployment.metadata.namespace}/${deployment.metadata.name}`,
      )
    }

    const ownerMutations = invocation.kubectlCalls.filter((call) => (
      mutationCalls({ kubectlCalls: [call], helmCalls: [] }).length > 0
      && /falcone-knative-ownership/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
    ))
    assert.equal(ownerMutations.length, 1, 'handoff must change the source exclusive marker exactly once')
    const ownerMutation = `${(ownerMutations[0].args ?? []).join(' ')}\n${submittedText(ownerMutations[0])}`
    const mergeRelease = /["']?data["']?\s*[:=][\s\S]*["']?state["']?\s*[:=]\s*["']released["']/i.test(ownerMutation)
    const jsonPatchRelease = /["']path["']\s*:\s*["']\/data\/state["'][\s\S]*["']value["']\s*:\s*["']released["']/i.test(ownerMutation)
    assert.ok(mergeRelease || jsonPatchRelease, 'handoff left ConfigMap data claiming exclusive ownership')
    assert.doesNotMatch(
      ownerMutation,
      /["']op["']\s*:\s*["'](?:add|replace)["'][\s\S]{0,160}["']path["']\s*:\s*["']\/data\/state["'][\s\S]{0,160}["']value["']\s*:\s*["']exclusive["']/i,
      'handoff wrote exclusive back into source marker data',
    )

    const evidence = combined(invocation.result)
    assert.match(evidence, /transferred|target.*exclusive|operator.*owner/i)
    assert.doesNotMatch(evidence, /quiesced["':=\s]+false/i, 'handoff must not resume Falcone writers after target acquisition')
  } finally { invocation.cleanup() }

  const oldOwner = invokeCli(['acceptance', 'outage', ...verifiedTargetArgs], 'owner-transferred-to-operator', {
    env: { FALCONE_BBX_REJECT_MUTATION: '1' },
  })
  try {
    const evidence = assertLifecycleFailure(oldOwner, 'old Falcone owner after completed handoff')
    assert.equal(mutationCalls(oldOwner).length, 0, 'old owner retained mutation authority after handoff')
    assert.match(evidence, /operator|different|foreign|owner|transferred/i)
  } finally { oldOwner.cleanup() }
})

// bbx-8-051 | fn-managed-knative-purge-isolation | OpenSpec #### Scenario: Destructive purge requires a separate confirmation
test('confirmed purge refuses before mutation for foreign or unowned custom resources and for unmatched backup evidence', () => {
  const cases = [
    ['purge-foreign-cr', /foreign|different.*owner|ownership/i],
    ['purge-unowned-cr', /unowned|missing.*owner|ownership/i],
    ['purge-unverified-backup', /backup.*(?:unverified|missing|mismatch|record)|(?:unverified|missing|mismatch).*backup/i],
  ]
  for (const [scenario, expected] of cases) {
    const invocation = invokeCli([
      'purge', '--owner', 'bbx-owner', '--release', 'falcone-knative',
      '--backup-evidence', 'bbx-backup-8', '--confirm-purge', 'PURGE-falcone-knative-bbx-owner', '--output', 'json',
    ], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(invocation, scenario)
      assert.equal(mutationCalls(invocation).length, 0, `${scenario} reached a destructive API call before complete isolation/backup proof`)
      assert.match(evidence, expected)
    } finally { invocation.cleanup() }
  }
})

// bbx-8-052 | fn-managed-knative-projection-fault-containment | OpenSpec #### Scenario: A transition updates every registered projection
test('one foreign runtime ConfigMap is refused without preventing projection into other valid owner namespaces', () => {
  const invocation = invokeCli(['acceptance', 'outage', ...verifiedTargetArgs], 'projection-one-foreign')
  try {
    assertSuccess(invocation.result, 'fault-contained outage projection')
    const runtimeMaps = appliedConfigMaps(invocation).filter((configMap) => runtimeDocument(configMap))
    const appAWrites = runtimeMaps.filter((configMap) => configMap.metadata?.namespace === 'falcone-app-a')
    const appBWrites = runtimeMaps.filter((configMap) => configMap.metadata?.namespace === 'falcone-app-b')
    assert.equal(appAWrites.length, 0, 'foreign-owned runtime ConfigMap was overwritten')
    assert.equal(appBWrites.length, 1, 'valid same-owner namespace was starved by an adjacent foreign ConfigMap')
    const document = runtimeDocument(appBWrites[0])
    assert.equal(document.owner, 'bbx-owner')
    assert.equal(document.readiness.state, 'unavailable')
    const evidence = combined(invocation.result)
    assertSecretSafe(evidence)
    assert.match(evidence, /foreign|owner.*mismatch|refus|skipp/i, 'transition omitted a bounded foreign-owner refusal')
  } finally { invocation.cleanup() }
})

// bbx-8-053 | fn-managed-knative-clean-install-source | OpenSpec #### Scenario: Clean cluster passes preflight and records one owner
test('clean install creates the absent status namespace before acquiring its single exclusive owner marker', () => {
  const invocation = invokeCli([
    'install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative',
    '--status-namespace', 'knative-serving', '--status-configmap', 'falcone-knative-status', '--output', 'json',
  ], 'clean-status-namespace-absent')
  try {
    assertSuccess(invocation.result, 'clean install with absent status namespace and marker')
    const namespaceIndex = invocation.kubectlCalls.findIndex((call) => {
      const command = (call.args ?? []).join(' ')
      const input = submittedText(call)
      return /\b(?:create|apply)\s+(?:namespace|ns)(?:\/|\s+)knative-serving\b/i.test(command)
        || (/\bkind:\s*Namespace\b/.test(input) && /\bname:\s*knative-serving\b/.test(input))
        || (/"kind"\s*:\s*"Namespace"/.test(input) && /"name"\s*:\s*"knative-serving"/.test(input))
    })
    const markerCalls = invocation.kubectlCalls.filter((call) => /falcone-knative-ownership/.test(submittedText(call)))
    assert.equal(markerCalls.length, 1, 'clean install must acquire exactly one owner marker')
    const markerIndex = invocation.kubectlCalls.indexOf(markerCalls[0])
    assert.ok(namespaceIndex >= 0 && namespaceIndex < markerIndex, 'owner marker was submitted before its status namespace existed')
    const marker = yamlDocuments(submittedText(markerCalls[0]).trim()).find((object) => object?.metadata?.name === 'falcone-knative-ownership')
    assert.equal(marker?.metadata?.namespace, 'knative-serving')
    assert.equal(marker?.data?.owner, 'bbx-owner')
    assert.equal(marker?.data?.state, 'exclusive')
  } finally { invocation.cleanup() }
})

// bbx-8-054 | fn-managed-knative-projector-metrics-runtime | OpenSpec #### Scenario: Security controls remain enforced
test('projector metrics sidecar serves the producer file from a shared writable web root as an explicit non-root user', () => {
  const { objects } = render(managedChart, publicManagedValueArgs({ platform: 'kubernetes' }))
  const deployment = objects.find((object) => (
    object.kind === 'Deployment' && /status-projector/.test(object.metadata?.name ?? '')
  ))
  assert.ok(deployment, 'managed chart omitted the status projector Deployment')
  const podSpec = deployment.spec?.template?.spec
  const projector = (podSpec?.containers ?? []).find((container) => container.name === 'projector')
  const metrics = (podSpec?.containers ?? []).find((container) => container.name === 'metrics')
  assert.ok(projector && metrics, 'projector Deployment must expose producer and metrics-server containers')

  const script = renderedProjectorScript(objects)
  const producedPath = /\bmv\s+[^\n]+\s+(\/[^\s"']*\/metrics)\b/.exec(script)?.[1]
  assert.ok(producedPath, 'projector script does not atomically publish a metrics file')
  const producerMount = (projector.volumeMounts ?? []).find((mount) => (
    producedPath === mount.mountPath || producedPath.startsWith(`${mount.mountPath}/`)
  ))
  assert.ok(producerMount, `projector metrics path ${producedPath} is not backed by a writable volume`)
  assert.notEqual(producerMount.readOnly, true, 'projector metrics producer mount is read-only')
  const volume = (podSpec.volumes ?? []).find((candidate) => candidate.name === producerMount.name)
  assert.ok(volume?.emptyDir, 'projector metrics producer requires a pod-local writable emptyDir')

  const serverContract = [...(metrics.command ?? []), ...(metrics.args ?? [])].join(' ')
  const webRoot = /(?:^|\s)-h\s+(\/\S+)/.exec(serverContract)?.[1]
  assert.ok(webRoot, 'metrics server does not declare its public document root')
  const serverMount = (metrics.volumeMounts ?? []).find((mount) => (
    mount.mountPath === webRoot || webRoot.startsWith(`${mount.mountPath}/`)
  ))
  assert.ok(serverMount, `metrics web root ${webRoot} is inside readOnlyRootFilesystem instead of a writable shared volume`)
  assert.equal(serverMount.name, producerMount.name, 'metrics server cannot receive the producer-written metrics file')
  assert.notEqual(serverMount.readOnly, true, 'metrics web root volume is mounted read-only')
  assert.equal(producedPath.split('/').at(-1), 'metrics')
  assert.match(serverContract, /(?:touch\s+)?\/[^\s;]*\/metrics|httpd[\s\S]*-h/, 'metrics sidecar does not serve the producer filename')

  assert.equal(metrics.securityContext?.readOnlyRootFilesystem, true)
  assert.equal(metrics.securityContext?.runAsNonRoot, true)
  assert.ok(
    Number.isInteger(metrics.securityContext?.runAsUser) && metrics.securityContext.runAsUser > 0,
    'vanilla Kubernetes rejects the root-default BusyBox image when runAsNonRoot lacks an explicit non-zero runAsUser',
  )
})

// bbx-8-055 | fn-managed-knative-final-release-ownership | OpenSpec #### Scenario: Lifecycle status is published Helm-owned after smoke
test('final Helm publication adopts every safe non-CRD staged object while CRDs remain under lifecycle custody', () => {
  const invocation = invokeCli([
    'install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json',
  ], 'clean-supported')
  try {
    assertSuccess(invocation.result, 'staged install before final Helm ownership replay')
    const stagedObjects = stagedBundleCalls(invocation).flatMap((call) => submittedObjects(call))
    const stagedCrds = stagedObjects.filter((object) => object?.kind === 'CustomResourceDefinition')
    assert.ok(stagedCrds.length > 0, 'public staged install did not expose its CRD custody boundary')
    const safeStagedObjects = stagedObjects.filter((object) => (
      object?.kind
      && !['CustomResourceDefinition', 'Namespace'].includes(object.kind)
      && object.metadata?.name
    ))
    assert.ok(safeStagedObjects.length > 0, 'public staged install did not expose non-CRD bundle objects')

    const finalCall = invocation.helmCalls.find((call) => helmSuppliedValues(call).includes('status.state=compatible'))
    assert.ok(finalCall, 'CLI never invoked Helm for final compatible publication')
    const replay = run('helm', [
      'template', 'falcone-knative', managedChart, '--namespace', 'knative-serving', ...helmValueArgs(finalCall),
    ])
    assertSuccess(replay, 'exact final Helm release replay')
    const finalObjects = yamlDocuments(replay.stdout)
    const key = (object) => [
      object.apiVersion, object.kind, object.metadata?.namespace ?? '', object.metadata?.name,
    ].join('|')
    const finalKeys = new Set(finalObjects.map(key))
    const missing = [...new Set(safeStagedObjects.map(key).filter((objectKey) => !finalKeys.has(objectKey)))]
    assert.deepEqual(missing, [], `final Helm release omitted ${missing.length} safe staged objects required for rollback/uninstall:\n${missing.join('\n')}`)
    assert.ok(!finalObjects.some((object) => object.kind === 'CustomResourceDefinition'), 'final Helm release adopted CRDs that retain tenant workload state')

    assert.ok(
      invocation.kubectlCalls.some((call) => /falcone-knative-ownership/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)),
      'safe takeover was not preceded by exclusive-owner marker acquisition/verification',
    )
    assert.ok((finalCall.args ?? []).includes('--take-ownership'), 'final Helm call did not explicitly adopt the preflight-authorized staged objects')
    assert.ok(helmSuppliedValues(finalCall).includes('lifecycle.installStage=complete'))
    assert.ok(helmSuppliedValues(finalCall).includes('status.state=compatible'))
  } finally { invocation.cleanup() }
})

// bbx-8-056 | fn-managed-knative-external-status-lifecycle | OpenSpec #### Scenario: Existing installation requires an explicit decision
test('external canary preflight remains observational and explicit install publishes refreshable verified external status only', () => {
  const externalArgs = [
    '--mode', 'external', '--owner', 'bbx-owner',
    '--external-canary', 'knative-serving/external-canary', '--output', 'json',
  ]
  const preflight = invokeCli(['preflight', ...externalArgs], 'external-canary-ready', {
    env: { FALCONE_BBX_REJECT_MUTATION: '1' },
  })
  try {
    assertSuccess(preflight.result, 'ready external canary preflight')
    assert.equal(mutationCalls(preflight).length, 0)
    const servingReads = preflight.kubectlCalls.filter((call) => /services\.serving\.knative\.dev|\bksvc\b/.test((call.args ?? []).join(' ')))
    assert.ok(servingReads.length > 0, 'external preflight did not read the supplied canary')
    for (const call of servingReads) {
      const command = (call.args ?? []).join(' ')
      assert.match(command, /(?:services\.serving\.knative\.dev|ksvc)\s+external-canary\b/i)
      assert.match(command, /(?:^|\s)-n\s+knative-serving\b/)
      assert.doesNotMatch(command, /(?:^|\s)-A(?:\s|$)|--all-namespaces/)
    }
    assert.ok(preflight.curlCalls.length > 0 || preflight.kubectlCalls.some((call) => (call.args ?? []).includes('exec')), 'external preflight did not invoke the supplied canary')
    assert.match(combined(preflight.result), /externalCanary[\s\S]*verified/i)
  } finally { preflight.cleanup() }

  for (const attempt of ['publish', 'refresh']) {
    const publication = invokeCli([
      'install', ...externalArgs, '--release', 'falcone-knative',
    ], 'external-canary-ready')
    try {
      assertSuccess(publication.result, `explicit external status ${attempt}`)
      const forbiddenMutations = mutationCalls(publication).filter((call) => (
        /serving\.knative\.dev|customresourcedefinition|admissionregistration|\bksvc\b|\bkourier\b|deployment\/|\bscale\b/i
          .test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
      ))
      assert.deepEqual(forbiddenMutations, [], `external status ${attempt} mutated external Serving/Kourier objects`)
      const documents = appliedConfigMaps(publication).map(runtimeDocument).filter(Boolean)
      assert.equal(documents.length, 2, `external status ${attempt} did not update every registered same-owner namespace`)
      for (const document of documents) {
        assert.equal(document.schemaVersion, 'falcone.knative-runtime/v1')
        assert.equal(document.mode, 'external')
        assert.equal(document.owner, 'bbx-owner')
        assert.equal(document.externalCanary?.state, 'verified')
        assert.equal(document.readiness?.state, 'ready')
        assert.ok(Date.parse(document.validUntil) > Date.parse(document.observedAt), 'external status lease is not refreshable and bounded')
        assertSecretSafe(JSON.stringify(document))
      }
    } finally { publication.cleanup() }
  }

  for (const scenario of ['external-canary-missing', 'external-canary-unhealthy']) {
    const rejected = invokeCli(['preflight', ...externalArgs], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(rejected, scenario)
      assert.equal(mutationCalls(rejected).length, 0)
      assert.match(evidence, /external|canary|unverified|missing|unhealthy|ready/i)
      assert.doesNotMatch(evidence, /"externalCanary"\s*:\s*\{[^}]*"state"\s*:\s*"verified"/i)
      assert.doesNotMatch(evidence, /"readiness"\s*:\s*\{[^}]*"state"\s*:\s*"ready"/i)
    } finally { rejected.cleanup() }
  }
})

// bbx-8-057 | fn-managed-knative-post-install-registration | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('post-install registration bootstraps one unavailable placeholder before labelling and refuses unsafe existing status', () => {
  const registration = registrationHookObjects('managed')
  const jobs = registration.filter(isNamespaceRegistrationJob)
  assert.equal(jobs.length, 1, 'managed registration must expose exactly one pre-install/pre-upgrade Job')
  const job = jobs[0]
  const serviceAccountName = job.spec?.template?.spec?.serviceAccountName
  assert.ok(serviceAccountName, 'registration Job lacks its ephemeral service account')

  const bootstrapBindings = registration.filter((object) => (
    object.kind === 'RoleBinding'
    && object.metadata?.namespace === 'falcone-bbx'
    && hookEvents(object).includes('pre-install')
    && hookEvents(object).includes('pre-upgrade')
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === serviceAccountName
      && subject.namespace === 'falcone-bbx'
    ))
  ))
  assert.equal(bootstrapBindings.length, 1, 'registration Job requires one ephemeral namespace-local RoleBinding')
  const bootstrapRole = registration.find((object) => (
    object.kind === 'Role'
    && object.metadata?.namespace === 'falcone-bbx'
    && object.metadata?.name === bootstrapBindings[0].roleRef?.name
  ))
  assert.ok(bootstrapRole, 'registration RoleBinding does not resolve to its namespace-local Role')
  for (const object of [bootstrapRole, bootstrapBindings[0]]) {
    const policy = object.metadata?.annotations?.['helm.sh/hook-delete-policy'] ?? ''
    assert.match(policy, /hook-succeeded/)
    assert.match(policy, /hook-failed/)
  }
  const configMapRules = (bootstrapRole.rules ?? []).filter((rule) => (
    (rule.apiGroups ?? []).includes('') && (rule.resources ?? []).includes('configmaps')
  ))
  const exactGetRules = configMapRules.filter((rule) => (
    (rule.verbs ?? []).includes('get')
    && (rule.resourceNames ?? []).length === 1
    && rule.resourceNames[0] === 'falcone-knative-runtime'
  ))
  assert.equal(exactGetRules.length, 1, 'registration may read only the exact runtime ConfigMap')
  const createRules = configMapRules.filter((rule) => (rule.verbs ?? []).includes('create'))
  assert.equal(createRules.length, 1, 'ephemeral registration Role requires ConfigMap create for first projection bootstrap')
  assert.ok(!(createRules[0].verbs ?? []).some((verb) => ['delete', 'deletecollection', 'patch', 'update'].includes(verb)))

  const repeated = executeRegistrationJobAttempts(job, 'registration-runtime-missing', 2)
  try {
    assertSuccess(repeated.results[0], 'first post-install namespace registration')
    assertSuccess(repeated.results[1], 'idempotent repeated namespace registration')
    const placeholderCallsByAttempt = repeated.attemptCalls.map((calls) => calls.filter((call) => (
      submittedObjects(call).some((object) => object?.kind === 'ConfigMap' && object.metadata?.name === 'falcone-knative-runtime')
    )))
    assert.equal(placeholderCallsByAttempt[0].length, 1, 'first registration must create exactly one runtime placeholder')
    assert.equal(placeholderCallsByAttempt[1].length, 0, 'repeated registration recreated the runtime placeholder')
    const placeholder = submittedObjects(placeholderCallsByAttempt[0][0]).find((object) => object?.metadata?.name === 'falcone-knative-runtime')
    assert.equal(placeholder.metadata?.namespace, 'falcone-bbx')
    assert.equal(placeholder.metadata?.labels?.['falcone.io/knative-owner'], 'bbx-owner')
    const document = runtimeDocument(placeholder)
    assert.ok(document, 'registration placeholder lacks falcone.knative-runtime/v1')
    assert.equal(document.owner, 'bbx-owner')
    assert.equal(document.readiness?.state, 'unavailable')
    assert.ok(Date.parse(document.validUntil) <= Date.parse(document.observedAt), 'registration placeholder must begin expired/fail-closed')
    const placeholderIndex = repeated.attemptCalls[0].indexOf(placeholderCallsByAttempt[0][0])
    const labelIndex = repeated.attemptCalls[0].findIndex((call) => (call.args ?? []).includes('label') && (call.args ?? []).includes('namespace'))
    assert.ok(placeholderIndex >= 0 && labelIndex > placeholderIndex, 'namespace was labelled before its fail-closed placeholder existed')
  } finally { repeated.cleanup() }

  for (const scenario of ['registration-runtime-foreign', 'registration-runtime-unowned']) {
    const refused = executeRegistrationJob(job, scenario)
    try {
      const evidence = assertLifecycleFailure(refused, scenario)
      assert.equal(mutationCalls(refused).length, 0, `${scenario} labelled or changed the namespace before refusing the existing runtime ConfigMap`)
      assert.match(evidence, /runtime|configmap|foreign|unowned|owner|refus/i)
    } finally { refused.cleanup() }
  }
})

// bbx-8-058 | fn-managed-knative-supported-rollback-storage-gate | OpenSpec #### Scenario: Irreversible storage migration blocks incompatible downgrade
test('supported-target rollback rejects incompatible live storedVersions before recovery or Helm mutation', () => {
  const invocation = invokeCli([
    'rollback', '--to-version', '1.22.1', '--owner', 'bbx-owner',
    '--recovery-point', 'bbx-recovery-8', '--release', 'falcone-knative', '--output', 'json',
  ], 'rollback-supported-stored-incompatible', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'supported rollback with incompatible live storage')
    assert.equal(mutationCalls(invocation).length, 0, 'rollback mutated recovery/Helm state before validating live CRD storage')
    assert.match(evidence, /storedVersions|stored.?version|storage/i)
    assert.match(evidence, /v1alpha0/i)
    assert.match(evidence, /restore|forward.?repair|incompatible/i)
  } finally { invocation.cleanup() }
})

// bbx-8-059 | fn-managed-knative-patch-downgrade-gate | OpenSpec #### Scenario: Upgrade skipping a minor version is rejected
test('upgrade rejects a same-minor patch downgrade before recovery or bundle mutation', () => {
  const invocation = invokeCli([
    'upgrade', '--from-version', '1.22.2', '--to-version', '1.22.1', '--owner', 'bbx-owner',
    '--release', 'falcone-knative', '--recovery-point', 'bbx-patch-downgrade-8', '--output', 'json',
  ], 'upgrade-patch-downgrade', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'same-minor patch downgrade through upgrade')
    assert.equal(mutationCalls(invocation).length, 0, 'patch downgrade created recovery state or mutated the bundle')
    assert.match(evidence, /1\.22\.2/)
    assert.match(evidence, /1\.22\.1/)
    assert.match(evidence, /downgrade|newer|order|rollback/i)
  } finally { invocation.cleanup() }
})

// bbx-8-060 | fn-managed-knative-fixed-status-namespace | OpenSpec #### Scenario: Lifecycle status is published Helm-owned after smoke
test('managed chart and CLI reject a status namespace other than fixed knative-serving before mutation', () => {
  const schema = JSON.parse(readFileSync(resolve(managedChart, 'values.schema.json'), 'utf8'))
  const namespaceSchema = schema?.properties?.status?.properties?.namespace
  assert.ok(namespaceSchema, 'managed chart schema lacks status.namespace')
  assert.ok(
    namespaceSchema.const === 'knative-serving'
      || (Array.isArray(namespaceSchema.enum) && namespaceSchema.enum.length === 1 && namespaceSchema.enum[0] === 'knative-serving'),
    'managed chart schema pretends the namespace-fixed bundle supports an arbitrary status namespace',
  )
  const rendered = run('helm', [
    'template', 'falcone-bbx', managedChart, '--namespace', 'knative-serving',
    '--set-string', 'status.namespace=other-serving',
  ])
  assertFailure(rendered, 'custom managed status namespace render')
  assert.match(combined(rendered), /status\.namespace|knative-serving|schema/i)

  const invocation = invokeCli([
    'install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative',
    '--status-namespace', 'other-serving', '--output', 'json',
  ], 'clean-supported', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
  try {
    const evidence = assertLifecycleFailure(invocation, 'custom managed status namespace CLI')
    assert.equal(mutationCalls(invocation).length, 0)
    assert.match(evidence, /status.?namespace|knative-serving|fixed|unsupported/i)
  } finally { invocation.cleanup() }
})

// bbx-8-061 | fn-managed-knative-reverse-handoff | OpenSpec #### Scenario: Handoff prevents simultaneous ownership
test('Operator-to-Falcone handoff trusts one active exclusive Operator marker plus backup and rejects ambiguity before mutation', () => {
  const args = [
    'handoff', '--from', 'operator', '--to', 'falcone', '--owner', 'operator',
    '--backup-evidence', 'bbx-operator-backup', '--release', 'falcone-knative', '--output', 'json',
  ]
  const success = invokeCli(args, 'reverse-handoff-success')
  try {
    assertSuccess(success.result, 'exclusive Operator-to-Falcone handoff without historical canonical marker')
    const calls = success.kubectlCalls
    const activeOwnerRead = calls.findIndex((call) => (
      (call.args ?? []).includes('get')
      && /configmaps?/.test((call.args ?? []).join(' '))
      && /falcone\.io\/active-owner=operator/.test((call.args ?? []).join(' '))
    ))
    const backupRead = calls.findIndex((call) => (
      (call.args ?? []).includes('get') && /bbx-operator-backup/.test((call.args ?? []).join(' '))
    ))
    const firstMutation = calls.findIndex((call) => mutationCalls({ kubectlCalls: [call], helmCalls: [] }).length > 0)
    assert.ok(activeOwnerRead >= 0, 'reverse handoff did not verify the active Operator owner marker')
    assert.ok(backupRead >= 0, 'reverse handoff did not verify the supplied backup record')
    assert.ok(firstMutation > activeOwnerRead && firstMutation > backupRead, 'reverse handoff mutated before owner/backup proof')
    assert.match(combined(success.result), /operator[\s\S]*falcone|falcone[\s\S]*transferred/i)
  } finally { success.cleanup() }

  for (const scenario of ['reverse-handoff-ambiguous', 'reverse-handoff-foreign']) {
    const rejected = invokeCli(args, scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
    try {
      const evidence = assertLifecycleFailure(rejected, scenario)
      assert.equal(mutationCalls(rejected).length, 0, `${scenario} was implicitly adopted or mutated before refusal`)
      assert.match(evidence, /operator|owner|ambiguous|foreign|exclusive|refus/i)
    } finally { rejected.cleanup() }
  }
})

// bbx-8-062 | fn-managed-knative-complete-collision-inventory | OpenSpec #### Scenario: Existing Operator or foreign ownership is not adopted
test('preflight inventories every overwriteable bundle kind and refuses each foreign or unowned collision before mutation', async (t) => {
  const cases = [
    ['foreign config-network ConfigMap', 'inventory-foreign-config-network', /(?:^|[,\s])(?:configmaps?|cm)(?:[.,\s]|$)/i],
    ['unowned webhook-certs Secret', 'inventory-unowned-webhook-certs', /(?:^|[,\s])secrets?(?:[.,\s]|$)/i],
    ['foreign controller ServiceAccount', 'inventory-foreign-controller-serviceaccount', /(?:^|[,\s])serviceaccounts?(?:[.,\s]|$)/i],
    ['unowned activator Role', 'inventory-unowned-activator-role', /(?:^|[,\s])roles?(?:\.rbac\.authorization\.k8s\.io)?(?:[,\s]|$)/i],
    ['foreign activator RoleBinding', 'inventory-foreign-activator-rolebinding', /(?:^|[,\s])rolebindings?(?:\.rbac\.authorization\.k8s\.io)?(?:[,\s]|$)/i],
    ['unowned webhook HPA', 'inventory-unowned-webhook-hpa', /(?:^|[,\s])(?:horizontalpodautoscalers?|hpa)(?:[.,\s]|$)/i],
    ['foreign webhook PDB', 'inventory-foreign-webhook-pdb', /(?:^|[,\s])(?:poddisruptionbudgets?|pdb)(?:[.,\s]|$)/i],
    ['unowned routing Certificate', 'inventory-unowned-routing-certificate', /(?:^|[,\s])certificates?(?:\.networking\.internal\.knative\.dev)?(?:[,\s]|$)/i],
  ]

  for (const [label, scenario, expectedRead] of cases) {
    await t.test(label, () => {
      const invocation = invokeCli([
        'install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json',
      ], scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
      try {
        const evidence = assertLifecycleFailure(invocation, label)
        assert.equal(mutationCalls(invocation).length, 0, `${label} reached a mutation before complete collision inventory`)
        const reads = invocation.kubectlCalls
          .filter((call) => (call.args ?? []).includes('get'))
          .map((call) => (call.args ?? []).join(' '))
        assert.ok(reads.some((command) => expectedRead.test(command)), `${label} kind was never inventoried through Kubernetes`)
        assert.match(evidence, /foreign|unowned|different|ownership|owner|collision|refus/i)
      } finally { invocation.cleanup() }
    })
  }
})

// bbx-8-063 | fn-managed-knative-owner-marker-agreement | OpenSpec #### Scenario: Existing Operator or foreign ownership is not adopted
test('every mutating operation requires metadata and data to agree on owner, release, and exclusive state', async (t) => {
  const operations = [
    ['install', ['install', '--mode', 'managed', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json']],
    ['upgrade', ['upgrade', '--from-version', '1.21.1', '--to-version', '1.22.1', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--recovery-point', 'bbx-recovery-8', '--output', 'json']],
    ['rollback', ['rollback', '--to-version', '1.22.1', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--recovery-point', 'bbx-recovery-8', '--output', 'json']],
    ['uninstall', ['uninstall', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--output', 'json']],
    ['purge', ['purge', '--owner', 'bbx-owner', '--release', 'falcone-knative', '--backup-evidence', 'bbx-backup-8', '--confirm-purge', 'PURGE-falcone-knative-bbx-owner', '--output', 'json']],
    ['handoff', ['handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner', '--backup-evidence', 'bbx-backup-8', '--output', 'json']],
    ['acceptance', ['acceptance', 'outage', ...verifiedTargetArgs]],
  ]
  for (const [operation, args] of operations) {
    await t.test(`${operation} refuses contradictory owner representations`, () => {
      const invocation = invokeCli(args, 'owner-marker-variant-owner-mismatch', { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
      try {
        const evidence = assertLifecycleFailure(invocation, `${operation} with contradictory marker owner`)
        assert.equal(mutationCalls(invocation).length, 0, `${operation} mutated while marker metadata and data disagreed`)
        assert.match(evidence, /owner|ownership|marker|metadata|data|mismatch|inconsistent/i)
      } finally { invocation.cleanup() }
    })
  }

  const remainingVariants = [
    'owner-label-missing',
    'release-missing',
    'release-mismatch',
    'release-label-missing',
    'state-mismatch',
    'state-data-missing',
    'state-annotation-missing',
  ]
  for (const variant of remainingVariants) {
    await t.test(`acceptance refuses ${variant}`, () => {
      const invocation = invokeCli(['acceptance', 'outage', ...verifiedTargetArgs], `owner-marker-variant-${variant}`, {
        env: { FALCONE_BBX_REJECT_MUTATION: '1' },
      })
      try {
        const evidence = assertLifecycleFailure(invocation, `incomplete or contradictory owner marker ${variant}`)
        assert.equal(mutationCalls(invocation).length, 0, `${variant} retained mutation authority`)
        assert.match(evidence, /owner|ownership|marker|release|state|exclusive|metadata|data|mismatch|missing|inconsistent/i)
      } finally { invocation.cleanup() }
    })
  }
})

// bbx-8-064 | fn-managed-knative-exact-purge | OpenSpec #### Scenario: Destructive purge requires a separate confirmation
test('purge deletes only verified resources and exact bundle CRD names while refusing non-bundle or unowned cascade risk', async (t) => {
  const args = [
    'purge', '--owner', 'bbx-owner', '--release', 'falcone-knative',
    '--backup-evidence', 'bbx-backup-8', '--confirm-purge', 'PURGE-falcone-knative-bbx-owner', '--output', 'json',
  ]

  await t.test('exact verified bundle purge', () => {
    const invocation = invokeCli(args, 'purge-exact-owned-bundle')
    try {
      assertSuccess(invocation.result, 'exact-name verified purge')
      const destructiveCalls = invocation.kubectlCalls.filter((call) => (call.args ?? []).includes('delete'))
      assert.ok(destructiveCalls.length > 0, 'confirmed purge did not delete its verified inventory')
      for (const call of destructiveCalls) {
        const contract = `${(call.args ?? []).join(' ')}\n${submittedText(call)}`
        assert.doesNotMatch(contract, /(?:^|\s)(?:-l|--selector)(?:=|\s)/, 'purge used a broad owner selector after verifying individual resources')
        assert.doesNotMatch(contract, /deletecollection/i, 'purge used collection deletion')
      }

      const { objects: crdStage } = render(managedChart, [
        '--set', 'lifecycle.installStage=crds', '--set-string', 'owner=bbx-owner',
      ])
      const expectedCrdNames = crdStage
        .filter((object) => object.kind === 'CustomResourceDefinition')
        .map((object) => object.metadata?.name)
        .sort()
      assert.ok(expectedCrdNames.length > 0, 'public CRD stage exposed no exact purge inventory')
      const crdDeleteText = destructiveCalls
        .filter((call) => /customresourcedefinitions?|\bcrds?\b/i.test((call.args ?? []).join(' ')))
        .map((call) => `${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
        .join('\n')
      const deletedCrdNames = expectedCrdNames.filter((name) => crdDeleteText.includes(name)).sort()
      assert.deepEqual(deletedCrdNames, expectedCrdNames, 'purge did not name every verified installed bundle CRD explicitly')
      assert.doesNotMatch(crdDeleteText, /widgets\.example\.test/, 'purge crossed into an owner-labelled non-bundle CRD')
    } finally { invocation.cleanup() }
  })

  for (const [scenario, expected] of [
    ['purge-extra-owner-crd', /non.?bundle|unexpected|inventory|widgets|refus/i],
    ['purge-unowned-bundle-cr', /unowned|missing.*owner|ownership|refus/i],
  ]) {
    await t.test(scenario, () => {
      const invocation = invokeCli(args, scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
      try {
        const evidence = assertLifecycleFailure(invocation, scenario)
        assert.equal(mutationCalls(invocation).length, 0, `${scenario} reached a cascade-capable mutation`)
        assert.match(evidence, expected)
      } finally { invocation.cleanup() }
    })
  }
})

// bbx-8-065 | fn-managed-knative-handoff-writer-proof | OpenSpec #### Scenario: Handoff prevents simultaneous ownership
test('handoff verifies its complete writer inventory and zero live replicas before releasing or enabling either owner', async (t) => {
  const args = [
    'handoff', '--from', 'falcone', '--to', 'operator', '--owner', 'bbx-owner',
    '--backup-evidence', 'bbx-backup-8', '--output', 'json',
  ]

  await t.test('complete writer inventory reaches observed quiescence before transfer', () => {
    const invocation = invokeCli(args, 'handoff-success')
    try {
      assertSuccess(invocation.result, 'fully verified writer handoff')
      const rendered = run('helm', [
        'template', 'falcone-knative', managedChart, '--namespace', 'knative-serving', '--set-string', 'owner=bbx-owner',
      ])
      assertSuccess(rendered, 'render exact handoff release inventory')
      const expectedWriters = yamlDocuments(rendered.stdout).filter((object) => (
        object.kind === 'Deployment'
        && object.metadata?.labels?.['app.kubernetes.io/part-of'] === 'falcone-knative'
        && object.metadata?.labels?.['falcone.io/knative-owner'] === 'bbx-owner'
      ))
      assert.ok(expectedWriters.length >= 7, 'public bundle did not expose its complete Serving/Kourier/projector writer inventory')

      const calls = invocation.kubectlCalls
      const firstMutation = calls.findIndex((call) => mutationCalls({ kubectlCalls: [call], helmCalls: [] }).length > 0)
      const inventoryIndex = calls.findIndex((call) => (
        (call.args ?? []).includes('get') && /deployments?(?:\.apps)?/.test((call.args ?? []).join(' '))
      ))
      assert.ok(inventoryIndex >= 0 && inventoryIndex < firstMutation, 'handoff mutated before inventorying writers')
      for (const deployment of expectedWriters) {
        assert.ok(calls.some((call) => callTargetsDeployment(call, deployment)), `handoff did not quiesce ${deployment.metadata.namespace}/${deployment.metadata.name}`)
      }

      const scaleIndexes = calls
        .map((call, index) => (call.args ?? []).includes('scale') ? index : -1)
        .filter((index) => index >= 0)
      const lastScale = Math.max(...scaleIndexes)
      const releaseIndex = calls.findIndex((call) => (
        /falcone-knative-ownership/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
        && /released/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
      ))
      const targetIndex = calls.findIndex((call) => /falcone-knative-handoff-target/.test(submittedText(call)))
      assert.ok(releaseIndex > lastScale && targetIndex > releaseIndex, 'handoff enabled/released ownership before scaling all writers')
      const quiescenceWindow = calls.slice(lastScale + 1, releaseIndex)
      assert.ok(
        quiescenceWindow.some((call) => (call.args ?? []).includes('get') && /deployments?(?:\.apps)?/.test((call.args ?? []).join(' '))),
        'handoff never re-read deployment replica state after scale-to-zero',
      )
      assert.ok(
        quiescenceWindow.some((call) => (call.args ?? []).includes('get') && /(?:^|[,\s])pods?(?:[.,\s]|$)/.test((call.args ?? []).join(' '))),
        'handoff never proved that writer pods terminated before releasing ownership',
      )
    } finally { invocation.cleanup() }
  })

  for (const scenario of ['handoff-writer-missing-label', 'handoff-writer-live-replica']) {
    await t.test(scenario, () => {
      const invocation = invokeCli(args, scenario)
      try {
        const evidence = assertLifecycleFailure(invocation, scenario)
        const releaseCalls = invocation.kubectlCalls.filter((call) => (
          /falcone-knative-ownership/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
          && /released/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
        ))
        const targetCalls = invocation.kubectlCalls.filter((call) => /falcone-knative-handoff-target|falcone\.io\/active-owner["':=\s]+operator/.test(submittedText(call)))
        assert.deepEqual(releaseCalls, [], `${scenario} released the source owner without complete quiescence proof`)
        assert.deepEqual(targetCalls, [], `${scenario} enabled the target owner without complete quiescence proof`)
        assert.match(evidence, /writer|deployment|replica|pod|label|owner|quiesc|inventory|refus/i)
      } finally { invocation.cleanup() }
    })
  }
})

// bbx-8-066 | fn-managed-knative-projection-concurrency | OpenSpec #### Scenario: Application namespace is registered for owner-checked projection
test('namespace registration and runtime projection fence every read-modify-write with Kubernetes resourceVersion', async (t) => {
  await t.test('registration uses an optimistic-concurrency namespace mutation', () => {
    const jobs = registrationHookObjects('managed').filter(isNamespaceRegistrationJob)
    assert.equal(jobs.length, 1, 'managed registration Job is absent')
    const container = jobs[0].spec?.template?.spec?.containers?.[0]
    const contract = JSON.stringify({ command: container?.command ?? [], args: container?.args ?? [] })
    assert.match(contract, /resourceVersion/i, 'registration never captures the Namespace resourceVersion')
    const conditionalJsonPatch = /--type(?:=|\\?"?,?\s*)json/i.test(contract)
      && /(?:\\?"op\\?"\s*:\s*\\?"test|\btest\b)[\s\S]*resourceVersion/i.test(contract)
    const resourceVersionReplace = /\breplace\b/i.test(contract) && /resourceVersion/i.test(contract)
    assert.ok(conditionalJsonPatch || resourceVersionReplace, 'registration namespace mutation has no resourceVersion precondition')
    assert.doesNotMatch(contract, /\blabel\b[\s\S]*--overwrite/i, 'registration uses an unfenced label --overwrite race')
  })

  await t.test('projector preserves the observed ConfigMap resourceVersion in PUT', () => {
    const { objects } = render(managedChart)
    const execution = executeProjector(renderedProjectorScript(objects), 'serving-controller-outage')
    try {
      const runtimePath = '/api/v1/namespaces/falcone-app-a/configmaps/falcone-knative-runtime'
      const writes = execution.calls.filter((call) => call.method === 'PUT' && call.url.endsWith(runtimePath))
      assert.equal(writes.length, 1, 'same-owner projector transition did not issue one conditional replacement')
      const replacement = JSON.parse(writes[0].body)
      assert.equal(replacement.metadata?.resourceVersion, '88', 'projector discarded the resourceVersion returned by its owner-checking GET')
    } finally { execution.cleanup() }
  })
})

// bbx-8-067 | fn-managed-knative-projector-health-rbac | OpenSpec #### Scenario: The projector is read-only against the serving layer
test('projector health reads are exact namespace Roles and never cluster-scoped Deployment or Endpoint access', () => {
  const { objects } = render(managedChart, ['--set-string', 'owner=bbx-owner'])
  const serviceAccount = objects.find((object) => object.kind === 'ServiceAccount' && /status-projector/.test(object.metadata?.name ?? ''))
  assert.ok(serviceAccount, 'projector ServiceAccount is absent')

  const clusterBindings = objects.filter((object) => (
    object.kind === 'ClusterRoleBinding'
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === serviceAccount.metadata.name
      && subject.namespace === serviceAccount.metadata.namespace
    ))
  ))
  const boundClusterRoleNames = new Set(clusterBindings.map((binding) => binding.roleRef?.name))
  const boundClusterRoles = objects.filter((object) => object.kind === 'ClusterRole' && boundClusterRoleNames.has(object.metadata?.name))
  for (const role of boundClusterRoles) {
    for (const rule of role.rules ?? []) {
      const groups = rule.apiGroups ?? []
      const resources = rule.resources ?? []
      const clusterHealthRead = resources.some((resource) => (
        resource === '*'
        || resource === 'deployments'
        || resource.startsWith('deployments/')
        || resource === 'endpoints'
        || resource.startsWith('endpoints/')
        || resource === 'endpointslices'
        || resource.startsWith('endpointslices/')
      )) && (groups.includes('*') || groups.includes('') || groups.includes('apps') || groups.includes('discovery.k8s.io'))
      assert.equal(clusterHealthRead, false, `projector ClusterRole ${role.metadata.name} exposes serving health cluster-wide`)
    }
  }

  const namespaceBindings = objects.filter((object) => (
    object.kind === 'RoleBinding'
    && object.roleRef?.kind === 'Role'
    && (object.subjects ?? []).some((subject) => (
      subject.kind === 'ServiceAccount'
      && subject.name === serviceAccount.metadata.name
      && subject.namespace === serviceAccount.metadata.namespace
    ))
  ))
  const rolesForNamespace = (namespace) => {
    const names = new Set(namespaceBindings
      .filter((binding) => binding.metadata?.namespace === namespace)
      .map((binding) => binding.roleRef?.name))
    return objects.filter((object) => object.kind === 'Role' && object.metadata?.namespace === namespace && names.has(object.metadata?.name))
  }
  const assertExactGet = (namespace, apiGroup, resource, requiredNames) => {
    const matchingRules = rolesForNamespace(namespace).flatMap((role) => (role.rules ?? []).map((rule) => ({ role, rule }))).filter(({ rule }) => (
      (rule.apiGroups ?? []).includes(apiGroup) && (rule.resources ?? []).includes(resource)
    ))
    assert.ok(matchingRules.length > 0, `projector lacks namespace Role read for ${namespace} ${apiGroup || 'core'}/${resource}`)
    const exposedNames = new Set(matchingRules.flatMap(({ rule }) => rule.resourceNames ?? []))
    assert.deepEqual([...exposedNames].sort(), [...requiredNames].sort(), `${namespace} ${resource} read is not exact-name scoped`)
    for (const { role, rule } of matchingRules) {
      assert.deepEqual([...(rule.verbs ?? [])].sort(), ['get'], `${role.metadata.name} grants more than exact get for ${resource}`)
    }
  }

  assertExactGet('knative-serving', 'apps', 'deployments', ['controller', 'net-kourier-controller'])
  assertExactGet('knative-serving', '', 'endpoints', ['webhook'])
  assertExactGet('kourier-system', 'apps', 'deployments', ['3scale-kourier-gateway'])
})

// bbx-8-068 | fn-managed-knative-replacement-preconditions | OpenSpec #### Scenario: Replacement-conflict hook is tenant-safe
test('replacement-conflict deletes only the observed object using UID and resourceVersion preconditions and refuses a same-name swap', () => {
  const invocation = invokeCli([
    'acceptance', 'replacement-conflict', ...verifiedTargetArgs,
    '--namespace', 'bbx-replacement', '--resource-name', 'bbx-service',
    '--tenant-id', 'tenant-a', '--workspace-id', 'workspace-a', '--server-id', 'server-a',
  ], 'replacement-conflict-same-name-swap')
  try {
    const evidence = assertLifecycleFailure(invocation, 'same-name replacement race')
    const sourceReads = invocation.kubectlCalls.filter((call) => (
      (call.args ?? []).includes('get')
      && /services\.serving\.knative\.dev(?:\/|\s+)bbx-service\b/.test((call.args ?? []).join(' '))
      && /(?:^|\s)-n\s+bbx-replacement\b/.test((call.args ?? []).join(' '))
    ))
    assert.equal(sourceReads.length, 1, 'replacement hook did not bind itself to one observed source object')
    const deletes = invocation.kubectlCalls.filter((call) => (
      (call.args ?? []).includes('delete') && /bbx-service/.test(`${(call.args ?? []).join(' ')}\n${submittedText(call)}`)
    ))
    assert.equal(deletes.length, 1, 'replacement hook did not attempt exactly one bounded delete')
    const deleteContract = `${(deletes[0].args ?? []).join(' ')}\n${submittedText(deletes[0])}`
    assert.match(deleteContract, /00000000-0000-4000-8000-000000000068/, 'delete omitted the UID observed before the replacement race')
    assert.match(deleteContract, /(?:resourceVersion["'=:\s]+|resource-version[=\s]+)101\b/i, 'delete omitted the resourceVersion observed before the replacement race')
    assert.doesNotMatch(deleteContract, /(?:^|\s)(?:-l|--selector)(?:=|\s)|--all\b/, 'replacement hook used a collection-capable delete')
    assert.match(evidence, /conflict|uid|resource.?version|precondition|same.?name/i)
    assert.doesNotMatch(evidence, /tenant-a|workspace-a|server-a|bbx-service/i, 'replacement conflict evidence disclosed private workload identity')
    const readyProjection = appliedConfigMaps(invocation)
      .map(runtimeDocument)
      .filter((document) => document?.readiness?.state === 'ready')
    assert.deepEqual(readyProjection, [], 'replacement conflict published ready after the precondition failed')
  } finally { invocation.cleanup() }
})

// bbx-8-069 | fn-managed-knative-purge-race-fence | OpenSpec #### Scenario: Destructive purge requires a separate confirmation
test('confirmed purge fences Knative writes, re-inventories under the fence, deletes exact identities, and cleans up the fence', async (t) => {
  const args = [
    'purge', '--owner', 'bbx-owner', '--release', 'falcone-knative',
    '--backup-evidence', 'bbx-backup-8', '--confirm-purge', 'PURGE-falcone-knative-bbx-owner', '--output', 'json',
  ]

  await t.test('exact purge closes the inventory-to-delete race', () => {
    const invocation = invokeCli(args, 'purge-race-fence')
    try {
      assertSuccess(invocation.result, 'race-fenced exact purge')
      const calls = invocation.kubectlCalls
      const contract = (call) => `${(call.args ?? []).join(' ')}\n${submittedText(call)}`
      const submittedByCall = calls.map((call) => submittedObjects(call))
      const policyEntries = submittedByCall.flatMap((objects, index) => objects
        .filter((object) => object?.kind === 'ValidatingAdmissionPolicy')
        .map((object) => ({ object, index })))
      const bindingEntries = submittedByCall.flatMap((objects, index) => objects
        .filter((object) => object?.kind === 'ValidatingAdmissionPolicyBinding')
        .map((object) => ({ object, index })))
      assert.equal(policyEntries.length, 1, 'purge must install exactly one temporary ValidatingAdmissionPolicy')
      assert.equal(bindingEntries.length, 1, 'purge must install exactly one temporary ValidatingAdmissionPolicyBinding')
      const policy = policyEntries[0].object
      const binding = bindingEntries[0].object
      assert.equal(policy.apiVersion, 'admissionregistration.k8s.io/v1')
      assert.equal(binding.apiVersion, 'admissionregistration.k8s.io/v1')
      assert.equal(policy.spec?.failurePolicy, 'Fail', 'purge admission fence is not fail-closed')
      assert.equal(binding.spec?.policyName, policy.metadata?.name, 'fence Binding does not select the temporary policy')
      assert.deepEqual([...(binding.spec?.validationActions ?? [])].sort(), ['Deny'])
      assert.ok(
        (policy.spec?.validations ?? []).some((validation) => String(validation?.expression).trim() === 'false'),
        'purge fence does not unconditionally deny matched write operations',
      )

      const pinnedGroups = [
        'autoscaling.internal.knative.dev',
        'caching.internal.knative.dev',
        'networking.internal.knative.dev',
        'serving.knative.dev',
      ]
      const resourceRules = policy.spec?.matchConstraints?.resourceRules ?? []
      assert.ok(resourceRules.length > 0, 'purge fence exposes no Knative write rules')
      const coveredGroups = new Set()
      for (const rule of resourceRules) {
        // Kubernetes admits HTTP PATCH writes as AdmissionRequest operation UPDATE;
        // PATCH is therefore not a valid RuleWithOperations operation of its own.
        assert.deepEqual(
          [...(rule.operations ?? [])].sort(),
          ['CREATE', 'UPDATE'],
          'each purge fence rule must use exactly the API-valid CREATE and UPDATE admission operations',
        )
        assert.ok(!(rule.apiGroups ?? []).includes('*'), 'purge fence uses an unpinned wildcard API group')
        assert.ok((rule.resources ?? []).some((resource) => resource === '*' || resource === '*/*'), 'purge fence does not cover every resource in its pinned group')
        for (const group of rule.apiGroups ?? []) coveredGroups.add(group)
      }
      assert.deepEqual([...coveredGroups].sort(), pinnedGroups, 'purge fence does not cover exactly the four pinned Knative API groups')
      const fenceInstalled = Math.max(policyEntries[0].index, bindingEntries[0].index)

      const { objects: crdStage } = render(managedChart, [
        '--set', 'lifecycle.installStage=crds', '--set-string', 'owner=bbx-owner',
      ])
      const bundleCrdNames = crdStage
        .filter((object) => object.kind === 'CustomResourceDefinition')
        .map((object) => object.metadata?.name)
        .sort()
      assert.ok(bundleCrdNames.length > 0, 'public CRD stage exposed no purge inventory')
      const readsFor = (name) => calls
        .map((call, index) => ({ call, index }))
        .filter(({ call }) => (call.args ?? []).includes('get') && (call.args ?? []).includes(name))
        .map(({ index }) => index)
      for (const name of bundleCrdNames) {
        const reads = readsFor(name)
        assert.ok(reads.some((index) => index < fenceInstalled), `${name} was not inventoried before installing the race fence`)
      }

      const bundleDeleteEntries = calls
        .map((call, index) => ({ call, index, text: contract(call) }))
        .filter(({ call, text }) => (
          (call.args ?? []).includes('delete')
          && (
            bundleCrdNames.some((name) => text.includes(name))
            || /\/apis\/(?:serving\.knative\.dev|networking\.internal\.knative\.dev|autoscaling\.internal\.knative\.dev|caching\.internal\.knative\.dev)\//.test(text)
          )
        ))
      assert.ok(bundleDeleteEntries.length > 0, 'purge performed no exact custom-resource or CRD deletion')
      const firstBundleDelete = Math.min(...bundleDeleteEntries.map(({ index }) => index))
      for (const name of bundleCrdNames) {
        const reads = readsFor(name)
        assert.ok(
          reads.some((index) => index > fenceInstalled && index < firstBundleDelete),
          `${name} was not re-inventoried while the admission fence was active`,
        )
      }
      assert.ok(firstBundleDelete > fenceInstalled, 'purge deleted a custom resource before both fence objects existed')

      const serviceDeletes = bundleDeleteEntries.filter(({ text }) => (
        (
          /services\.serving\.knative\.dev\s+owned-service\b/.test(text)
          && /(?:^|\s)-n\s+falcone-app-a\b/.test(text)
        )
        || /\/apis\/serving\.knative\.dev\/[^/]+\/namespaces\/falcone-app-a\/services\/owned-service\b/.test(text)
      ))
      assert.equal(serviceDeletes.length, 1, 'purge did not delete the re-inventoried Knative Service by exact namespace/name identity')
      assert.match(serviceDeletes[0].text, /00000000-0000-4000-8000-000000000069/, 'exact Service delete omitted the re-inventoried UID')
      assert.match(serviceDeletes[0].text, /["']resourceVersion["']\s*:\s*["']169["']/, 'exact Service delete omitted the re-inventoried resourceVersion')
      for (const { text } of bundleDeleteEntries) {
        assert.doesNotMatch(text, /(?:^|\s)(?:-l|--selector)(?:=|\s)|--all\b|deletecollection/i, 'race-fenced purge used a selector or collection deletion')
      }
      const crdDeleteText = bundleDeleteEntries
        .filter(({ text }) => /customresourcedefinitions?\.apiextensions\.k8s\.io/.test(text))
        .map(({ text }) => text)
        .join('\n')
      assert.deepEqual(
        bundleCrdNames.filter((name) => crdDeleteText.includes(name)).sort(),
        bundleCrdNames,
        'race-fenced purge did not delete every exact pinned bundle CRD name',
      )

      const lastBundleDelete = Math.max(...bundleDeleteEntries.map(({ index }) => index))
      const cleanupEntries = calls
        .map((call, index) => ({ call, index, text: contract(call) }))
        .filter(({ call, text }) => (
          (call.args ?? []).includes('delete')
          && (text.includes(policy.metadata?.name) || text.includes(binding.metadata?.name))
        ))
      assert.ok(cleanupEntries.some(({ text }) => text.includes(policy.metadata?.name)), 'purge left its ValidatingAdmissionPolicy installed')
      assert.ok(cleanupEntries.some(({ text }) => text.includes(binding.metadata?.name)), 'purge left its ValidatingAdmissionPolicyBinding installed')
      for (const { index, text } of cleanupEntries) {
        assert.ok(index > lastBundleDelete, 'purge removed its admission fence before destructive work completed')
        assert.doesNotMatch(text, /(?:^|\s)(?:-l|--selector)(?:=|\s)|--all\b|deletecollection/i, 'purge cleaned its fence with a selector or collection deletion')
      }
    } finally { invocation.cleanup() }
  })

  for (const [scenario, expected] of [
    ['purge-foreign-cr', /foreign|different.*owner|ownership/i],
    ['purge-unowned-bundle-cr', /unowned|missing.*owner|ownership/i],
    ['purge-extra-owner-crd', /non.?bundle|unexpected|inventory|widgets|refus/i],
  ]) {
    await t.test(`${scenario} remains pre-mutation`, () => {
      const invocation = invokeCli(args, scenario, { env: { FALCONE_BBX_REJECT_MUTATION: '1' } })
      try {
        const evidence = assertLifecycleFailure(invocation, scenario)
        assert.equal(mutationCalls(invocation).length, 0, `${scenario} installed a purge fence or reached destructive work before initial isolation proof`)
        assert.match(evidence, expected)
      } finally { invocation.cleanup() }
    })
  }
})

// bbx-8-070 | fn-managed-knative-release-package-gate | OpenSpec #### Scenario: Provenance lock is complete and reproducible
test('chart-release gate identifies top-level packaged charts and accepts the managed provenance/checksum inventory', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-chart-release-gate-bbx-'))
  try {
    for (const chart of [umbrellaChart, managedChart]) {
      const packaged = run('helm', ['package', chart, '--destination', directory])
      assertSuccess(packaged, `helm package ${basename(chart)}`)
    }
    const archives = readdirSync(directory).filter((name) => name.endsWith('.tgz')).sort()
    const umbrellaArchives = archives.filter((name) => /^in-falcone-.+\.tgz$/.test(name))
    const managedArchives = archives.filter((name) => /^falcone-knative-.+\.tgz$/.test(name))
    assert.equal(umbrellaArchives.length, 1, 'release gate requires exactly one umbrella package')
    assert.equal(managedArchives.length, 1, 'release gate requires exactly one managed Knative package')
    const umbrellaArchive = resolve(directory, umbrellaArchives[0])
    const managedArchive = resolve(directory, managedArchives[0])

    const showChart = (chart, context) => {
      const shown = run('helm', ['show', 'chart', chart])
      assertSuccess(shown, `helm show chart ${context}`)
      const documents = yamlDocuments(shown.stdout)
      assert.equal(documents.length, 1, `${context} chart metadata is not one YAML document`)
      return { metadata: documents[0], text: shown.stdout }
    }
    const sourceUmbrella = showChart(umbrellaChart, 'source umbrella')
    const sourceManaged = showChart(managedChart, 'source managed')
    const packagedUmbrella = showChart(umbrellaArchive, 'packaged umbrella')
    const packagedManaged = showChart(managedArchive, 'packaged managed')
    assert.deepEqual(
      { name: packagedUmbrella.metadata.name, version: packagedUmbrella.metadata.version },
      { name: sourceUmbrella.metadata.name, version: sourceUmbrella.metadata.version },
      'packaged umbrella top-level identity drifted from its source chart',
    )
    assert.deepEqual(
      { name: packagedManaged.metadata.name, version: packagedManaged.metadata.version },
      { name: sourceManaged.metadata.name, version: sourceManaged.metadata.version },
      'packaged managed top-level identity drifted from its source chart',
    )

    const inventory = run('tar', ['-tzf', managedArchive])
    assertSuccess(inventory, 'list packaged managed chart inventory')
    const inventoryPaths = inventory.stdout.split('\n').filter(Boolean)
    const requiredPaths = [
      'falcone-knative/provenance/provenance-lock.json',
      'falcone-knative/provenance/image-lock.json',
      'falcone-knative/provenance/sbom.cdx.json',
      'falcone-knative/provenance/license-inventory.json',
      'falcone-knative/provenance/licenses/knative-serving-LICENSE',
      'falcone-knative/provenance/licenses/net-kourier-LICENSE',
    ]
    for (const path of requiredPaths) {
      assert.ok(inventoryPaths.includes(path), `managed chart package omitted ${path}`)
    }
    const provenanceLock = run('tar', [
      '-xOzf', managedArchive, 'falcone-knative/provenance/provenance-lock.json',
    ])
    assertSuccess(provenanceLock, 'read packaged provenance lock JSON')
    assert.doesNotThrow(() => JSON.parse(provenanceLock.stdout), 'packaged provenance lock is not valid JSON')

    for (const [label, pattern, insensitive = false] of [
      ['provenance', '/provenance[^/]*\\.(json|ya?ml)$'],
      ['image lock', '/image[^/]*lock[^/]*\\.(json|ya?ml)$'],
      ['SBOM', '/sbom[^/]*\\.(json|spdx|cdx)', true],
      ['licenses', '/(licenses?|license-inventory)(/|[^/]*)', true],
    ]) {
      const args = [insensitive ? '-Eqi' : '-Eq', pattern]
      const gate = run('grep', args, { input: inventory.stdout })
      assertSuccess(gate, `chart-release ${label} inventory gate`)
    }

    const sums = [umbrellaArchive, managedArchive]
      .map((archive) => `${sha256(readFileSync(archive))}  ${basename(archive)}`)
      .join('\n') + '\n'
    const checksumGate = run('sha256sum', ['--check'], { cwd: directory, input: sums })
    assertSuccess(checksumGate, 'chart-release packaged archive checksum verification')
    assert.match(checksumGate.stdout, /in-falcone-.+\.tgz:\s+OK/i)
    assert.match(checksumGate.stdout, /falcone-knative-.+\.tgz:\s+OK/i)

    const workflowText = readFileSync(resolve(repoRoot, '.github/workflows/chart-release.yml'), 'utf8')
    const gateStart = workflowText.indexOf('- name: Package and verify chart provenance inputs')
    assert.ok(gateStart >= 0, 'chart-release workflow lacks its package/provenance input gate')
    const gateEndCandidate = workflowText.indexOf('\n      - ', gateStart + 1)
    const gateText = workflowText.slice(gateStart, gateEndCandidate >= 0 ? gateEndCandidate : undefined)
    const awkPrograms = [...gateText.matchAll(/\bawk\s+'([^']+)'/g)].map((match) => match[1])
    const uniqueNamePrograms = [...new Set(awkPrograms.filter((program) => /\^name:/.test(program)))]
    const uniqueVersionPrograms = [...new Set(awkPrograms.filter((program) => /\^version:/.test(program)))]
    assert.deepEqual(uniqueNamePrograms.length, 1, 'chart-release gate must use one consistent top-level name extractor')
    assert.deepEqual(uniqueVersionPrograms.length, 1, 'chart-release gate must use one consistent top-level version extractor')
    const workflowPrograms = { name: uniqueNamePrograms[0], version: uniqueVersionPrograms[0] }
    assert.match(workflowPrograms.name, /\$0\s*~\s*\/\^name:\//, 'chart-release name extraction is not anchored at YAML column zero')
    assert.match(workflowPrograms.version, /\$0\s*~\s*\/\^version:\//, 'chart-release version extraction is not anchored at YAML column zero')

    const workflowField = (chartText, field) => {
      const extracted = run('awk', [workflowPrograms[field]], { input: chartText })
      assertSuccess(extracted, `chart-release awk ${field} extraction`)
      return extracted.stdout.trim()
    }
    const workflowObserved = {
      umbrellaName: workflowField(packagedUmbrella.text, 'name'),
      umbrellaVersion: workflowField(packagedUmbrella.text, 'version'),
      managedName: workflowField(packagedManaged.text, 'name'),
      managedVersion: workflowField(packagedManaged.text, 'version'),
    }
    const requiredTopLevelIdentity = {
      umbrellaName: sourceUmbrella.metadata.name,
      umbrellaVersion: sourceUmbrella.metadata.version,
      managedName: sourceManaged.metadata.name,
      managedVersion: sourceManaged.metadata.version,
    }
    assert.deepEqual(
      workflowObserved,
      requiredTopLevelIdentity,
      'chart-release awk gate selected dependency metadata instead of the packaged chart top-level identity',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// bbx-8-071 | fn-managed-knative-release-artifact-visibility | OpenSpec #### Scenario: Provenance lock is complete and reproducible
test('chart-release uploads every validated package from one artifact-visible staging directory', () => {
  const workflow = readYaml(resolve(repoRoot, '.github/workflows/chart-release.yml'))
  const validateSteps = workflow.jobs?.validate?.steps ?? []
  const packageSteps = validateSteps.filter((step) => step?.name === 'Package and verify chart provenance inputs')
  assert.equal(packageSteps.length, 1, 'validate must expose exactly one public package/provenance gate')

  const packageRun = String(packageSteps[0].run ?? '')
  const assignment = packageRun.match(/(?:^|\n)\s*package_dir=(?:"([^"]+)"|'([^']+)'|(\S+))/)
  assert.ok(assignment, 'validate package gate does not declare its artifact staging directory')
  const assignedDirectory = assignment[1] ?? assignment[2] ?? assignment[3]
  const stagingDirectory = assignedDirectory
    .replace(/^\$(?:\{GITHUB_WORKSPACE\}|GITHUB_WORKSPACE)\//, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
  assert.ok(stagingDirectory && !stagingDirectory.includes('$'), 'package staging directory must resolve beneath GITHUB_WORKSPACE')

  const helmPackageLines = packageRun.split('\n').filter((line) => /^\s*helm\s+package\s+/.test(line))
  assert.equal(helmPackageLines.length, 2, 'validate must package exactly the umbrella and managed Knative charts')
  for (const line of helmPackageLines) {
    assert.match(line, /--destination\s+["']?\$package_dir["']?(?:\s|$)/, 'validated chart package is written outside package_dir')
  }
  assert.match(packageRun, /(?:^|\n)\s*cd\s+["']?\$package_dir["']?\s*(?:\n|$)/, 'checksum inventory is written outside package_dir')

  const expectedUploads = new Map([
    ['in-falcone-chart', 'in-falcone-*.tgz'],
    ['falcone-knative-chart', 'falcone-knative-*.tgz'],
    ['falcone-chart-checksums', 'SHA256SUMS'],
  ])
  const uploadSteps = validateSteps.filter((step) => step?.uses === 'actions/upload-artifact@v4')
  assert.equal(uploadSteps.length, expectedUploads.size, 'validate must upload both chart archives and their checksum inventory')
  assert.deepEqual(
    uploadSteps.map((step) => step.with?.name).sort(),
    [...expectedUploads.keys()].sort(),
    'validate artifact names do not identify the two charts and checksum inventory exactly',
  )

  for (const step of uploadSteps) {
    const artifactName = step.with?.name
    const uploadPath = String(step.with?.path ?? '')
    assert.ok(uploadPath && !uploadPath.includes('\n'), `${artifactName} must expose exactly one upload path`)
    const pathParts = uploadPath.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean)
    const uploadLeaf = pathParts.pop()
    const uploadDirectory = pathParts.join('/')
    assert.equal(uploadDirectory, stagingDirectory, `${artifactName} upload path is inconsistent with package_dir`)
    assert.equal(uploadLeaf, expectedUploads.get(artifactName), `${artifactName} uploads the wrong validated release file`)

    const hiddenComponents = pathParts.filter((part) => part.startsWith('.') && part !== '.' && part !== '..')
    const includesHiddenFiles = String(step.with?.['include-hidden-files'] ?? 'false').toLowerCase() === 'true'
    assert.ok(
      hiddenComponents.length === 0 || includesHiddenFiles,
      `${artifactName} upload path ${uploadPath} contains hidden component ${hiddenComponents.join('/')} but actions/upload-artifact@v4 excludes hidden files unless include-hidden-files is true`,
    )
  }
})
