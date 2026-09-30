import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const chart = 'charts/in-falcone';

function helm(args = [], expectSuccess = true) {
  const result = spawnSync('helm', ['template', 'falcone', chart, '--namespace', 'falcone-test', ...args], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status === 0, expectSuccess, result.stderr || result.stdout);
  return result;
}

function document(rendered, kind, name) {
  const matches = rendered.split(/^---\s*$/m).filter((part) =>
    new RegExp(`^kind: ${kind}$`, 'm').test(part) &&
    new RegExp(`^  name: ${name}$`, 'm').test(part));
  assert.equal(matches.length, 1, `expected one ${kind}/${name}`);
  return matches[0];
}

function envValue(manifest, name) {
  const lines = manifest.split('\n');
  const index = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(index >= 0, `missing ${name}`);
  const value = lines[index + 1]?.trim();
  assert.ok(value?.startsWith('value:'), `missing value for ${name}`);
  return value.slice('value:'.length).trim().replaceAll("'", '').replaceAll('"', '');
}

test('platform topic is provisioned before upgrades and relay settings reach the executor', () => {
  for (const values of [[], ['-f', 'deploy/kind/values-production.yaml'],
    ['-f', 'deploy/openshift/values-openshift.yaml']]) {
    const rendered = helm(values).stdout;
    const job = document(rendered, 'Job', 'falcone-flow-audit-topic');
    const executor = document(rendered, 'Deployment', 'falcone-control-plane-executor');
    assert.match(job, /helm\.sh\/hook: post-install,pre-upgrade/);
    assert.match(job, /--create --if-not-exists/);
    assert.equal(envValue(job, 'FLOW_AUDIT_TOPIC'), 'falcone.audit.flow-lifecycle');
    assert.equal(envValue(executor, 'FLOW_AUDIT_TOPIC'), envValue(job, 'FLOW_AUDIT_TOPIC'));
    assert.equal(envValue(executor, 'FLOW_AUDIT_MAX_ATTEMPTS'), '10088');
    assert.equal(envValue(executor, 'FLOW_AUDIT_BACKOFF_CAP_MS'), '60000');
  }
});

test('topic provisioner uses the production Kafka TLS CA for every admin command', () => {
  const plainJob = document(helm().stdout, 'Job', 'falcone-flow-audit-topic');
  assert.doesNotMatch(plainJob, /- name: KAFKA_SSL_CA_FILE/);
  assert.doesNotMatch(plainJob, /- name: falcone-transport-ca/);

  const tlsJob = document(helm(['-f', 'deploy/kind/values-production.yaml']).stdout,
    'Job', 'falcone-flow-audit-topic');
  assert.equal(envValue(tlsJob, 'KAFKA_SSL'), 'true');
  assert.equal(envValue(tlsJob, 'KAFKA_SSL_CA_FILE'), '/etc/falcone/tls/ca.crt');
  assert.match(tlsJob, /security\.protocol=SSL\\nssl\.truststore\.type=PEM\\nssl\.truststore\.location=%s/);
  assert.match(tlsJob, /kafka_config=\(--command-config \/tmp\/kafka-client\.properties\)/);
  assert.equal(tlsJob.match(/"\$\{kafka_config\[@\]\}"/g)?.length, 3);
  assert.match(tlsJob, /- name: falcone-transport-ca\n\s+mountPath: "\/etc\/falcone\/tls"\n\s+readOnly: true/);
  assert.match(tlsJob, /- name: falcone-transport-ca\n\s+secret:\n\s+secretName: "falcone-transport-ca"/);
});

test('Kafka TLS without a CA file fails chart rendering', () => {
  const result = helm(['-f', 'deploy/kind/values-production.yaml',
    '--set', 'global.transportSecurity.env[5].value='], false);
  assert.match(result.stderr, /KAFKA_SSL_CA_FILE must be a file below caMountPath/);
});

test('custom platform topic and relay settings render consistently', () => {
  const rendered = helm([
    '--set-string', 'global.flowAuditTopic.name=falcone.audit.flow-review',
    '--set', 'global.flowAuditRelay.maxAttempts=20000',
    '--set', 'global.flowAuditRelay.backoffCapMs=30000',
  ]).stdout;
  const job = document(rendered, 'Job', 'falcone-flow-audit-topic');
  const executor = document(rendered, 'Deployment', 'falcone-control-plane-executor');
  assert.equal(envValue(job, 'FLOW_AUDIT_TOPIC'), 'falcone.audit.flow-review');
  assert.equal(envValue(executor, 'FLOW_AUDIT_TOPIC'), 'falcone.audit.flow-review');
  assert.equal(envValue(executor, 'FLOW_AUDIT_MAX_ATTEMPTS'), '20000');
  assert.equal(envValue(executor, 'FLOW_AUDIT_BACKOFF_CAP_MS'), '30000');
});

test('tenant evt.* namespace cannot be used for platform Flow audit', () => {
  const result = helm(['--set-string', 'global.flowAuditTopic.name=evt.workspace.flow-audit'], false);
  assert.match(result.stderr, /global\.flowAuditTopic\.name must be a platform-scoped Kafka topic name/);
});
