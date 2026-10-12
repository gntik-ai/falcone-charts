import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const chart = 'charts/in-falcone';
const envName = 'FLOW_EXECUTION_TOKEN_SECRET';
const upgradeArgs = [
  '--is-upgrade', '--set', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set-string', 'global.webhookDatabase.migration.backupReference=bbx-flow-token-backup',
];

function render(args = [], chartPath = chart) {
  return spawnSync('helm', ['template', 'flows-bbx', chartPath,
    '--namespace', 'flows-bbx', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function documents(result) {
  assert.equal(result.status, 0, result.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'falcone-flow-token-render-'));
  try {
    const file = join(directory, 'render.yaml');
    writeFileSync(file, result.stdout);
    const parsed = spawnSync('python3', ['-c',
      'import json,sys,yaml; json.dump(list(yaml.load_all(open(sys.argv[1]), Loader=yaml.CSafeLoader)),sys.stdout,default=str)', file,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(parsed.status, 0, parsed.stderr);
    return JSON.parse(parsed.stdout).filter(Boolean);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyDelivery(objects, secretName = 'in-falcone-flow-execution-token',
  remoteKey = 'flows/execution-token-secret') {
  const externals = objects.filter((object) => object.kind === 'ExternalSecret'
    && object.metadata.name === 'flows-execution-token');
  assert.equal(externals.length, 1, 'the canonical ESO set must deliver the flow signing key');
  const external = externals[0];
  assert.deepEqual(external.spec.secretStoreRef,
    { name: 'openbao-backend', kind: 'ClusterSecretStore' });
  assert.equal(external.spec.target.name, secretName);
  assert.equal(external.spec.target.creationPolicy, 'Orphan');
  assert.equal(external.spec.target.deletionPolicy, 'Retain');
  assert.deepEqual(external.spec.data, [{
    secretKey: envName, remoteRef: { key: remoteKey, property: 'secret' },
  }]);
  const recipients = [];
  for (const object of objects) {
    const pod = object.kind === 'CronJob' ? object.spec?.jobTemplate?.spec?.template?.spec
      : object.spec?.template?.spec;
    if (!pod) continue;
    for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
      const bindings = (container.env ?? []).filter((entry) => entry.name === envName);
      if (object.kind === 'Deployment'
        && ['control-plane-executor', 'workflow-worker'].includes(container.name)) {
        recipients.push(container.name);
        assert.deepEqual(bindings, [{ name: envName, valueFrom: {
          secretKeyRef: { name: secretName, key: envName, optional: true },
        } }], 'both workloads must share the ESO reference and permit managed post hooks');
      } else {
        assert.deepEqual(bindings, [], `${object.metadata.name}/${container.name} must not receive the key`);
      }
    }
  }
  assert.deepEqual(recipients.sort(), ['control-plane-executor', 'workflow-worker']);
  assert.ok(!objects.some((object) => object.kind === 'Secret'
    && object.metadata.name === secretName), 'Helm must never generate signing material');
  for (const object of objects.filter((item) => item.kind === 'ConfigMap')) {
    assert.ok(!Object.hasOwn(object.data ?? {}, envName), 'no literal signing key in ConfigMaps');
  }
}

test('the flow ACL passes ConfigMap secret checks without scanner exceptions', (t) => {
  const version = spawnSync('trivy', ['--version'], { encoding: 'utf8' });
  if (version.error?.code === 'ENOENT') {
    t.skip('Trivy is not installed; PR security scanning must verify the policy');
    return;
  }
  assert.equal(version.status, 0, version.stderr);
  const policy = documents(render()).find((o) => o.kind === 'ConfigMap'
    && o.metadata.name === 'openbao-policy-flow-execution-token');
  const directory = mkdtempSync(join(tmpdir(), 'falcone-flow-policy-scan-'));
  try {
    const file = join(directory, 'policy.yaml');
    writeFileSync(file, JSON.stringify(policy));
    const scan = spawnSync('trivy', ['config', '--skip-check-update', '--format', 'json', file],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(scan.status, 0, scan.stderr);
    const results = JSON.parse(scan.stdout).Results;
    assert.ok(results?.length, 'Trivy must actually scan the rendered ConfigMap');
    const failures = results.flatMap((result) => result.Misconfigurations ?? [])
      .filter((finding) => /(?:^|-)KSV-0109$/.test(finding.ID));
    assert.deepEqual(failures, [], 'the policy must pass the ConfigMap secret check');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('executor and worker share one OpenBao/ESO flow execution Secret on install and legacy upgrades', () => {
  const defaults = documents(render());
  verifyDelivery(defaults);
  assert.equal(defaults.find((o) => o.kind === 'ExternalSecret'
    && o.metadata.name === 'flows-execution-token').metadata.annotations['helm.sh/hook'],
  'post-install,post-upgrade');
  verifyDelivery(documents(render([
    '--set', 'global.flowExecutionToken.secretName=custom-flow-token',
    '--set', 'global.flowExecutionToken.remoteKey=flows/execution-token-secret/rotation',
  ])), 'custom-flow-token', 'flows/execution-token-secret/rotation');
  const adopted = documents(render([
    '--set', 'eso.external-secrets.enabled=false',
    '--set', 'global.externalSecrets.operatorNamespace=external-eso',
    '--set', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ]));
  verifyDelivery(adopted);
  assert.equal(adopted.find((o) => o.kind === 'ExternalSecret'
    && o.metadata.name === 'flows-execution-token').metadata.annotations?.['helm.sh/hook'], undefined);
  const directory = mkdtempSync(join(tmpdir(), 'falcone-flow-token-legacy-'));
  try {
    const legacyChart = join(directory, 'chart');
    cpSync(chart, legacyChart, { recursive: true });
    const valuesFile = join(legacyChart, 'values.yaml');
    const values = documents({ status: 0, stdout: readFileSync(valuesFile, 'utf8') })[0];
    delete values.global.flowExecutionToken;
    writeFileSync(valuesFile, JSON.stringify(values));
    verifyDelivery(documents(render(upgradeArgs, legacyChart)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only the ESO role gains read access to the isolated execution-token OpenBao record', () => {
  for (const [args, remoteKey] of [
    [[], 'flows/execution-token-secret'],
    [['--set', 'global.flowExecutionToken.remoteKey=flows/execution-token-secret/rotation'],
      'flows/execution-token-secret/rotation'],
  ]) {
    const objects = documents(render(args));
    const policy = objects.find((o) => o.kind === 'ConfigMap'
      && o.metadata.name === 'openbao-policy-flow-execution-token');
    assert.ok(policy, 'the ESO integration needs an OpenBao policy for its record');
    assert.equal(policy.data['policy.hcl'].trim(),
      `path "secret/data/${remoteKey}" {\n  capabilities = ["read"]\n}`);
    const bootstrap = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-init');
    const pod = bootstrap.spec.template.spec;
    const policySource = pod.volumes.find((v) => v.name === 'policies').projected.sources
      .find((s) => s.configMap?.name === policy.metadata.name);
    assert.deepEqual(policySource?.configMap.items,
      [{ key: 'policy.hcl', path: 'flow-execution-token.hcl' }],
      'install bootstrap must mount the ACL at the existing policy filename');
    const container = pod.containers.find((c) => c.name === 'openbao-init');
    const script = [...container.command, ...(container.args ?? [])].join('\n');
    assert.match(script, /for policy in[^\n]* flow-execution-token; do/);
    assert.match(script, /role\/eso-role[^\n]*\\\n[\s\S]*?policies=platform,functions,gateway,iam,function-invocation,flow-execution-token/);
    assert.doesNotMatch(script, /role\/platform-role[^\n]*\\\n[\s\S]*?policies=[^\n]*flow-execution-token[\s\S]*?role\/gateway-role/);
    const reconcile = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-auth-reconcile');
    const reconciler = reconcile.spec.template.spec.containers[0];
    assert.match([...reconciler.command, ...(reconciler.args ?? [])].join('\n'),
      /desired_policies="flow-execution-token,function-invocation,functions,gateway,iam,platform"/);
  }
  const upgraded = documents(render(upgradeArgs));
  const publisher = upgraded.find((o) => o.kind === 'Job'
    && o.metadata.name === 'openbao-function-invocation-seed');
  const pod = publisher.spec.template.spec;
  const upgradeSource = pod.volumes.find((v) => v.configMap?.name === 'openbao-policy-flow-execution-token');
  assert.deepEqual(upgradeSource?.configMap.items,
    [{ key: 'policy.hcl', path: 'flow-execution-token.hcl' }],
    'upgrade bootstrap must mount the ACL at the existing policy filename');
  assert.match(pod.containers.find((c) => c.name === 'function-invocation-seed').args.join('\n'),
    /bao policy write flow-execution-token \/flow-token-policy\/flow-execution-token.hcl/);
});

test('release readiness fails closed until the flow ExternalSecret is Ready without reading Secret values', () => {
  for (const args of [[], upgradeArgs, [
    '--set', 'eso.external-secrets.enabled=false',
    '--set', 'global.externalSecrets.operatorNamespace=external-eso',
    '--set', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ]]) {
    const objects = documents(render(args));
    const job = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'flows-execution-token-ready');
    assert.ok(job, 'flow secret synchronization must be a mandatory release gate');
    assert.equal(job.metadata.annotations['helm.sh/hook'], 'post-install,post-upgrade');
    assert.ok(Number(job.metadata.annotations['helm.sh/hook-weight']) > 5);
    const pod = job.spec.template.spec;
    const role = objects.find((o) => o.kind === 'Role' && o.metadata.name === pod.serviceAccountName);
    assert.deepEqual(role.rules, [{ apiGroups: ['external-secrets.io'],
      resources: ['externalsecrets'], resourceNames: ['flows-execution-token'],
      verbs: ['get', 'list', 'watch'] }]);
    const directory = mkdtempSync(join(tmpdir(), 'falcone-flow-token-ready-'));
    try {
      // Kubernetes CLI is the system boundary. The gate executes unchanged.
      const fake = join(directory, 'kubectl');
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" > "$FLOW_TEST_LOG"\nexit "$FLOW_TEST_STATUS"\n');
      chmodSync(fake, 0o755);
      const log = join(directory, 'calls');
      const command = pod.containers[0].command;
      for (const status of ['1', '0']) {
        const result = spawnSync(command[0], command.slice(1), { encoding: 'utf8',
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}`,
            FLOW_TEST_STATUS: status, FLOW_TEST_LOG: log } });
        assert.equal(result.status, Number(status), 'unready ESO must stop the release');
        const call = readFileSync(log, 'utf8');
        assert.match(call, /-n flows-bbx wait --for=condition=Ready externalsecret\.external-secrets\.io\/flows-execution-token/);
        assert.doesNotMatch(call, /(?:^|\s)secrets?(?:\s|\/)/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('literal keys, conflicting env entries and malformed references cannot bypass ESO', () => {
  const settings = [
    ['global.flowExecutionToken.secretName=', /flowExecutionToken.secretName/],
    ['global.flowExecutionToken.secretName=flow..token', /flowExecutionToken.secretName/],
    ['global.flowExecutionToken.remoteKey=', /flowExecutionToken.remoteKey/],
    ['global.flowExecutionToken.remoteKey=iam/keycloak', /flowExecutionToken.remoteKey/],
    ['global.flowExecutionToken.secret=forbidden', /references only/],
    ['controlPlaneExecutor.env[0].name=FLOW_EXECUTION_TOKEN_SECRET', /reserved FLOW_EXECUTION_TOKEN_SECRET/],
    ['workflowWorker.env[0].name=FLOW_EXECUTION_TOKEN_SECRET', /reserved FLOW_EXECUTION_TOKEN_SECRET/],
    ['workflowWorker.config.inline.FLOW_EXECUTION_TOKEN_SECRET=forbidden', /reserved FLOW_EXECUTION_TOKEN_SECRET/],
    ['global.transportSecurity.env[0].name=FLOW_EXECUTION_TOKEN_SECRET', /reserved FLOW_EXECUTION_TOKEN_SECRET/],
  ];
  for (const [setting, message] of settings) {
    const result = render(['--skip-schema-validation', '--set-string', setting]);
    assert.notEqual(result.status, 0, `${setting} must fail before rendering`);
    assert.match(result.stderr, message);
  }
  for (const value of ['false', '0', '""', '[]']) {
    const result = render(['--skip-schema-validation', '--set-json', `global.flowExecutionToken=${value}`]);
    assert.notEqual(result.status, 0, `${value} must not silently use reference defaults`);
    assert.match(result.stderr, /flowExecutionToken/);
  }
});
