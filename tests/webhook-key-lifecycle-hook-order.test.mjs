// gntik-ai/falcone-charts#11 — a failed upgrade must not leave falcone-control-plane at 0 replicas.
//
// The webhook-key-lifecycle Job scales the control plane to 0 and, on success, deliberately
// leaves it there: webhook-key-lifecycle-cli.mjs returns workloadAction=apply-target and lets
// Helm's main upgrade apply restore .Values.controlPlane.replicas. Its restore() closure runs
// only in the CLI's own catch block, so it covers the Job failing and nothing else.
//
// That makes the quiesce safe only while nothing can fail between it and the main apply. Helm
// has no failure hook and does not run post-upgrade when a pre-upgrade hook fails, so any
// pre-upgrade hook sorting after the quiesce converts its own failure into an unbounded
// control-plane outage. At weight -35 five Jobs sorted after it; eso-preflight and
// falcone-temporal-schema each did exactly this on in-falcone-staging during 0.3.1 -> 0.4.1.
//
// This suite pins the invariant rather than the number: the quiesce sorts strictly after every
// other pre-upgrade hook the chart and its sub-charts render, so a hook added later cannot
// silently re-open the window.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chart = resolve(root, 'charts/in-falcone');
const upgradeProof = [
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set', 'global.webhookDatabase.migration.backupReference=c25-test-backup',
];
const LIFECYCLE = 'app.kubernetes.io/component: webhook-key-lifecycle';
let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function upgrade(extra = []) {
  const args = [
    'template', 'falcone', chart, '--namespace', 'falcone-test', '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.0',
    ...upgradeProof, ...extra,
  ];
  const result = spawnSync('helm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Every pre-upgrade hook resource in a render, with the weight Helm sorts it by.
// Helm defaults an absent weight to 0, and a hook may declare several events.
function preUpgradeHooks(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((doc) => {
      const events = /helm\.sh\/hook"?\s*:\s*"?([a-z,-]+)"?/.exec(doc);
      if (!events || !events[1].split(',').includes('pre-upgrade')) return null;
      const weight = /helm\.sh\/hook-weight"?\s*:\s*"?(-?\d+)"?/.exec(doc);
      const kind = /^kind:\s*(\S+)/m.exec(doc);
      const name = /^ {2}name:\s*(\S+)/m.exec(doc);
      return {
        weight: weight ? Number(weight[1]) : 0,
        kind: kind ? kind[1] : '(unknown kind)',
        name: name ? name[1] : '(unknown name)',
        isQuiesce: doc.includes(LIFECYCLE) && kind?.[1] === 'Job',
        isQuiesceRbac: doc.includes(LIFECYCLE) && kind?.[1] !== 'Job',
      };
    })
    .filter(Boolean);
}

function describe(hooks) {
  return hooks.map((h) => `${h.weight} ${h.kind}/${h.name}`).join(', ');
}

// The four ways a release asks for key lifecycle work — the only renders that emit the quiesce.
const lifecycleScenarios = [
  {
    label: 'legacy adoption',
    args: [
      '--set', 'global.webhookSigningKey.create=false',
      '--set', 'global.webhookSigningKey.secretName=legacy-webhook-key',
      '--set', 'global.webhookSigningKey.adoption.mode=legacy',
      '--set', 'global.webhookSigningKey.adoption.requestId=adopt-001',
    ],
  },
  {
    label: 'rotate',
    args: [
      '--set', 'global.webhookSigningKey.rotation.action=rotate',
      '--set', 'global.webhookSigningKey.rotation.requestId=rotate-001',
      '--set', 'global.webhookSigningKey.rotation.rotationId=rot-001',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v0',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
    ],
  },
  {
    label: 'recover',
    args: [
      '--set', 'global.webhookSigningKey.create=false',
      '--set', 'global.webhookSigningKey.rotation.action=recover',
      '--set', 'global.webhookSigningKey.rotation.requestId=recover-001',
      '--set', 'global.webhookSigningKey.rotation.rotationId=rot-001',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v0',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
    ],
  },
  {
    label: 'finalize',
    args: [
      '--set', 'global.webhookSigningKey.create=false',
      '--set', 'global.webhookSigningKey.rotation.action=finalize',
      '--set', 'global.webhookSigningKey.rotation.requestId=finalize-001',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v0',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
    ],
  },
];

const renders = lifecycleScenarios.map((scenario) => ({
  ...scenario,
  hooks: preUpgradeHooks(upgrade(scenario.args)),
}));

check('every key lifecycle action renders exactly one quiesce Job', () => {
  for (const { label, hooks } of renders) {
    const quiesce = hooks.filter((h) => h.isQuiesce);
    assert.equal(quiesce.length, 1, `${label} must render exactly one webhook-key-lifecycle Job`);
    assert.equal(
      quiesce[0].name, 'falcone-in-falcone-webhook-key-lifecycle',
      `${label} must keep the quiesce Job name stable`,
    );
  }
});

check('no pre-upgrade hook sorts after the quiesce — nothing can fail before the restoring apply', () => {
  for (const { label, hooks } of renders) {
    const quiesce = hooks.find((h) => h.isQuiesce);
    const after = hooks.filter((h) => !h.isQuiesce && h.weight >= quiesce.weight);
    assert.deepEqual(
      after, [],
      `${label}: these pre-upgrade hooks sort at or after the quiesce (weight ${quiesce.weight}), `
      + 'so their failure would strand falcone-control-plane at 0 replicas with no restore path — '
      + `raise the webhook-key-lifecycle hook-weight above them: ${describe(after)}`,
    );
  }
});

check('the quiesce RBAC still sorts before the Job that uses it', () => {
  for (const { label, hooks } of renders) {
    const quiesce = hooks.find((h) => h.isQuiesce);
    const rbac = hooks.filter((h) => h.isQuiesceRbac);
    assert.equal(rbac.length, 3, `${label} must render the lifecycle ServiceAccount, Role and RoleBinding`);
    for (const resource of rbac) {
      assert.ok(
        resource.weight < quiesce.weight,
        `${label}: ${resource.kind}/${resource.name} (weight ${resource.weight}) must sort before `
        + `the quiesce Job (weight ${quiesce.weight}) so the Job has its ServiceAccount and Role`,
      );
    }
  }
});

check('the credential and database prerequisites still sort before the quiesce', () => {
  // These produce the Secrets the quiesce Job mounts; moving the quiesce later must not
  // have reordered them past it.
  for (const { label, hooks } of renders) {
    const quiesce = hooks.find((h) => h.isQuiesce);
    for (const prerequisite of ['webhook-key-credential', 'webhook-db-credential']) {
      const job = hooks.find((h) => h.kind === 'Job' && h.name.includes(prerequisite));
      assert.ok(job, `${label} must render the ${prerequisite} Job`);
      assert.ok(
        job.weight < quiesce.weight,
        `${label}: ${prerequisite} (weight ${job.weight}) must still precede the quiesce`,
      );
    }
  }
});

check('the quiesce is still a pre-upgrade hook holding scale-only Deployment RBAC', () => {
  // Guards against "fixing" the outage by deleting the maintenance window instead of ordering it.
  const rendered = upgrade(lifecycleScenarios[0].args);
  const role = rendered
    .split(/^---\s*$/m)
    .find((doc) => doc.includes('kind: Role') && doc.includes(LIFECYCLE));
  assert.ok(role, 'legacy adoption must render the lifecycle Role');
  assert.match(
    role,
    /resources: \["deployments\/scale"\]\n(?:\s+resourceNames: [^\n]+\n)?\s+verbs: \["patch"\]/,
    'the lifecycle Role must still grant scale patch on the control plane',
  );
  assert.doesNotMatch(
    role,
    /resources: \["deployments"\]\n(?:\s+resourceNames: [^\n]+\n)?\s+verbs: \[[^\]]*"(?:patch|update)"/,
    'the lifecycle Role must not gain full Deployment write access',
  );
});

check('an upgrade with no key lifecycle work renders no quiesce at all', () => {
  // Why moving the quiesce behind the other hooks adds no new exposure: on every ordinary
  // release those hooks already run with the control plane up.
  const hooks = preUpgradeHooks(upgrade());
  assert.deepEqual(
    hooks.filter((h) => h.isQuiesce || h.isQuiesceRbac), [],
    'an upgrade without adoption or rotation must not quiesce the control plane',
  );
  assert.ok(
    hooks.some((h) => h.kind === 'Job'),
    'the ordinary upgrade path must still render its pre-upgrade Jobs',
  );
});

process.stdout.write(`1..${passed}\n`);
