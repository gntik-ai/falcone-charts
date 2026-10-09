import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const chart = 'charts/in-falcone';
const bindings = {
  INVITATION_EMAIL_HMAC_KEY: 'key',
  INVITATION_EMAIL_HMAC_KEY_ID: 'key-id',
};

function render(args = [], chartPath = chart) {
  return spawnSync('helm', ['template', 'invitation-bbx', chartPath,
    '--namespace', 'invitation-bbx', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
}

function documents(result) {
  assert.equal(result.status, 0, result.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'falcone-invitation-chart-'));
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

function verifyDelivery(objects, secretName = 'in-falcone-invitation-email-hmac',
  remoteKey = 'iam/invitation-email-hmac') {
  const externals = objects.filter((object) => object.kind === 'ExternalSecret'
    && object.metadata.name === 'iam-invitation-email-hmac');
  assert.equal(externals.length, 1, 'ESO must deliver the invitation HMAC record');
  const external = externals[0];
  assert.deepEqual(external.spec.secretStoreRef,
    { name: 'openbao-backend', kind: 'ClusterSecretStore' });
  assert.equal(external.spec.target.name, secretName);
  assert.equal(external.spec.target.creationPolicy, 'Orphan');
  assert.equal(external.spec.target.deletionPolicy, 'Retain');
  assert.deepEqual(external.spec.data, Object.values(bindings).map((key) => ({
    secretKey: key, remoteRef: { key: remoteKey, property: key },
  })));
  let recipients = 0;
  for (const object of objects) {
    const pod = object.kind === 'CronJob' ? object.spec?.jobTemplate?.spec?.template?.spec
      : object.spec?.template?.spec;
    if (!pod) continue;
    for (const container of [...(pod.containers ?? []), ...(pod.initContainers ?? [])]) {
      const env = (container.env ?? []).filter((entry) => entry.name in bindings);
      if (object.kind === 'Deployment' && container.name === 'control-plane') {
        recipients++;
        assert.deepEqual(env, Object.entries(bindings).map(([name, key]) => ({
          name, valueFrom: { secretKeyRef: { name: secretName, key, optional: false } },
        })), 'both key and key id must be required at startup');
      } else {
        assert.deepEqual(env, [], `${object.metadata.name}/${container.name} must not receive HMAC material`);
        assert.ok(!JSON.stringify(container).includes(secretName));
      }
    }
  }
  assert.equal(recipients, 1);
  assert.ok(!objects.some((object) => object.kind === 'Secret'
    && object.metadata.name === secretName), 'Helm must never generate the HMAC Secret');
}

test('only control-plane receives the required OpenBao/ESO invitation key and key id', () => {
  verifyDelivery(documents(render()));
  verifyDelivery(documents(render([
    '--set', 'global.invitationEmailHmac.secretName=custom-invitation-hmac',
    '--set', 'global.invitationEmailHmac.remoteKey=iam/invitation-email-hmac/rotation',
  ])), 'custom-invitation-hmac', 'iam/invitation-email-hmac/rotation');
  const adopted = documents(render([
    '--set', 'eso.external-secrets.enabled=false',
    '--set', 'global.externalSecrets.operatorNamespace=external-eso',
    '--set', 'global.externalSecrets.operatorServiceAccount=external-secrets',
  ]));
  verifyDelivery(adopted);
  assert.equal(adopted.find((object) => object.kind === 'ExternalSecret'
    && object.metadata.name === 'iam-invitation-email-hmac').metadata.annotations?.['helm.sh/hook'],
  undefined, 'adopted ESO integration remains Helm-tracked');
  const directory = mkdtempSync(join(tmpdir(), 'falcone-invitation-legacy-'));
  try {
    const legacyChart = join(directory, 'chart');
    cpSync(chart, legacyChart, { recursive: true });
    const valuesFile = join(legacyChart, 'values.yaml');
    const legacyValues = documents({ status: 0, stdout: readFileSync(valuesFile, 'utf8') })[0];
    delete legacyValues.global.invitationEmailHmac;
    // Remove the new chart defaults as well: ordinary Helm coalescing would
    // conceal unsafe reads that break stored values under --reuse-values.
    writeFileSync(valuesFile, JSON.stringify(legacyValues));
    verifyDelivery(documents(render([
      '--is-upgrade', '--set', 'deployment.upgrade.currentVersion=0.3.1',
      '--set', 'global.webhookDatabase.migration.backupVerified=true',
      '--set', 'global.webhookDatabase.migration.parityVerified=true',
      '--set', 'global.webhookDatabase.migration.backupReference=bbx-invitation-backup',
    ], legacyChart)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('missing references and attempts to bypass ESO fail closed even without schema validation', () => {
  const cases = [
    ['global.invitationEmailHmac.secretName=', /invitationEmailHmac.secretName/],
    ['global.invitationEmailHmac.remoteKey=', /invitationEmailHmac.remoteKey/],
    ['global.invitationEmailHmac.remoteKey=iam/keycloak', /invitationEmailHmac.remoteKey/],
    ['global.invitationEmailHmac.key=forbidden', /references only/],
    ['controlPlane.env[0].name=INVITATION_EMAIL_HMAC_KEY', /reserved INVITATION_EMAIL_HMAC/],
    ['controlPlane.config.inline.INVITATION_EMAIL_HMAC_KEY_ID=forbidden', /reserved INVITATION_EMAIL_HMAC/],
    ['controlPlaneExecutor.env[0].name=INVITATION_EMAIL_HMAC_KEY_ID', /reserved INVITATION_EMAIL_HMAC/],
    ['global.transportSecurity.env[0].name=INVITATION_EMAIL_HMAC_KEY', /reserved INVITATION_EMAIL_HMAC/],
  ];
  for (const [setting, message] of cases) {
    const result = render(['--skip-schema-validation', '--set-string', setting]);
    assert.notEqual(result.status, 0, `${setting} must be rejected`);
    assert.match(result.stderr, message);
  }
  for (const setting of ['global.invitationEmailHmac.secretName=',
    'global.invitationEmailHmac.remoteKey=', 'global.invitationEmailHmac.key=forbidden']) {
    assert.notEqual(render(['--set-string', setting]).status, 0, setting);
  }
});
