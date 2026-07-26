import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chart = resolve(root, 'charts/in-falcone');
let passed = 0;

function helm(args, { fail = false } = {}) {
  const result = spawnSync('helm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (fail) {
    assert.notEqual(result.status, 0, 'expected Helm validation failure');
    assert.equal(result.stdout, '', 'failed validation must not emit a partial manifest');
  } else {
    assert.equal(result.status, 0, result.stderr);
  }
  return { output: `${result.stdout}\n${result.stderr}`, stderr: result.stderr };
}

function render(extra = []) {
  return helm([
    'template', 'falcone', chart, '--namespace', 'falcone-test', ...extra,
  ]).output;
}

function upgrade(extra = [], version = '0.3.0') {
  return render([
    '--is-upgrade',
    '--set', `deployment.upgrade.currentVersion=${version}`,
    '--set', 'global.webhookDatabase.migration.backupVerified=true',
    '--set', 'global.webhookDatabase.migration.parityVerified=true',
    '--set', 'global.webhookDatabase.migration.backupReference=c25-chart-test',
    ...extra,
  ]);
}

function documents(yaml) {
  return yaml.split(/^---\s*$/m);
}

function documentWith(yaml, ...needles) {
  return documents(yaml).find((doc) => needles.every((needle) => doc.includes(needle)));
}

function renderedHooks(yaml, component) {
  return documents(yaml)
    .filter((doc) => doc.includes(`app.kubernetes.io/component: ${component}`))
    .filter((doc) => doc.includes('"helm.sh/hook": pre-install,pre-upgrade'))
    .map((doc) => {
      const kind = doc.match(/^kind:\s*(\S+)\s*$/m)?.[1];
      const name = doc.match(/^metadata:\s*\n\s{2}name:\s*"?([^"\n]+)"?\s*$/m)?.[1];
      const weight = Number(doc.match(/"helm\.sh\/hook-weight": "(-?\d+)"/)?.[1]);
      const policyText = doc.match(/"helm\.sh\/hook-delete-policy": ([^\n]+)/)?.[1] ?? '';
      assert.ok(kind && name && Number.isInteger(weight), 'rendered hook metadata is incomplete');
      return {
        key: `${kind}/${name}`,
        kind,
        name,
        weight,
        policies: new Set(policyText.replaceAll('"', '').split(',').map((entry) => entry.trim())),
      };
    })
    .sort((left, right) => (
      left.weight - right.weight
      || left.kind.localeCompare(right.kind)
      || left.name.localeCompare(right.name)
    ));
}

function simulateHelmV414Hooks(hooks, { failKey, initial = new Set() } = {}) {
  const present = new Set(initial);
  const succeeded = [];
  const events = [];

  for (const hook of hooks) {
    if (hook.policies.has('before-hook-creation')) {
      events.push(`before-hook-creation:${hook.key}:${present.delete(hook.key) ? 'removed' : 'absent'}`);
    }
    assert.equal(present.has(hook.key), false, `retry collision for ${hook.key}`);
    present.add(hook.key);
    events.push(`created:${hook.key}`);

    if (hook.key === failKey) {
      events.push(`failed:${hook.key}`);
      if (hook.policies.has('hook-failed')) {
        present.delete(hook.key);
      }
      for (const completed of succeeded) {
        if (completed.policies.has('hook-succeeded')) {
          present.delete(completed.key);
          events.push(`hook-succeeded-removed:${completed.key}`);
        }
      }
      return { events, present };
    }
    succeeded.push(hook);
  }

  for (const completed of succeeded) {
    if (completed.policies.has('hook-succeeded')) {
      present.delete(completed.key);
      events.push(`hook-succeeded-removed:${completed.key}`);
    }
  }
  return { events, present };
}

