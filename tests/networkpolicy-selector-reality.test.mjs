// gntik-ai/falcone-charts#20 — a NetworkPolicy selector that matches no pod is not a policy.
//
// The Temporal frontend policy admitted `app.kubernetes.io/component: flows-api`, a label no pod
// any chart artifact produces has ever carried. The component that actually starts workflows,
// control-plane-executor, was therefore denied: every flow execution failed 503
// TEMPORAL_UNAVAILABLE and zero workflows ever ran. The template even predicted it in a comment
// ("flows traffic to Temporal will be silently blocked") — a comment nothing enforced.
//
// The failure is silent in both directions, which is what makes it worth an executable invariant:
//
//   * an ALLOW-LIST entry that matches nothing quietly denies a component that needs access;
//   * a POLICY TARGET that matches nothing quietly protects nothing, while still satisfying any
//     audit that greps for the existence of a policy.
//
// Both are checked here, against the pods the chart actually renders, in every values profile
// shipped in this repo. Compare gntik-ai/falcone#972, where the obvious fix — a podSelector on
// `in-falcone.function=true` — selects zero pods, because that label sits on the Knative Service
// rather than on its pod template.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chart = resolve(root, 'charts/in-falcone');
let passed = 0;

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

// Same decoding path the black-box fixtures use — helm output is real YAML, and selector
// comparison needs structure rather than string matching.
function yamlDocuments(text) {
  const script = [
    'import json, sys, yaml',
    'docs = [d for d in yaml.safe_load_all(sys.stdin.read()) if d is not None]',
    'json.dump(docs, sys.stdout, default=str)',
  ].join('; ');
  return JSON.parse(run('python3', ['-c', script], { input: text }));
}

// Every values profile this repo ships. A selector must resolve in the profile that renders it —
// "it resolves in some other profile" is exactly how #20 survived: tests/e2e stamps `flows-api`
// on its control plane, so the only suite exercising the path patched the label instead of
// catching the bug.
const PROFILES = [
  { label: 'chart defaults', args: [] },
  { label: 'staging', args: ['-f', 'charts/in-falcone/values/staging.yaml'] },
  { label: 'prod', args: ['-f', 'charts/in-falcone/values/prod.yaml'] },
  { label: 'kind', args: ['-f', 'deploy/kind/values-kind.yaml'] },
  // The flows e2e stack lives in the falcone repo (tests/e2e/stack.sh) and renders this file with
  // --skip-schema-validation, because global.environment: e2e is outside the chart's enum. Match
  // how it is actually deployed rather than skipping the profile that hid #20.
  { label: 'flows e2e', args: ['-f', 'tests/e2e/values-flows-e2e.yaml', '--skip-schema-validation'] },
];

// Selectors whose pods are created at runtime rather than by this chart. An entry is only
// legitimate if the label is pinned on the POD TEMPLATE by code, with a test asserting it —
// putting it on the parent object instead is the #972 trap this suite exists to catch. Keep this
// list minimal; the final check fails if an entry stops being needed.
const RUNTIME_CREATED = [
  {
    labels: { 'in-falcone.io/component': 'mcp-server' },
    why: 'Hosted MCP servers are Knative Services the control plane creates per tenant at runtime, so no chart artifact renders one.',
    guaranteedBy:
      'apps/control-plane-executor/src/mcp-custom-hosting.mjs sets it on spec.template.metadata.labels '
      + '(the pod template, not just the Service), asserted by mcp-custom-hosting.test.mjs '
      + '"pod label for NetworkPolicy".',
  },
];

function sameLabels(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

function exemptionFor(labels) {
  return RUNTIME_CREATED.find((entry) => sameLabels(entry.labels, labels));
}

// Label sets carried by pods this render actually creates.
function podTemplateLabels(objects) {
  const templates = [];
  for (const object of objects) {
    const kind = object?.kind;
    let template = null;
    if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job'].includes(kind)) {
      template = object?.spec?.template;
    } else if (kind === 'CronJob') {
      template = object?.spec?.jobTemplate?.spec?.template;
    } else if (kind === 'Service' && String(object?.apiVersion ?? '').startsWith('serving.knative.dev/')) {
      // Knative Services rendered by the chart: the pod labels are on spec.template, and a label
      // present only on the Service object would not be on the pod. See #972.
      template = object?.spec?.template;
    }
    if (!template) continue;
    const labels = { ...(template.metadata?.labels ?? {}) };
    if (kind === 'Job') {
      // Injected by the Job controller, so they are real pod labels a policy may select even
      // though the rendered template does not spell them out.
      const name = object?.metadata?.name;
      labels['job-name'] ??= name;
      labels['batch.kubernetes.io/job-name'] ??= name;
    }
    templates.push({ kind, name: object?.metadata?.name, labels });
  }
  return templates;
}

function matching(templates, selector) {
  return templates.filter(({ labels }) => Object.entries(selector).every(([k, v]) => labels[k] === v));
}

