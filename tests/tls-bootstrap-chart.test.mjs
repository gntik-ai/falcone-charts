import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chart = resolve(root, 'charts/in-falcone');
const generatorDigest =
  'sha256:ef8657028239a006f3de0bd04529e22c073bf0ab6655ece9f25c8dde9adec146';
let passed = 0;

function render(extra = []) {
  const result = spawnSync(
    'helm',
    ['template', 'falcone', chart, '--namespace', 'falcone-test', ...extra],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function documents(yaml) {
  return yaml.split(/^---\s*$/m);
}

function documentWith(yaml, ...needles) {
  return documents(yaml).find((doc) => needles.every((needle) => doc.includes(needle)));
}

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function seaweedfsTlsClientScript(rendered) {
  const job = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: seaweedfs-tls',
  );
  assert.ok(job, 'SeaweedFS TLS Job must be present');
  const client = job.slice(job.indexOf('        - name: kubernetes-client'));
  const match = client.match(/            - \|\n([\s\S]*?)\n          volumeMounts:/);
  assert.ok(match, 'SeaweedFS TLS Kubernetes-client script must be extractable');
  return match[1].replace(/^ {14}/gm, '');
}

function runSeaweedfsTlsClient({ existingSecrets }) {
  const fixture = mkdtempSync(join(tmpdir(), 'falcone-seaweedfs-tls-'));
  const bin = join(fixture, 'bin');
  const state = join(fixture, 'state');
  const tls = join(fixture, 'tls');
  mkdirSync(bin);
  mkdirSync(state);
  mkdirSync(tls);
  for (const file of [
    'ca.crt',
    'ca.key',
    'master.crt',
    'master.key',
    'volume.crt',
    'volume.key',
    'filer.crt',
    'filer.key',
    'client.crt',
    'client.key',
  ]) {
    writeFileSync(join(tls, file), 'test-only-certificate-material');
  }
  for (const name of existingSecrets) {
    const secret = join(state, name);
    mkdirSync(secret);
    writeFileSync(join(secret, 'complete'), '1');
  }

  const kubectl = join(bin, 'kubectl');
  writeFileSync(kubectl, `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in
    get|create|apply) command="$1"; shift; break ;;
    *) shift ;;
  esac
done
case "$command" in
  get)
    [ "$1" = secret ]
    name="$2"
    [ -d "$TLS_FAKE_STATE/$name" ] || exit 1
    case "$*" in
      *jsonpath*) [ -f "$TLS_FAKE_STATE/$name/complete" ] || exit 1; printf ZmFrZQ== ;;
    esac
    ;;
  create)
    [ "$1" = secret ] && [ "$2" = generic ]
    printf '%s\\n' "$3"
    ;;
  apply)
    name=$(cat)
    mkdir -p "$TLS_FAKE_STATE/$name"
    : > "$TLS_FAKE_STATE/$name/complete"
    printf '%s\\n' "$name" >> "$TLS_FAKE_APPLIED"
    ;;
esac
`);
  chmodSync(kubectl, 0o755);

  const rendered = render(['--set', 'seaweedfsTls.bootstrap.enabled=true']);
  const script = seaweedfsTlsClientScript(rendered)
    .replace('D=/tls-bootstrap', 'D="$TLS_TEST_DIR"');
  const applied = join(fixture, 'applied');
  writeFileSync(applied, '');
  const result = spawnSync('/bin/sh', ['-ec', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NS: 'falcone-test',
      PREFIX: 'falcone-seaweedfs',
      TLS_FAKE_APPLIED: applied,
      TLS_FAKE_STATE: state,
      TLS_TEST_DIR: tls,
    },
  });
  const appliedNames = readFileSync(applied, 'utf8').trim().split('\n').filter(Boolean);
  const finalSecrets = ['ca', 'master', 'volume', 'filer', 'client'].filter(
    (component) => {
      const name = `falcone-seaweedfs-${component}-cert`;
      try {
        return readFileSync(join(state, name, 'complete'), 'utf8') === '1'
          || readFileSync(join(state, name, 'complete'), 'utf8') === '';
      } catch {
        return false;
      }
    },
  );
  rmSync(fixture, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return { appliedNames, finalSecrets, output: result.stdout };
}

const base = render();

check('OpenBao separates certificate generation from the Kubernetes client', () => {
  const job = documentWith(base, 'kind: Job', 'name: openbao-tls-bootstrap');
  assert.ok(job, 'base render must contain the self-signed OpenBao bootstrap');
  assert.match(
    job,
    new RegExp(`image: "docker.io/alpine/openssl@${generatorDigest}"`),
    'certificate generation must use the reviewed digest-pinned OpenSSL image',
  );
  assert.match(job, /initContainers:\s+- name: tls-generator/);
  assert.match(job, /containers:\s+- name: kubernetes-client/);
  assert.match(job, /image: "docker\.io\/alpine\/k8s:1\.32\.2"/);
  assert.match(job, /readOnlyRootFilesystem: true/g);
  assert.match(job, /emptyDir: \{\}/);
  assert.match(job, /mountPath: \/tls-bootstrap/g);

  const init = job.slice(job.indexOf('initContainers:'), job.indexOf('containers:'));
  const client = job.slice(job.indexOf('containers:'));
  assert.match(init, /openssl req -x509/);
  assert.doesNotMatch(init, /\bkubectl\b/);
  assert.match(client, /kubectl -n "\$NS" create secret generic/);
  assert.doesNotMatch(client, /\bopenssl\b/);
});

check('SeaweedFS uses the same restricted two-image bootstrap contract', () => {
  const rendered = render(['--set', 'seaweedfsTls.bootstrap.enabled=true']);
  const job = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: seaweedfs-tls',
  );
  assert.ok(job, 'enabled SeaweedFS TLS must render its bootstrap Job');
  assert.match(
    job,
    new RegExp(`image: "docker.io/alpine/openssl@${generatorDigest}"`),
  );
  assert.match(job, /initContainers:\s+- name: tls-generator/);
  assert.match(job, /containers:\s+- name: kubernetes-client/);
  assert.match(job, /image: "docker\.io\/alpine\/k8s:1\.32\.2"/);
  assert.match(job, /readOnlyRootFilesystem: true/g);
  assert.match(job, /emptyDir: \{\}/);
  assert.match(job, /for component in ca master volume filer client/);
  assert.match(job, /for key in 'tls\\\.crt' 'tls\\\.key' 'ca\\\.crt'/);
});

