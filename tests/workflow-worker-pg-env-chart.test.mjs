// #1132: worker PG env belongs to this deployment repository, not the source
// repository's untracked live-campaign script or executor manifest. Temporal
// search attributes are covered by temporal-bootstrap-readiness-contract.test.mjs.
// Parse tracked defaults only; inspect Secret reference names/keys, never values.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const parsed = spawnSync('python3', ['-c',
  'import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1]))["workflowWorker"]["env"], sys.stdout)',
  fileURLToPath(new URL('../charts/in-falcone/values.yaml', import.meta.url)),
], { encoding: 'utf8' });
assert.equal(parsed.status, 0, 'tracked workflowWorker env must parse as YAML');
const env = JSON.parse(parsed.stdout);

function binding(name) {
  const entries = env.filter((entry) => entry.name === name);
  assert.equal(entries.length, 1, `workflowWorker must declare exactly one ${name}`);
  return entries[0];
}

function secretReference(entry, name, key) {
  assert.equal(Object.hasOwn(entry, 'value'), false, `${entry.name} must use a Secret reference`);
  const ref = entry.valueFrom?.secretKeyRef;
  assert.ok(ref, `${entry.name} must use secretKeyRef`);
  assert.equal(ref.name, name, `${entry.name} Secret name`);
  assert.equal(ref.key, key, `${entry.name} Secret key`);
  assert.notEqual(ref.optional, true, `${entry.name} Secret reference must be required`);
}

test('01: workflowWorker PGHOST targets the release PostgreSQL service', () => {
  assert.equal(binding('PGHOST').value, '{{ .Release.Name }}-postgresql');
});

test('02: workflowWorker PGUSER uses the PostgreSQL username Secret reference', () => {
  secretReference(binding('PGUSER'), 'in-falcone-postgresql', 'POSTGRESQL_USERNAME');
});

test('03: workflowWorker PGDATABASE is in_falcone', () => {
  assert.equal(binding('PGDATABASE').value, 'in_falcone');
});

test('04: workflowWorker PGPASSWORD uses the PostgreSQL password Secret reference', () => {
  secretReference(binding('PGPASSWORD'), 'in-falcone-postgresql', 'POSTGRESQL_PASSWORD');
});