function stableFailureCodes(script) {
  const outputToken = /\b(?:WEBHOOK_DATABASE_[A-Z0-9_]+|WEBHOOK_POSTGRESQL_16_REQUIRED)\b/g;
  const outputSites = script.split('\n').filter((line) => (
    /\bfail(?:\s|\()/.test(line)
    || /\bbootstrap_failure=/.test(line)
    || (/\bprintf\b/.test(line) && />&2/.test(line))
  ));
  return new Set(outputSites.flatMap((line) => line.match(outputToken) ?? []));
}

function assertCredentialScratchPosture(rendered, label) {
  const job = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  assert.ok(job, `${label}: credential Job must render`);
  assert.match(
    job,
    /name: tmp\s+mountPath: \/tmp/,
    `${label}: credential Job must mount writable scratch at /tmp`,
  );
  assert.match(
    job,
    /name: tmp\s+emptyDir:\s+sizeLimit: 1Mi/,
    `${label}: credential /tmp must be a bounded emptyDir`,
  );
  assert.match(
    job,
    /readOnlyRootFilesystem: true/,
    `${label}: container root must remain read-only`,
  );
  assert.match(
    job,
    /image: "[^"]*\/alpine\/k8s:1\.32\.2"/,
    `${label}: runtime regression image must match the rendered credential image`,
  );
  assert.match(job, /runAsNonRoot: true/, `${label}: container must remain non-root`);
  assert.match(
    job,
    /allowPrivilegeEscalation: false/,
    `${label}: privilege escalation must remain disabled`,
  );
  assert.match(
    job,
    /capabilities:\s+drop:\s+- ALL/,
    `${label}: Linux capabilities must remain dropped`,
  );
  assert.equal(
    (job.match(/mountPath: \/tmp/g) ?? []).length,
    1,
    `${label}: credential Job must have exactly one /tmp mount`,
  );
  assert.doesNotMatch(job, /hostPath:/, `${label}: scratch must not use a host path`);
}

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const base = render();
const ordinaryUpgrade = upgrade([], '0.3.1');
const values = readFileSync(resolve(chart, 'values.yaml'), 'utf8');
const schema = readFileSync(resolve(chart, 'values.schema.json'), 'utf8');
const parsedSchema = JSON.parse(schema);
const validation = readFileSync(resolve(chart, 'templates/validate.yaml'), 'utf8');
const credentialScript = readFileSync(
  resolve(chart, 'files/webhook-database-credential-bootstrap.sh'),
  'utf8',
);
const authorityScript = readFileSync(
  resolve(chart, 'files/webhook-database-authority-bootstrap.sh'),
  'utf8',
);
const principalGateScript = readFileSync(
  resolve(chart, 'files/webhook-database-principal-gate.sh'),
  'utf8',
);
const authorityRunbook = readFileSync(
  resolve(chart, 'WEBHOOK-DATABASE-AUTHORITY.md'),
  'utf8',
);

check('values/schema expose only non-secret PostgreSQL references and fixed principal names', () => {
  assert.match(values, /webhookDatabase:\s+credentials:\s+create: true\s+secretName: in-falcone-webhook-database-credentials/);
  assert.match(values, /schema: falcone_webhook_schema/);
  assert.match(values, /runtime: falcone_webhook_runtime/);
  assert.match(values, /writer: falcone_webhook_writer/);
  assert.match(values, /lifecycle: falcone_webhook_lifecycle_login/);
  assert.match(values, /grantor: postgres/);
  assert.doesNotMatch(values, /WEBHOOK_(?:SCHEMA|RUNTIME|KEY_WRITE|KEY_LIFECYCLE)_DATABASE_PASSWORD\s*:/);
  assert.doesNotMatch(values, /postgresql:\/\/[^/\s]+:[^@\s]+@/);
  assert.match(schema, /"webhookDatabase"/);
  assert.match(schema, /"postgresqlRoleName"/);
  assert.match(schema, /"additionalProperties": false/);
  const migrationSchema = parsedSchema.properties.global.properties
    .webhookDatabase.properties.migration;
  assert.deepEqual(
    migrationSchema.required,
    ['firstHandoff', 'backupVerified', 'parityVerified', 'backupReference'],
  );
  assert.equal(migrationSchema.properties.backupVerified.type, 'boolean');
  assert.equal(migrationSchema.properties.parityVerified.type, 'boolean');
  assert.match(
    migrationSchema.properties.backupReference.pattern,
    /A-Za-z0-9/,
  );
});