check('SeaweedFS TLS replay repairs a CA-only partial state and preserves a complete set', () => {
  const prefix = 'falcone-seaweedfs';
  const caOnly = runSeaweedfsTlsClient({
    existingSecrets: [`${prefix}-ca-cert`],
  });
  assert.deepEqual(
    caOnly.appliedNames,
    ['falcone-seaweedfs-ca-cert', 'falcone-seaweedfs-master-cert', 'falcone-seaweedfs-volume-cert', 'falcone-seaweedfs-filer-cert', 'falcone-seaweedfs-client-cert'],
    'a retry after CA creation must replace the complete coherent set',
  );
  assert.deepEqual(caOnly.finalSecrets, ['ca', 'master', 'volume', 'filer', 'client']);
  assert.match(caOnly.output, /missing or partial/);

  const complete = runSeaweedfsTlsClient({
    existingSecrets: ['ca', 'master', 'volume', 'filer', 'client']
      .map((component) => `${prefix}-${component}-cert`),
  });
  assert.deepEqual(complete.appliedNames, [], 'a complete existing set must not rotate its CA');
  assert.deepEqual(complete.finalSecrets, ['ca', 'master', 'volume', 'filer', 'client']);
  assert.match(complete.output, /all five SeaweedFS TLS Secrets are complete/);
});

check('OpenShift rewrites both bootstrap images while preserving the generator digest', () => {
  const rendered = render(['-f', 'deploy/openshift/values-openshift.yaml']);
  const openbao = documentWith(rendered, 'kind: Job', 'name: openbao-tls-bootstrap');
  const seaweedfs = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: seaweedfs-tls',
  );
  assert.ok(openbao);
  assert.ok(seaweedfs);
  for (const job of [openbao, seaweedfs]) {
    assert.match(
      job,
      new RegExp(`image: "harbor.example.com/falcone/alpine/openssl@${generatorDigest}"`),
    );
    assert.match(job, /image: "harbor\.example\.com\/falcone\/alpine\/k8s:1\.32\.2"/);
    assert.match(job, /runAsNonRoot: true/);
    assert.doesNotMatch(job, /runAsUser: 0/);
    assert.doesNotMatch(job, /privileged: true/);
  }
});

check('tracked image documentation does not claim alpine/k8s contains OpenSSL', () => {
  const tracked = [
    'charts/in-falcone/charts/openbao/values.yaml',
    'charts/in-falcone/values.yaml',
    'deploy/openshift/values-openshift.yaml',
  ].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');
  assert.doesNotMatch(
    tracked,
    /alpine\/k8s[^\n]*(?:carries|contains|includes)[^\n]*openssl/i,
  );
});

process.stdout.write(`TLS_BOOTSTRAP_CHART_PASS cases=${passed}\n`);
