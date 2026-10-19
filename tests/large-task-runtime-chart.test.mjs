import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readYaml, sha256, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs'

const probe = `registry.example/busybox@sha256:${'a'.repeat(64)}`
const enabled = ['--set', 'largeTasks.enabled=true', '--set-string', `largeTasks.isolationProbe.image=${probe}`,
  '--set', 'largeTasks.nodes[0]=node-a']
const namespace = 'falcone-bbx-large-tasks'
function render(args = [], chart = umbrellaChart) {
  const result = spawnSync('helm', ['template', 'falcone-bbx', chart, '--namespace', 'falcone-bbx', ...args],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  assert.equal(result.status, 0, result.stderr)
  return yamlDocuments(result.stdout)
}
const find = (objects, kind, name) => objects.find(o => o.kind === kind && o.metadata.name === name)
const worker = objects => find(objects, 'Deployment', 'falcone-bbx-workflow-worker')

test('staging smoke profiles are prepared behind the gate with operator images and nodes supplied at release', () => {
  const stagingPath = `${umbrellaChart}/values/staging-cluster.yaml`
  assert.equal(readYaml(stagingPath).largeTasks?.enabled, false)
  const objects = render(['-f', stagingPath, ...enabled,
    '--set-json', `largeTasks.approvedImages=${JSON.stringify([{ ref: probe, allowedEnv: [] }])}`,
    ...['smoke-echo', 'smoke-sleep', 'smoke-net'].flatMap(name => ['--set-string', `largeTasks.profiles.${name}.image=${probe}`])])
  const config = JSON.parse(find(objects, 'ConfigMap', 'falcone-bbx-large-task-config').data.LARGE_TASK_CONFIG)
  assert.deepEqual(Object.keys(config.profiles).sort(), ['smoke-echo', 'smoke-net', 'smoke-sleep'])
  assert.deepEqual(config.profiles['smoke-echo'].args, ['sh', '-c', 'cat /task/params.json > /dev/termination-log'])
  assert.deepEqual(config.profiles['smoke-sleep'].args, ['sleep', '3600'])
  assert.equal(config.profiles['smoke-sleep'].maxDurationSeconds, 30)
  const net = config.profiles['smoke-net']
  assert.deepEqual(net.egress, { dnsNamespaces: ['kube-system'], allowedNamespaces: [] })
  assert.match(net.args[2], /nc -w 3 kube-dns\.kube-system\.svc\.cluster\.local 53/)
  assert.match(net.args[2], /nc -w 3 falcone-bbx-postgresql\.falcone-bbx\.svc\.cluster\.local 5432/)
  assert.match(net.args[2], /dns.*pg/)
  for (const profile of Object.values(config.profiles)) {
    assert.equal(profile.runAsUser, 65532)
    assert.equal(profile.runAsGroup, 65532)
    assert.equal(profile.codeExecution, 'disabled')
    assert.equal(profile.image, probe)
    assert.deepEqual(profile.env, [])
  }
})

test('disabled largeTasks preserve objects when stored values lack the new block', () => {
  const directory = mkdtempSync(join(tmpdir(), 'falcone-large-tasks-stored-values-'))
  const chart = join(directory, 'in-falcone')
  try {
    cpSync(umbrellaChart, chart, { recursive: true })
    const values = readYaml(`${chart}/values.yaml`)
    delete values.largeTasks
    writeFileSync(`${chart}/values.yaml`, JSON.stringify(values))

    for (const settings of [[], ['--set', 'global.knativeRuntime.mode=managed'],
      ['--set', 'workflowWorker.replicaCount=2']]) {
      const withoutBlock = render(settings, chart)
      assert.equal(find(withoutBlock, 'Namespace', namespace), undefined)
      assert.equal(find(withoutBlock, 'ConfigMap', 'falcone-bbx-large-task-config'), undefined)
      assert.equal(withoutBlock.some(o => o.metadata.namespace === namespace), false)
      const pod = worker(withoutBlock).spec.template
      assert.equal(pod.spec.automountServiceAccountToken, false)
      assert.equal(pod.metadata.annotations?.['in-falcone.io/large-task-config-sha256'], undefined)
      assert.equal(pod.spec.containers[0].env.some(e => e.name === 'LARGE_TASK_CONFIG'), false)

      for (const disabled of [[], ['--set', 'largeTasks.enabled=false'], ['--set', 'largeTasks=null']]) {
        assert.deepEqual(render([...settings, ...disabled]), withoutBlock)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('largeTasks schema rejects unknown settings, duplicate nodes and invalid runtime limits', () => {
  for (const setting of ['largeTasks.unknown=true', 'largeTasks.nodes={node-a,node-a}',
    'largeTasks.claimRetentionSeconds=86400', 'largeTasks.isolationProbe.runAsUser=0']) {
    const result = spawnSync('helm', ['template', 'falcone-bbx', umbrellaChart, '--set', setting], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, `${setting} must fail schema validation`)
    assert.match(result.stderr, /largeTasks/)
  }
})

test('enabled large tasks fail clearly without a probe image or eligible nodes', () => {
  for (const [args, message] of [
    [['--set', 'largeTasks.enabled=true'], /largeTasks\.isolationProbe\.image.*required/],
    [['--set', 'largeTasks.enabled=true', '--set-string', `largeTasks.isolationProbe.image=${probe}`], /largeTasks\.nodes.*required/],
  ]) {
    const result = spawnSync('helm', ['template', 'falcone-bbx', umbrellaChart, ...args], { encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'unsafe configuration must not render')
    assert.match(result.stderr, message)
  }
})

test('worker receives template-owned config and token only when enabled, including with Knative', () => {
  const objects = render([...enabled, '--set', 'global.knativeRuntime.mode=managed'])
  const configMap = find(objects, 'ConfigMap', 'falcone-bbx-large-task-config')
  assert.ok(configMap, 'runtime config must exist')
  const config = JSON.parse(configMap.data.LARGE_TASK_CONFIG)
  assert.deepEqual(config, { namespace, platformNamespace: 'falcone-bbx', openshiftRestricted: false,
    finishedTtlSeconds: 3600, claimRetentionSeconds: 604800, isolationRecheckSeconds: 86400,
    isolationProbeImage: probe, isolationProbeRunAsUser: 65532, nodes: ['node-a'],
    approvedImages: [], approvedSandboxRuntimeClasses: [], profiles: {} })
  const pod = worker(objects).spec.template
  assert.equal(pod.spec.automountServiceAccountToken, true)
  assert.equal(pod.metadata.annotations['in-falcone.io/large-task-config-sha256'], sha256(configMap.data.LARGE_TASK_CONFIG))
  assert.deepEqual(pod.spec.containers[0].env.find(e => e.name === 'LARGE_TASK_CONFIG'), {
    name: 'LARGE_TASK_CONFIG', valueFrom: { configMapKeyRef: { name: configMap.metadata.name, key: 'LARGE_TASK_CONFIG' } },
  })
  for (const name of ['control-plane', 'control-plane-executor']) {
    assert.equal(find(objects, 'Deployment', `falcone-bbx-${name}`).spec.template.spec.automountServiceAccountToken, false)
  }
  const changed = render([...enabled, '--set', 'largeTasks.finishedTtlSeconds=7200',
    '--set-string', 'workflowWorker.serviceAccount.name=custom-worker'])
  const changedConfig = find(changed, 'ConfigMap', configMap.metadata.name)
  assert.equal(JSON.parse(changedConfig.data.LARGE_TASK_CONFIG).finishedTtlSeconds, 7200)
  assert.notEqual(worker(changed).spec.template.metadata.annotations['in-falcone.io/large-task-config-sha256'],
    pod.metadata.annotations['in-falcone.io/large-task-config-sha256'])
  assert.equal(find(changed, 'RoleBinding', 'large-task-runtime').subjects[0].name, 'custom-worker')
  assert.equal(worker(render()).spec.template.spec.automountServiceAccountToken, false)
})

test('enabled large tasks have restricted namespace, default deny, quota and exact namespaced permissions', () => {
  const objects = render(enabled)
  const ns = find(objects, 'Namespace', namespace)
  assert.ok(ns, 'large-task namespace must exist')
  assert.equal(ns.metadata.labels['pod-security.kubernetes.io/enforce'], 'restricted')
  const resources = objects.filter(o => o.metadata.namespace === namespace)
  assert.deepEqual(resources.map(o => o.kind).sort(), ['NetworkPolicy', 'ResourceQuota', 'Role', 'RoleBinding'])
  assert.deepEqual(find(resources, 'NetworkPolicy', 'default-deny').spec,
    { podSelector: {}, policyTypes: ['Ingress', 'Egress'], ingress: [], egress: [] })
  assert.deepEqual(find(resources, 'ResourceQuota', 'large-tasks').spec.hard,
    { 'count/jobs.batch': '32', 'requests.cpu': '8', 'limits.cpu': '8', 'requests.memory': '16Gi',
      'limits.memory': '16Gi', 'requests.ephemeral-storage': '40Gi', 'limits.ephemeral-storage': '40Gi' })
  assert.deepEqual(find(resources, 'Role', 'large-task-runtime').rules, [
    { apiGroups: ['batch'], resources: ['jobs'], verbs: ['create', 'get', 'list', 'patch', 'delete'] },
    { apiGroups: [''], resources: ['configmaps'], verbs: ['create', 'get', 'list', 'patch', 'delete'] },
    { apiGroups: ['networking.k8s.io'], resources: ['networkpolicies'], verbs: ['create', 'get'] },
    { apiGroups: [''], resources: ['pods'], verbs: ['get', 'list'] },
    { apiGroups: [''], resources: ['pods/log'], verbs: ['get'] },
    { apiGroups: [''], resources: ['events'], verbs: ['list'] },
  ])
  const binding = find(resources, 'RoleBinding', 'large-task-runtime')
  assert.deepEqual(binding.roleRef, { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'large-task-runtime' })
  assert.deepEqual(binding.subjects, [{ kind: 'ServiceAccount', name: 'falcone-bbx-workflow-worker', namespace: 'falcone-bbx' }])
  assert.deepEqual(objects.filter(o => ['ClusterRole', 'ClusterRoleBinding'].includes(o.kind)),
    render().filter(o => ['ClusterRole', 'ClusterRoleBinding'].includes(o.kind)))
})