// Every selector in the render that is supposed to name pods from this chart.
function selectorSites(objects) {
  const sites = [];
  for (const object of objects) {
    if (object?.kind !== 'NetworkPolicy') continue;
    const policy = object?.metadata?.name;
    const target = object?.spec?.podSelector?.matchLabels;
    // An empty podSelector selects every pod in the namespace, which always resolves.
    if (target && Object.keys(target).length) {
      sites.push({ policy, role: 'target', selector: target });
    }
    for (const direction of ['ingress', 'egress']) {
      for (const rule of object?.spec?.[direction] ?? []) {
        for (const peer of rule?.from ?? rule?.to ?? []) {
          // A peer paired with a namespaceSelector names pods in another namespace, which this
          // render cannot see. Only same-namespace peers are verifiable here.
          if (peer?.namespaceSelector !== undefined) continue;
          const labels = peer?.podSelector?.matchLabels;
          if (!labels || !Object.keys(labels).length) continue;
          sites.push({ policy, role: direction, selector: labels });
        }
      }
    }
  }
  return sites;
}

const renders = PROFILES.map((profile) => {
  const objects = yamlDocuments(
    run('helm', ['template', 'falcone', chart, '--namespace', 'falcone-test', ...profile.args]),
  );
  return { ...profile, templates: podTemplateLabels(objects), sites: selectorSites(objects) };
});

const used = new Set();

check('every values profile renders NetworkPolicies and pods to check', () => {
  for (const { label, sites, templates } of renders) {
    assert.ok(sites.length, `${label} rendered no NetworkPolicy selectors — the suite would pass vacuously`);
    assert.ok(templates.length, `${label} rendered no pod templates`);
  }
});

check('no NetworkPolicy selector matches zero rendered pods', () => {
  const failures = [];
  for (const { label, sites, templates } of renders) {
    for (const site of sites) {
      if (matching(templates, site.selector).length) continue;
      const exemption = exemptionFor(site.selector);
      if (exemption) { used.add(exemption); continue; }
      failures.push(
        `  [${label}] ${site.policy} (${site.role}) selects ${JSON.stringify(site.selector)} — no rendered pod carries it.`
        + (site.role === 'target'
          ? ' A policy target that matches nothing protects nothing while still looking present to an audit.'
          : ' An allow-list entry that matches nothing silently denies the component it was meant to admit.'),
      );
    }
  }
  assert.deepEqual(
    failures, [],
    'NetworkPolicy selectors that match no pod this chart renders:\n'
    + `${failures.join('\n')}\n`
    + 'Fix the selector to name a component the chart actually renders, or — only if the pods are '
    + 'created at runtime — add a RUNTIME_CREATED entry naming the code that pins the label on the '
    + 'POD TEMPLATE and the test that asserts it.',
  );
});

check('the Temporal frontend admits the component that starts workflows', () => {
  // The #20 regression by name, not only by the generic invariant above: control-plane-executor is
  // the only component that builds a Temporal client (apps/control-plane-executor), so if it is
  // denied, no workflow can ever start.
  for (const { label, sites, templates } of renders) {
    const frontend = sites.filter((s) => s.policy.includes('temporal-frontend') && s.role === 'ingress');
    if (!frontend.length) continue;
    const executors = templates.filter(({ name }) => name?.endsWith('control-plane-executor'));
    if (!executors.length) continue;  // topologies without a separate executor, e.g. flows e2e
    const admitted = executors.every(({ labels }) => frontend.some(
      ({ selector }) => Object.entries(selector).every(([k, v]) => labels[k] === v),
    ));
    assert.ok(
      admitted,
      `${label}: control-plane-executor is not admitted to the Temporal frontend. `
      + `Its pod labels are ${JSON.stringify(executors[0].labels)}; the policy admits `
      + `${JSON.stringify(frontend.map((s) => s.selector))}. Every flow execution would fail 503 `
      + 'TEMPORAL_UNAVAILABLE (gntik-ai/falcone-charts#20, gntik-ai/falcone#997).',
    );
  }
});

check('every runtime-created exemption is still needed', () => {
  // A stale exemption is a hole: it would silently absorb a real zero-pod selector later.
  const stale = RUNTIME_CREATED.filter((entry) => !used.has(entry));
  assert.deepEqual(
    stale.map((entry) => entry.labels), [],
    'RUNTIME_CREATED entries that no longer match any unresolved selector — remove them, '
    + 'they can only mask a future defect',
  );
  for (const entry of RUNTIME_CREATED) {
    assert.ok(entry.why?.length > 20, `exemption ${JSON.stringify(entry.labels)} needs a justification`);
    assert.match(
      entry.guaranteedBy ?? '',
      /pod template|spec\.template/i,
      `exemption ${JSON.stringify(entry.labels)} must name where the label is pinned on the POD TEMPLATE`,
    );
  }
});

process.stdout.write(`1..${passed}\n`);
