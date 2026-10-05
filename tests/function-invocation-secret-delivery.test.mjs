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

function verify(objects, { secretName = 'in-falcone-function-invocation',
  remoteKey = 'platform/functions/invocation', managed = true } = {}) {
  const externals = objects.filter((o) => o.kind === 'ExternalSecret'
    && o.metadata.name === 'platform-function-invocation');
  assert.equal(externals.length, 1);
  const external = externals[0];
  assert.deepEqual(external.spec.secretStoreRef, { name: 'openbao-backend', kind: 'ClusterSecretStore' });
  assert.equal(external.spec.target.name, secretName);
  assert.equal(external.spec.target.creationPolicy, 'Owner');
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

  let signers = 0;
  for (const o of [...objects, ...fixture]) {
    const pod = o.kind === 'CronJob' ? o.spec?.jobTemplate?.spec?.template?.spec
      : o.spec?.template?.spec;
    if (!pod) continue;
    for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
      const env = container.env ?? [];
      const signer = o.kind === 'Deployment' && container.name === 'control-plane';
      if (signer) {
        signers += 1;
        for (const [name, key] of Object.entries(bindings)) {
          const entries = env.filter((entry) => entry.name === name);
          assert.equal(entries.length, 1, name);
          assert.deepEqual(entries[0], { name, valueFrom: {
            secretKeyRef: { name: secretName, key, optional: false },
          } });
        }
      } else {
        assert.ok(env.every((entry) => !(entry.name in bindings)),
          `${o.metadata.name}/${container.name} must not receive signer env`);
        assert.ok(!JSON.stringify(container).includes(secretName),
          `${o.metadata.name}/${container.name} must not reference signer Secret`);
      }
      assert.ok(!JSON.stringify(container.envFrom ?? []).includes(secretName));
    }
    assert.ok(!JSON.stringify(pod.volumes ?? []).includes(secretName),
      'signer Secret must not be mounted into pods or sidecars');
  }
  assert.equal(signers, 1);
  for (const o of objects.filter((o) => o.kind === 'ConfigMap' || o.kind === 'Secret')) {
    assert.ok(!Object.keys(o.data ?? {}).some((key) => key in bindings),
      'Helm must not store invocation keys in shared config or generate key material');
    assert.notEqual(o.metadata.name, secretName, 'ESO alone creates the signer Secret');
  }
}

test('signer delivery is control-plane-only in every shipped profile', () => {
  const profiles = [
    { args: [] }, { args: ['--set', 'temporal.ui.enabled=false'] },
    { args: ['-f', 'charts/in-falcone/values/staging.yaml'], managed: false },
    { args: ['-f', 'charts/in-falcone/values/prod.yaml'] },
    { args: ['-f', 'deploy/kind/values-kind.yaml'] },
    { args: ['-f', 'tests/e2e/values-flows-e2e.yaml', '--skip-schema-validation'] },
  ];
  for (const { args, managed = true } of profiles) verify(render(umbrellaChart, args).objects, { managed });
});

test('custom references bind ESO and the signer to the same Secret and OpenBao path', () => {
  verify(render(umbrellaChart, [
    '--set', 'global.functionInvocation.secretName=custom-function-signer',
    '--set', 'global.functionInvocation.remoteKey=platform/functions/custom',
  ]).objects, { secretName: 'custom-function-signer', remoteKey: 'platform/functions/custom' });
});

test('adopted ESO keeps signer ExternalSecret tracked without hooks', () => {
  verify(render(umbrellaChart, [
    '--set', 'eso.external-secrets.enabled=false',
    '--set', 'global.externalSecrets.operatorNamespace=external-eso',
    '--set', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ]).objects, { managed: false });
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
    ['controlPlane.config.inline.FN_INVOCATION_JWKS=invalid', /reserved FN_INVOCATION/],
    ['global.transportSecurity.env[0].name=FN_INVOCATION_PRIVATE_KEY', /reserved FN_INVOCATION/],
    ['global.functionInvocation.remoteKey=workspaces/foreign', /platform OpenBao/],
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
