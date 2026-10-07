import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertSuccess, render, run, umbrellaChart, yamlDocuments } from './blackbox/fixtures/blackbox.mjs';

const fixture = yamlDocuments(readFileSync(resolve(import.meta.dirname,
  'blackbox/fixtures/function-ksvc.yaml'), 'utf8'));
const bindings = {
  FN_INVOCATION_PRIVATE_KEY: 'private-key',
  FN_INVOCATION_KEY_ID: 'key-id',
  FN_INVOCATION_JWKS: 'jwks',
};
const signerNames = ['control-plane'];
const signerVolume = 'falcone-function-invocation';
const signerDirectory = '/var/run/falcone/function-invocation';

function verifySignerPolicies(objects, remoteKey) {
  const policies = new Map(objects.filter((o) => o.kind === 'ConfigMap')
    .flatMap((o) => Object.entries(o.data ?? {})
      .filter(([key]) => key.endsWith('.hcl'))
      .map(([key, value]) => [key.slice(0, -4), value])));
  assert.equal(policies.get('function-invocation').trim(),
    `path "secret/data/${remoteKey}" {\n  capabilities = ["read"]\n}`);
  const identities = objects.find((o) => o.kind === 'ConfigMap'
    && o.data?.['platform-service-account-names']).data;
  const install = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-init');
  const script = install.spec.template.spec.containers.find((c) => c.name === 'openbao-init')
    .args[0].replaceAll('\\\n', ' ');
  const roles = [...script.matchAll(/bao write auth\/kubernetes\/role\/([\w-]+)([\s\S]*?)>\/dev\/null/g)]
    .map(([, name, body]) => {
      const names = body.match(/bound_service_account_names=("[^"]*"|'[^']*'|[^\s]+)/)[1]
        .replace(/^['"]|['"]$/g, '')
        .replace(/\$\(auth_identity ([\w-]+)\)/g, (_, key) => {
          assert.ok(identities[key], `missing rendered identity ${key}`);
          return identities[key];
        }).split(',');
      const attached = body.match(/(?:token_policies|policies)=([^\s]+)/)[1].split(',');
      return { name, names, attached };
    });
  assert.equal(roles.length, 7, 'inspect every bootstrap role, including ESO and the reconciler');
  assert.deepEqual(roles.filter((r) => r.attached.includes('function-invocation')).map((r) => r.name),
    ['eso-role'], 'only ESO may carry the dedicated signer read policy');
  const tenantAccounts = objects.filter((o) => o.kind === 'ServiceAccount'
    && /-(?:control-plane-executor|workflow-worker)$/.test(o.metadata.name)).map((o) => o.metadata.name);
  assert.equal(tenantAccounts.length, 2, 'both tenant-code identities must be checked');
  const matches = (pattern, path) => new RegExp('^' + pattern.split('/')
    .map((segment) => segment === '+' ? '[^/]+' : segment.split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
    .join('/') + '$').test(path);
  for (const account of tenantAccounts) {
    const bound = roles.filter((r) => r.names.some((name) => matches(name, account)));
    assert.ok(bound.length, `${account} must have its actual OpenBao bindings inspected`);
    for (const role of bound) for (const policy of role.attached) {
      assert.ok(policies.has(policy), `inspect policy ${policy} bound to ${account}`);
      for (const [, path, body] of policies.get(policy).matchAll(/path "([^"]+)"\s*\{([^}]+)\}/g)) {
        if (!/"(?:read|create|update|delete|sudo)"/.test(body)) continue;
        for (const protectedPath of [`secret/data/${remoteKey}`, `secret/metadata/${remoteKey}`,
          'sys/policies/acl/function-invocation', 'auth/kubernetes/role/eso-role']) {
          assert.ok(!matches(path, protectedPath),
            `${account} via ${role.name}/${policy} must not access or grant signer authority`);
        }
      }
    }
  }
  const reconciler = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-auth-reconcile');
  const reconcileScript = reconciler.spec.template.spec.containers
    .find((c) => c.name === 'auth-metadata-reconciler').args[0];
  assert.match(reconcileScript, /desired_policies="function-invocation,functions,gateway,iam,platform"/);
  assert.doesNotMatch(reconcileScript, /bao policy write function-invocation/,
    'the metadata-only reconciler cannot publish signer policy or read the key');
}

function verify(objects, { secretName = 'in-falcone-function-invocation',
  remoteKey = 'control-plane/function-invocation', managed = true } = {}) {
  const externals = objects.filter((o) => o.kind === 'ExternalSecret'
    && o.metadata.name === 'platform-function-invocation');
  assert.equal(externals.length, 1);
  const external = externals[0];
  assert.deepEqual(external.spec.secretStoreRef, { name: 'openbao-backend', kind: 'ClusterSecretStore' });
  assert.equal(external.spec.target.name, secretName);
  assert.equal(external.spec.target.creationPolicy, 'Orphan',
    'replacing a managed ESO hook must not garbage-collect the signer Secret');
  assert.equal(external.spec.target.deletionPolicy, 'Retain');
  assert.equal(external.spec.target.immutable, false);
  assert.equal(external.spec.refreshInterval, '1h');
  assert.deepEqual(external.spec.data, Object.values(bindings).map((key) => ({
    secretKey: key, remoteRef: { key: remoteKey, property: key },
  })));
  assert.equal(external.metadata.annotations?.['helm.sh/hook'],
    managed ? 'post-install,post-upgrade' : undefined);
  if (managed) assert.equal(external.metadata.annotations['helm.sh/hook-weight'], '5');

  const stores = objects.filter((o) => o.kind === 'ClusterSecretStore'
    && o.metadata.name === 'openbao-backend');
  assert.equal(stores.length, 1);
  assert.equal(stores[0].spec.provider.vault.path, 'secret');
  assert.equal(stores[0].spec.provider.vault.version, 'v2');
  assert.equal(stores[0].spec.provider.vault.auth.kubernetes.role, 'eso-role');
  // Upgrade renders omit openbao-init; install profiles prove every SA binding.
  if (objects.some((o) => o.kind === 'Job' && o.metadata.name === 'openbao-init')) {
    verifySignerPolicies(objects, remoteKey);
  }

  const signers = [];
  let executorFound = false;
  for (const o of [...objects, ...fixture]) {
    const pod = o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec
      : o.spec?.template?.spec;
    if (!pod) continue;
    const signerPod = o.kind === 'Deployment'
      && pod.containers.some((container) => signerNames.includes(container.name));
    if (signerPod) {
      const volumes = (pod.volumes ?? []).filter((volume) => volume.name === signerVolume);
      assert.equal(volumes.length, 1);
      assert.deepEqual(volumes[0].secret, {
        secretName, optional: true, defaultMode: 0o440,
        items: Object.values(bindings).map((key) => ({ key, path: key })),
      }, 'optional Secret projection must allow startup before post-install/post-upgrade ESO delivery');
    } else {
      assert.ok(!JSON.stringify(pod.volumes ?? []).includes(secretName),
        `${o.metadata.name} must not receive the signer Secret`);
    }
    for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
      if (container.name === 'control-plane-executor') executorFound = true;
      const env = container.env ?? [];
      const signer = signerPod && signerNames.includes(container.name);
      assert.ok(env.every((entry) => !(entry.name in bindings)),
        'startup-only signer key env must never return');
      if (signer) {
        signers.push(container.name);
        assert.deepEqual(env.filter((entry) => entry.name === 'FN_INVOCATION_SECRET_DIR'),
          [{ name: 'FN_INVOCATION_SECRET_DIR', value: signerDirectory }]);
        assert.deepEqual((container.volumeMounts ?? []).filter((mount) => mount.name === signerVolume),
          [{ name: signerVolume, mountPath: signerDirectory, readOnly: true }],
          'whole-directory mount without subPath must receive delayed delivery and atomic rotation');
      } else {
        assert.ok(env.every((entry) => entry.name !== 'FN_INVOCATION_SECRET_DIR'));
        assert.ok((container.volumeMounts ?? []).every((mount) => mount.name !== signerVolume),
          `${o.metadata.name}/${container.name} must not mount signer files`);
        assert.ok(!JSON.stringify(container).includes(secretName),
          `${o.metadata.name}/${container.name} must not reference signer Secret`);
      }
      assert.ok(!JSON.stringify(container.envFrom ?? []).includes(secretName));
    }
  }
  assert.deepEqual(signers.sort(), [...signerNames].sort());
  assert.ok(executorFound, 'the executor must render and pass all non-signer checks');
  for (const o of objects.filter((o) => o.kind === 'ConfigMap' || o.kind === 'Secret')) {
    assert.ok(!Object.keys(o.data ?? {}).some((key) => key in bindings),
      'Helm must not store invocation keys in shared config or generate key material');
    assert.notEqual(o.metadata.name, secretName, 'ESO alone creates the signer Secret');
  }
}

test('only control-plane mounts refreshable keys; executor receives no signer files in shipped profiles', () => {
  const profiles = [
    { args: [] }, { args: ['--set', 'temporal.ui.enabled=false'] },
    { args: ['-f', 'charts/in-falcone/values/staging.yaml'], managed: false },
    { args: ['-f', 'charts/in-falcone/values/prod.yaml'] },
    { args: ['-f', 'deploy/kind/values-kind.yaml'] },
    { args: ['-f', 'tests/e2e/values-flows-e2e.yaml', '--skip-schema-validation'] },
    { args: ['--set', 'global.podSecurity.openshiftRestricted=true'] },
  ];
  for (const { args, managed = true } of profiles) verify(render(umbrellaChart, args).objects, { managed });
});

test('custom references bind ESO and the signer to the same Secret and OpenBao path', () => {
  verify(render(umbrellaChart, [
    '--set', 'global.functionInvocation.secretName=custom-function-signer',
    '--set', 'global.functionInvocation.remoteKey=control-plane/function-invocation/custom',
  ]).objects, { secretName: 'custom-function-signer', remoteKey: 'control-plane/function-invocation/custom' });
});

test('adopted ESO keeps signer ExternalSecret tracked without hooks', () => {
  verify(render(umbrellaChart, [
    '--set', 'eso.external-secrets.enabled=false',
    '--set', 'global.externalSecrets.operatorNamespace=external-eso',
    '--set', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ]).objects, { managed: false });
});

test('managed ESO upgrade hooks retain the signer Secret without an ownerReference', () => {
  verify(render(umbrellaChart, [
    '--is-upgrade', '--set', 'deployment.upgrade.currentVersion=0.3.1',
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set', 'global.webhookDatabase.migration.backupReference=bbx-function-signer',
  ]).objects);
});

test('network policy rollback does not disable signer delivery', () => {
  verify(render(umbrellaChart, ['--set', 'functions.networkPolicy.enabled=false']).objects);
});

test('upgrades render signer delivery when stored defaults lack the new global key', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'falcone-function-signer-upgrade-'));
  try {
    const chart = resolve(directory, 'chart');
    cpSync(umbrellaChart, chart, { recursive: true });
    const valuesFile = resolve(chart, 'values.yaml');
    const values = yamlDocuments(readFileSync(valuesFile, 'utf8'))[0];
    delete values.global.functionInvocation;
    // JSON is valid YAML. Removing the key from chart defaults prevents Helm
    // coalescing from hiding unsafe reads, as it would in a --set-only test.
    writeFileSync(valuesFile, JSON.stringify(values));
    verify(render(chart, [
      '--is-upgrade', '--set', 'deployment.upgrade.currentVersion=0.3.1',
      '--set', 'global.webhookDatabase.migration.backupVerified=true',
      '--set', 'global.webhookDatabase.migration.parityVerified=true',
      '--set', 'global.webhookDatabase.migration.backupReference=bbx-function-signer',
    ]).objects);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inline key material and env overrides fail closed, including without schema validation', () => {
  const cases = [
    ['global.functionInvocation.privateKey=invalid', /references only/],
    ['controlPlane.env[0].name=FN_INVOCATION_PRIVATE_KEY', /reserved FN_INVOCATION/],
    ['controlPlaneExecutor.env[0].name=FN_INVOCATION_KEY_ID', /reserved FN_INVOCATION/],
    ['controlPlane.env[0].name=FN_INVOCATION_SECRET_DIR', /reserved FN_INVOCATION/],
    ['controlPlaneExecutor.config.inline.FN_INVOCATION_SECRET_DIR=invalid', /reserved FN_INVOCATION/],
    ['controlPlane.config.inline.FN_INVOCATION_JWKS=invalid', /reserved FN_INVOCATION/],
    ['global.transportSecurity.env[0].name=FN_INVOCATION_PRIVATE_KEY', /reserved FN_INVOCATION/],
    ['global.transportSecurity.env[0].name=FN_INVOCATION_SECRET_DIR', /reserved FN_INVOCATION/],
    ['global.functionInvocation.remoteKey=workspaces/foreign', /isolated control-plane/],
    ['global.functionInvocation.remoteKey=platform/functions/invocation', /isolated control-plane/],
    ['global.functionInvocation.remoteKey=control-plane/other-secret', /isolated control-plane/],
    ['global.functionInvocation.remoteKey=control-plane/function-invocation/../escape', /isolated control-plane/],
  ];
  for (const [setting, error] of cases) {
    const result = run('helm', ['template', 'falcone-bbx', umbrellaChart,
      '--skip-schema-validation', '--set', setting]);
    assert.notEqual(result.status, 0, setting);
    assert.match(result.stderr, error);
  }
  const valid = run('helm', ['lint', umbrellaChart]);
  assertSuccess(valid, 'helm lint');
  const invalid = run('helm', ['template', 'falcone-bbx', umbrellaChart,
    '--set', 'global.functionInvocation.privateKey=invalid']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /additional propert(?:y|ies).*privateKey.*not allowed/i);
});
