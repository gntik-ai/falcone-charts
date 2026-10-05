import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertSuccess, render, run, umbrellaChart } from './blackbox/fixtures/blackbox.mjs';

const upgradeArgs = [
  '--is-upgrade', '--set', 'deployment.upgrade.currentVersion=0.3.1',
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set', 'global.webhookDatabase.migration.backupReference=bbx-function-bootstrap',
];
const install = render(umbrellaChart).objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-init');
const upgradeObjects = render(umbrellaChart, upgradeArgs).objects;
const upgrade = upgradeObjects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-function-invocation-seed');
const script = (container) => container.args[0];
const seedBody = (job) => {
  const container = job.spec.template.spec.containers.find((c) => c.name === 'openbao-init' || c.name === 'function-invocation-seed');
  return script(container).split('invocation_path=')[1].split('echo "Function invocation signer converged"')[0];
};

test('install and upgrade share signer bootstrap before ESO without weakening auth reconciliation', () => {
  assert.ok(install);
  assert.ok(upgrade);
  assert.equal(seedBody(install), seedBody(upgrade));
  assert.equal(install.metadata.annotations['helm.sh/hook-weight'], '-4');
  assert.equal(upgrade.metadata.annotations['helm.sh/hook-weight'], '-2');
  const external = upgradeObjects.find((o) => o.kind === 'ExternalSecret' && o.metadata.name === 'platform-function-invocation');
  assert.ok(Number(upgrade.metadata.annotations['helm.sh/hook-weight']) < Number(external.metadata.annotations['helm.sh/hook-weight']));
  for (const job of [install, upgrade]) {
    const pod = job.spec.template.spec;
    assert.equal(pod.serviceAccountName, 'openbao-bootstrap');
    assert.ok(pod.securityContext.fsGroup);
    assert.deepEqual(pod.volumes.find((v) => v.name === 'function-invocation').emptyDir, { medium: 'Memory' });
    const generator = pod.containers.find((c) => c.name === 'function-invocation-key-generator');
    assert.ok(generator.image.includes('alpine/openssl'));
    assert.equal(generator.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(generator.volumeMounts, [{ name: 'function-invocation', mountPath: '/function-invocation' }]);
    assertSuccess(run('sh', ['-n', '-c', script(generator)]), 'generator shell syntax');
  }
  const seed = upgrade.spec.template.spec.containers.find((c) => c.name === 'function-invocation-seed');
  assert.match(script(seed), /role=openbao-init-role/);
  assertSuccess(run('sh', ['-n', '-c', script(seed)]), 'upgrade bootstrap shell syntax');
  assert.ok(upgrade.spec.template.spec.volumes.every((v) => !v.secret?.secretName.includes('recovery')));
  const policy = upgradeObjects.find((o) => o.kind === 'ConfigMap' && o.metadata.name === 'openbao-policy-auth-reconcile');
  assert.doesNotMatch(policy.data['auth-reconcile.hcl'], /secret\/data/);
});

test('GitOps upgrades and customized references retain bootstrap ordering and paths', () => {
  const objects = render(umbrellaChart, [
    '--set', 'global.gitops.upgradeSemantics=true',
    '--set', 'deployment.upgrade.currentVersion=0.3.1',
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set', 'global.webhookDatabase.migration.backupReference=bbx-function-bootstrap',
    '--set', 'global.functionInvocation.remoteKey=platform/functions/custom',
  ]).objects;
  assert.ok(!objects.some((o) => o.kind === 'Job' && o.metadata.name === 'openbao-init'));
  const job = objects.find((o) => o.kind === 'Job' && o.metadata.name === 'openbao-function-invocation-seed');
  assert.ok(job);
  assert.match(script(job.spec.template.spec.containers.find((c) => c.name === 'function-invocation-seed')),
    /invocation_path="secret\/platform\/functions\/custom"/);
});

// Execute the rendered shell with an offline KV stub. Generated test keys are
// ephemeral; outputs and assertion messages never contain their contents.
const fakeBao = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const record = path.join(process.env.BBX_DIR, 'record.json');
const calls = path.join(process.env.BBX_DIR, 'calls');
const mode = process.env.BBX_MODE;
fs.appendFileSync(calls, args.slice(0, 2).join(' ') + '\\n');
if (args[0] !== 'kv') process.exit(1);
if (args[1] === 'get') {
  if (mode === 'denied' || !fs.existsSync(record)) process.exit(1);
  const field = args.find(a => a.startsWith('-field='))?.slice(7);
  if (field && !JSON.parse(fs.readFileSync(record))[field]) process.exit(1);
  process.stdout.write('present');
} else if (args[1] === 'put') {
  if (!args.includes('-cas=0') || mode === 'denied') process.exit(1);
  if (mode === 'race') {
    fs.writeFileSync(record, JSON.stringify({'private-key':'preserved', 'key-id':'retained', jwks:'overlap'}));
    process.exit(1);
  }
  if (fs.existsSync(record)) process.exit(1);
  const data = {};
  for (const arg of args.filter(a => a.includes('=@'))) {
    const [key, file] = arg.split('=@');
    data[key] = fs.readFileSync(file, 'utf8');
  }
  fs.writeFileSync(record, JSON.stringify(data));
} else process.exit(1);
`;

for (const mode of ['absent', 'existing', 'incomplete', 'race', 'denied']) {
  test(`rendered signer bootstrap: ${mode}`, async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'falcone-function-bootstrap-'));
    const initial = { 'private-key': 'preserved', 'key-id': 'retained', jwks: 'overlap' };
    let generator;
    try {
      writeFileSync(resolve(directory, 'bao'), fakeBao, { mode: 0o700 });
      if (mode === 'existing' || mode === 'incomplete') {
        writeFileSync(resolve(directory, 'record.json'), JSON.stringify(mode === 'existing' ? initial : { 'key-id': 'retained' }));
      }
      const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, BBX_DIR: directory, BBX_MODE: mode };
      const rewrite = (text) => text.replaceAll('/function-invocation', directory).replaceAll('sleep 1', 'sleep 0.02');
      generator = spawn('sh', ['-ec', rewrite(script(upgrade.spec.template.spec.containers.find((c) => c.name === 'function-invocation-key-generator')))],
        { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let generatorOutput = '';
      generator.stdout.on('data', (data) => { generatorOutput += data; });
      generator.stderr.on('data', (data) => { generatorOutput += data; });
      const finished = new Promise((accept) => generator.on('exit', (code) => accept(code)));
      // Run only the shared seed section; no cluster access or authentication.
      const seed = 'invocation_path=' + seedBody(upgrade) + 'echo "Function invocation signer converged"';
      const result = run('sh', ['-ec', rewrite(seed)], { env, timeout: 10_000 });
      if (mode === 'denied' || mode === 'incomplete') {
        assert.notEqual(result.status, 0);
        generator.kill();
      } else {
        assertSuccess(result, 'offline signer bootstrap');
        assert.equal(await finished, 0, 'generator completes after bootstrap');
        assert.equal(generatorOutput, '');
        assert.equal(existsSync(resolve(directory, 'private-key')), false, 'ephemeral key file is removed');
      }
      assert.doesNotMatch(result.stdout + result.stderr + generatorOutput, /BEGIN PRIVATE KEY|"keys"|"d"/);
      const recordFile = resolve(directory, 'record.json');
      if (mode === 'absent') {
        const record = JSON.parse(readFileSync(recordFile));
        assert.match(record['private-key'].split('\n')[0], /^-----BEGIN PRIVATE KEY-----$/);
        const privateKey = createPrivateKey(record['private-key']);
        assert.equal(privateKey.asymmetricKeyType, 'ed25519');
        const jwks = JSON.parse(record.jwks);
        assert.equal(jwks.keys.length, 1);
        const publicJwk = jwks.keys[0];
        assert.equal(Object.hasOwn(publicJwk, 'd'), false);
        assert.equal(publicJwk.kid, record['key-id']);
        const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
        assert.ok(verify(null, Buffer.from('bootstrap test'), publicKey, sign(null, Buffer.from('bootstrap test'), privateKey)),
          'public JWKS verifies signatures from generated private key');
        const firstHash = createHash('sha256').update(readFileSync(recordFile)).digest('hex');
        assertSuccess(run('sh', ['-ec', rewrite(seed)], { env }), 'repeat bootstrap');
        assert.equal(createHash('sha256').update(readFileSync(recordFile)).digest('hex'), firstHash, 'repeat does not rotate');
      } else if (mode === 'existing' || mode === 'race') {
        assert.equal(createHash('sha256').update(readFileSync(recordFile)).digest('hex'),
          createHash('sha256').update(JSON.stringify(initial)).digest('hex'), 'retained keys and overlapping JWKS stay unchanged');
      } else if (mode === 'denied') {
        assert.equal(existsSync(recordFile), false);
      }
      if (mode === 'existing' || mode === 'incomplete') {
        assert.ok(!readFileSync(resolve(directory, 'calls'), 'utf8').includes('kv put'), 'existing records never get a write');
        assert.equal(existsSync(resolve(directory, '.generate')), false, 'existing record never requests key generation');
      }
    } finally {
      generator?.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