check('fresh managed credential phase uses lookup, exact get/create RBAC, and no PostgreSQL credential', () => {
  const role = documentWith(
    base,
    'kind: Role',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  const job = documentWith(
    base,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  const template = readFileSync(
    resolve(chart, 'templates/webhook-database-credentials.yaml'),
    'utf8',
  );
  assert.match(template, /lookup "v1" "Secret"/);
  assert.match(role, /resourceNames: \["in-falcone-webhook-database-credentials"\]\s+verbs: \["get"\]/);
  assert.match(role, /resources: \["secrets"\]\s+verbs: \["create"\]/);
  assert.match(role, /resources: \["configmaps"\]\s+verbs: \["create"\]/);
  assert.doesNotMatch(role, /"update"|"patch"|"delete"|"list"|"watch"/);
  assert.match(job, /hook-weight": "-43"/);
  assert.doesNotMatch(job, /PGPASSWORD|POSTGRESQL_PASSWORD|DATABASE_URL\s+valueFrom/);
  assert.match(job, /WEBHOOK_DATABASE_CREDENTIAL_LOOKUP_FOUND/);
  assert.match(job, /WEBHOOK_DATABASE_CREDENTIAL_MARKER/);
  assertCredentialScratchPosture(base, 'fresh managed install');
});

check('Helm 4.1.4 later credential-Job failure cleans support and remains retry-safe', () => {
  const hooks = renderedHooks(base, 'webhook-database-credential');
  assert.deepEqual(
    hooks.map(({ kind, weight }) => [kind, weight]),
    [
      ['ConfigMap', -44],
      ['Role', -44],
      ['RoleBinding', -44],
      ['ServiceAccount', -44],
      ['Job', -43],
    ],
    'rendered scheduler order must place every support hook before the credential Job',
  );
  for (const hook of hooks) {
    assert.deepEqual(
      [...hook.policies],
      ['before-hook-creation', 'hook-succeeded'],
      `${hook.key} must keep the bounded Helm cleanup/retry policy`,
    );
  }

  const job = hooks.at(-1);
  const support = hooks.slice(0, -1);
  const failed = simulateHelmV414Hooks(hooks, { failKey: job.key });
  assert.deepEqual(
    [...failed.present],
    [job.key],
    'successful support hooks must be removed while the failed Job remains with its owned Pod',
  );
  for (const hook of support) {
    assert.ok(
      failed.events.includes(`hook-succeeded-removed:${hook.key}`),
      `${hook.key} must receive hook-succeeded cleanup after the later Job failure`,
    );
  }
  assert.ok(failed.events.includes(`failed:${job.key}`));

  const retried = simulateHelmV414Hooks(hooks, { initial: failed.present });
  for (const hook of support) {
    assert.ok(
      retried.events.includes(`before-hook-creation:${hook.key}:absent`)
      && retried.events.includes(`created:${hook.key}`),
      `${hook.key} must be recreated through the before-hook-creation retry lifecycle`,
    );
  }
  assert.ok(
    retried.events.includes(`before-hook-creation:${job.key}:removed`),
    'retry must remove the retained failed Job before recreating it',
  );
  assert.equal(retried.present.size, 0, 'successful retry must clean every temporary hook resource');
});

check('operator runbook covers every stable script-emitted or classified failure code', () => {
  // Extraction is deliberately limited to shell sites that can cross the
  // process boundary: fail invocations/defaults, explicit stderr printf calls,
  // and the authority script's allowlisted bootstrap_failure classifier.
  // Environment-variable names, SQL-only tokens, and success output therefore
  // cannot enter the operator failure-code contract accidentally.
  const sources = [
    ['credential', credentialScript],
    ['principal gate', principalGateScript],
    ['authority', authorityScript],
  ];
  const codes = new Set();
  for (const [label, source] of sources) {
    const extracted = stableFailureCodes(source);
    assert.ok(extracted.size > 0, `${label} script has no extracted failure output contract`);
    for (const code of extracted) {
      codes.add(code);
    }
  }
  assert.ok(codes.size >= 10, 'stable failure extraction unexpectedly collapsed');
  for (const code of [...codes].sort()) {
    assert.match(
      authorityRunbook,
      new RegExp(`\\\`${code}\\\``),
      `operator runbook omits stable failure code ${code}`,
    );
  }
});

check('ordinary upgrade cannot recreate the retained managed credential Secret', () => {
  const role = documentWith(
    ordinaryUpgrade,
    'kind: Role',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  const job = documentWith(
    ordinaryUpgrade,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  assert.doesNotMatch(role, /verbs: \["create"\]/);
  assert.match(job, /WEBHOOK_DATABASE_IS_UPGRADE\s+value: "true"/);
  assert.match(credentialScript, /retained marker prevents a missing Secret/);
  assert.match(credentialScript, /marker_exists && fail/);
  assert.match(credentialScript, /helm\.sh\/resource-policy/);
  assert.match(credentialScript, /\.immutable = true/);
  assert.doesNotMatch(credentialScript, /kubectl .* (apply|patch|replace|delete)/);
});

check('explicit backup-gated first handoff can create managed legacy credentials once', () => {
  const firstHandoff = upgrade([
    '--set', 'global.webhookDatabase.migration.firstHandoff=true',
  ], '0.3.1');
  const role = documentWith(
    firstHandoff,
    'kind: Role',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  const job = documentWith(
    firstHandoff,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  assert.match(role, /resources: \["secrets"\]\s+verbs: \["create"\]/);
  assert.match(role, /resources: \["configmaps"\]\s+verbs: \["create"\]/);
  assert.match(job, /WEBHOOK_DATABASE_FIRST_HANDOFF\s+value: "true"/);
  assert.match(job, /WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED\s+value: "true"/);
  assertCredentialScratchPosture(firstHandoff, 'backup-gated first handoff');
});

check('external bounded credential mode is exact-name read-only and validates exact keys', () => {
  const external = render([
    '--set', 'global.webhookDatabase.credentials.create=false',
  ]);
  const role = documentWith(
    external,
    'kind: Role',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  assert.match(role, /resourceNames: \["in-falcone-webhook-database-credentials"\]/);
  assert.doesNotMatch(role, /"create"|"update"|"patch"|"delete"|"list"|"watch"/);
  assert.match(credentialScript, /\[ "\$key_count" = "8" \]/);
  for (const key of [
    'WEBHOOK_SCHEMA_DATABASE_PASSWORD',
    'WEBHOOK_RUNTIME_DATABASE_PASSWORD',
    'WEBHOOK_KEY_WRITE_DATABASE_PASSWORD',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD',
    'WEBHOOK_SCHEMA_DATABASE_URL',
    'WEBHOOK_RUNTIME_DATABASE_URL',
    'WEBHOOK_KEY_WRITE_DATABASE_URL',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_URL',
  ]) {
    assert.match(credentialScript, new RegExp(key));
  }
});

check('fresh authority bootstrap is a regular one-shot Job and upgrade is ordered pre-upgrade', () => {
  const fresh = documentWith(
    base,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  const upgraded = documentWith(
    upgrade(),
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  assert.ok(fresh);
  assert.doesNotMatch(fresh, /helm\.sh\/hook/);
  assert.match(upgraded, /helm\.sh\/hook: pre-upgrade/);
  assert.match(upgraded, /helm\.sh\/hook-weight: "-40"/);
  assert.match(upgraded, /serviceAccountName: falcone-in-falcone-webhook-db-authority/);
  assert.match(upgraded, /automountServiceAccountToken: false/);
});

check('authority bootstrap alone receives administrator and all bounded credentials', () => {
  const authority = documentWith(
    base,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  assert.match(authority, /key: POSTGRESQL_POSTGRES_PASSWORD\s+optional: false/);
  assert.match(authority, /name: WEBHOOK_DATABASE_BOOTSTRAP_MODE\s+value: apply/);
  for (const key of [
    'WEBHOOK_SCHEMA_DATABASE_PASSWORD',
    'WEBHOOK_RUNTIME_DATABASE_PASSWORD',
    'WEBHOOK_KEY_WRITE_DATABASE_PASSWORD',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD',
    'WEBHOOK_SCHEMA_DATABASE_URL',
    'WEBHOOK_RUNTIME_DATABASE_URL',
    'WEBHOOK_KEY_WRITE_DATABASE_URL',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_URL',
  ]) {
    assert.match(authority, new RegExp(`key: ${key}\\s+optional: false`));
  }
  assert.doesNotMatch(authority, /WEBHOOK_SIGNING_KEY/);
  assert.doesNotMatch(authority, /automountServiceAccountToken: true/);
  assert.match(authority, /name: tmp\s+mountPath: \/tmp/);
  assert.match(authority, /name: tmp\s+emptyDir:\s+sizeLimit: 1Mi/);
  assert.match(authority, /readOnlyRootFilesystem: true/);
});

check('control plane preserves global PG wiring and adds four DSNs plus five names', () => {
  const deployment = documentWith(base, 'kind: Deployment', 'name: falcone-control-plane');
  for (const globalName of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGPASSWORD']) {
    assert.match(deployment, new RegExp(`name: ${globalName}`));
  }
  for (const dsn of [
    'WEBHOOK_SCHEMA_DATABASE_URL',
    'WEBHOOK_RUNTIME_DATABASE_URL',
    'WEBHOOK_KEY_WRITE_DATABASE_URL',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_URL',
  ]) {
    assert.match(
      deployment,
      new RegExp(`name: ${dsn}\\s+valueFrom:\\s+secretKeyRef:\\s+name: "in-falcone-webhook-database-credentials"\\s+key: ${dsn}\\s+optional: false`),
    );
  }
  for (const name of [
    'WEBHOOK_SCHEMA_DATABASE_ROLE',
    'WEBHOOK_RUNTIME_DATABASE_ROLE',
    'WEBHOOK_KEY_WRITE_DATABASE_ROLE',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE',
    'WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE',
  ]) {
    assert.equal((deployment.match(new RegExp(`name: ${name}`, 'g')) ?? []).length, 2);
  }
  assert.doesNotMatch(deployment, /key: POSTGRESQL_POSTGRES_PASSWORD/);
});

check('control-plane init gate is bounded, PostgreSQL 16 pinned, and administrator-free', () => {
  const deployment = documentWith(base, 'kind: Deployment', 'name: falcone-control-plane');
  const init = deployment.match(/- name: webhook-database-principal-gate[\s\S]*?\n      containers:/)?.[0];
  assert.ok(init);
  assert.match(init, /image: "docker\.io\/library\/postgres:16\.14-alpine"/);
  assert.match(init, /key: WEBHOOK_SCHEMA_DATABASE_PASSWORD\s+optional: false/);
  assert.match(init, /name: PGUSER\s+value: "falcone_webhook_schema"/);
  assert.doesNotMatch(init, /POSTGRESQL_POSTGRES_PASSWORD|WEBHOOK_RUNTIME_DATABASE_PASSWORD|WEBHOOK_KEY_WRITE_DATABASE_PASSWORD|WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD/);
  assert.match(init, /webhook-database-principal-gate[\s\S]*readOnly: true/);
});

check('lifecycle receives only schema/lifecycle DSNs, five names, and no administrator/global database credential', () => {
  const lifecycleRender = upgrade([
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=db-role-rotate-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=db-role-rotation-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const lifecycle = documentWith(
    lifecycleRender,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-lifecycle',
  );
  assert.match(lifecycle, /name: WEBHOOK_SCHEMA_DATABASE_URL/);
  assert.match(lifecycle, /name: WEBHOOK_KEY_LIFECYCLE_DATABASE_URL/);
  assert.doesNotMatch(lifecycle, /name: WEBHOOK_RUNTIME_DATABASE_URL|name: WEBHOOK_KEY_WRITE_DATABASE_URL/);
  assert.doesNotMatch(lifecycle, /name: PGPASSWORD|POSTGRESQL_POSTGRES_PASSWORD|POSTGRESQL_PASSWORD/);
  for (const name of [
    'WEBHOOK_SCHEMA_DATABASE_ROLE',
    'WEBHOOK_RUNTIME_DATABASE_ROLE',
    'WEBHOOK_KEY_WRITE_DATABASE_ROLE',
    'WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE',
    'WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE',
  ]) {
    assert.match(lifecycle, new RegExp(`name: ${name}`));
  }
});

check('bootstrap script enforces exact PostgreSQL 16 graph and bounded role flags', () => {
  assert.match(authorityScript, /server_version_num'\)::integer < 160000/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_BOOTSTRAP_MODE:-verify/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_BOOTSTRAP_VERIFIED/);
  assert.match(authorityScript, /NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(authorityScript, /NOREPLICATION NOBYPASSRLS/);
  assert.match(authorityScript, /actual\.rolinherit <> expected\.inherit_role/);
  assert.match(authorityScript, /WITH ADMIN %s, INHERIT %s, SET %s GRANTED BY %I/);
  assert.match(authorityScript, /false, true, false/);
  assert.match(authorityScript, /false, false, true/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_MEMBERSHIP_AMBIGUOUS/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_MEMBERSHIP_DRIFT/);
  assert.match(
    authorityScript,
    /GRANT USAGE, CREATE ON SCHEMA public TO %I GRANTED BY %I/,
  );
  assert.match(authorityScript, /WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_GRANTOR_DRIFT/);
  const preflightProbe = authorityScript.indexOf(
    'if role_exists "$WEBHOOK_SCHEMA_DATABASE_ROLE"',
  );
  const transaction = authorityScript.indexOf('BEGIN;');
  assert.ok(preflightProbe > 0 && preflightProbe < transaction);
  assert.match(authorityScript, /session_user = current_user/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_BOUNDED_CREDENTIAL_INVALID/);
  assert.doesNotMatch(authorityScript, /REASSIGN OWNED|ALTER DEFAULT PRIVILEGES|GRANT ALL/i);
});

check('ownership handoff is six-table/three-function exact and inventory-complete', () => {
  for (const object of [
    'webhook_subscriptions',
    'webhook_signing_secrets',
    'webhook_deliveries',
    'webhook_delivery_attempts',
    'webhook_master_key_state',
    'webhook_master_key_rotations',
    'falcone_webhook_key_write_current_id',
    'falcone_webhook_signing_secret_write_statement_fence',
    'falcone_webhook_signing_secret_write_fence',
  ]) {
    assert.match(authorityScript, new RegExp(object.replace(/[()]/g, '\\$&')));
  }
  assert.match(authorityScript, /WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT/);
  assert.match(authorityScript, /WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT/);
  assert.match(authorityScript, /FROM pg_shdepend ownership/);
  assert.match(authorityScript, /'pg_type'::regclass/);
  assert.match(authorityScript, /row_type\.typarray/);
  assert.match(authorityScript, /owner_name = current_setting\('falcone\.bootstrap\.global_role'\)/);
  assert.match(authorityScript, /owner_name <> current_setting\('falcone\.bootstrap\.schema_role'\)/);
  assert.doesNotMatch(authorityScript, /'sequence',\s*'webhook_/);
  assert.doesNotMatch(authorityScript, /ALTER SEQUENCE/);
});

check('every applying upgrade fails without non-secret backup/parity proof', () => {
  const failed = helm([
    'template', 'falcone', chart,
    '--namespace', 'falcone-test',
    '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.0',
  ], { fail: true });
  assert.match(failed.stderr, /requires backupVerified, parityVerified, and a non-secret backupReference/);
  assert.doesNotMatch(failed.stderr, /postgresql:\/\//);
  assert.match(
    validation,
    /\$requiresWebhookDatabaseBackup := \.Release\.IsUpgrade/,
  );

  const ordinary031 = helm([
    'template', 'falcone', chart,
    '--namespace', 'falcone-test',
    '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.1',
  ], { fail: true });
  assert.match(
    ordinary031.stderr,
    /before every applying upgrade, including no-op authority replay/,
  );

  const explicit = helm([
    'template', 'falcone', chart,
    '--namespace', 'falcone-test',
    '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.1',
    '--set', 'global.webhookDatabase.migration.firstHandoff=true',
  ], { fail: true });
  assert.match(explicit.stderr, /requires backupVerified, parityVerified, and a non-secret backupReference/);

  const install = helm([
    'template', 'falcone', chart,
    '--namespace', 'falcone-test',
    '--set', 'global.webhookDatabase.migration.firstHandoff=true',
  ], { fail: true });
  assert.match(install.stderr, /firstHandoff is upgrade-only/);
});

check('gated ordinary 0.3.1 replay renders the applying authority Job read-only outside it', () => {
  const authority = documentWith(
    ordinaryUpgrade,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  const credentialRole = documentWith(
    ordinaryUpgrade,
    'kind: Role',
    'app.kubernetes.io/component: webhook-database-credential',
  );
  assert.match(authority, /WEBHOOK_DATABASE_BOOTSTRAP_MODE\s+value: apply/);
  assert.doesNotMatch(credentialRole, /verbs: \["create"\]/);
  assert.match(
    values,
    /Every Helm upgrade runs the applying authority Job/,
  );
});

check('duplicate/reserved principal inputs fail closed without a manifest', () => {
  const duplicate = helm([
    'template', 'falcone', chart, '--namespace', 'falcone-test',
    '--set', 'global.webhookDatabase.principals.writer=falcone_webhook_runtime',
  ], { fail: true });
  assert.match(duplicate.stderr, /principal and fixed authority role names must all be distinct/);

  const grantor = helm([
    'template', 'falcone', chart, '--namespace', 'falcone-test',
    '--set', 'global.webhookDatabase.principals.grantor=another_admin',
  ], { fail: true });
  assert.match(grantor.stderr, /grantor must equal the durable PostgreSQL administrator role/);

  helm([
    'template', 'falcone', chart, '--namespace', 'falcone-test',
    '--set-json',
    'controlPlane.env=[{"name":"WEBHOOK_RUNTIME_DATABASE_URL","value":"must-not-render"}]',
  ], { fail: true });
});

check('hardened renders apply verify-full and the read-only CA only to database users', () => {
  const hardened = upgrade([
    '-f', 'deploy/kind/values-kind.yaml',
    '-f', 'deploy/kind/values-production.yaml',
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2-db-tls',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=db-tls-rotate-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=db-tls-rotation-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const authority = documentWith(
    hardened,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  const lifecycle = documentWith(
    hardened,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-lifecycle',
  );
  const deployment = documentWith(hardened, 'kind: Deployment', 'name: falcone-control-plane');
  for (const workload of [authority, lifecycle, deployment]) {
    assert.match(workload, /name: PGSSLMODE\s+value: verify-full/);
    assert.match(workload, /name: PGSSLROOTCERT\s+value: \/etc\/falcone\/tls\/ca\.crt/);
    assert.match(workload, /name: falcone-transport-ca[\s\S]*readOnly: true/);
  }
  for (const component of ['webhook-database-credential', 'webhook-key-credential']) {
    const job = documentWith(hardened, 'kind: Job', `app.kubernetes.io/component: ${component}`);
    assert.doesNotMatch(job, /PGSSLMODE|PGSSLROOTCERT|falcone-transport-ca/);
  }
  assert.doesNotMatch(authority, /MONGO_TLS|KAFKA_SSL|NODE_EXTRA_CA_CERTS/);
  assert.doesNotMatch(lifecycle, /MONGO_TLS|KAFKA_SSL|NODE_EXTRA_CA_CERTS/);
});

check('invalid hardened CA paths and modes fail before rendering', () => {
  for (const extra of [
    ['--set', 'global.transportSecurity.enabled=true'],
    [
      '-f', 'deploy/kind/values-production.yaml',
      '--set', 'global.transportSecurity.env[0].value=require',
    ],
    [
      '-f', 'deploy/kind/values-production.yaml',
      '--set', 'global.transportSecurity.env[1].value=/tmp/../ca.crt',
    ],
  ]) {
    helm([
      'template', 'falcone', chart, '--namespace', 'falcone-test', ...extra,
    ], { fail: true });
  }
});

check('Kubernetes/OpenShift renders retain restricted contexts and registry rewriting', () => {
  const kubernetes = render(['-f', 'deploy/kind/values-kind.yaml']);
  const openshift = render(['-f', 'deploy/openshift/values-openshift.yaml']);
  for (const rendered of [kubernetes, openshift]) {
    for (const component of [
      'webhook-database-credential',
      'webhook-database-authority-bootstrap',
    ]) {
      const job = documentWith(rendered, 'kind: Job', `app.kubernetes.io/component: ${component}`);
      assert.match(job, /allowPrivilegeEscalation: false/);
      assert.match(job, /capabilities:\s+drop:\s+- ALL/);
      assert.match(job, /seccompProfile:\s+type: RuntimeDefault/);
    }
  }
  const openshiftAuthority = documentWith(
    openshift,
    'kind: Job',
    'app.kubernetes.io/component: webhook-database-authority-bootstrap',
  );
  assertCredentialScratchPosture(kubernetes, 'Kubernetes profile');
  assertCredentialScratchPosture(openshift, 'OpenShift profile');
  assert.doesNotMatch(openshiftAuthority, /runAsUser:|runAsGroup:/);
  assert.match(openshiftAuthority, /image: "harbor\.example\.com\/falcone\/library\/postgres:16\.14-alpine"/);
});

check('rendered non-Secret surfaces contain references, not credential payloads', () => {
  for (const rendered of [base, ordinaryUpgrade]) {
    assert.doesNotMatch(rendered, /v1:[A-Za-z0-9_-]{43}/);
    assert.doesNotMatch(rendered, /postgresql:\/\/[A-Za-z_][A-Za-z0-9_$-]*:[A-Za-z0-9._~-]{32,128}@/);
    assert.doesNotMatch(rendered, /DATABASE_PASSWORD\s+value:\s+["'][^"']+/);
  }
  const notes = readFileSync(resolve(chart, 'templates/NOTES.txt'), 'utf8');
  assert.match(notes, /Webhook PostgreSQL authority:/);
  assert.doesNotMatch(notes, /DATABASE_PASSWORD|postgresql:\/\//);
});

process.stdout.write(`1..${passed}\n`);
