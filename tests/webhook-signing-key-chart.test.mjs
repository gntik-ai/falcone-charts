import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const chart = resolve(root, 'charts/in-falcone');
const upgradeProof = [
  '--set', 'global.webhookDatabase.migration.backupVerified=true',
  '--set', 'global.webhookDatabase.migration.parityVerified=true',
  '--set', 'global.webhookDatabase.migration.backupReference=c25-test-backup',
];
const controlPlaneDigest =
  'sha256:a6f90cd0c3e6e5ee5e783bba1d9fbce3c03be10590c85753cde3339fbcd4ad1d';
const seaweedfsDigest =
  'sha256:f0b358973e81f884304737645dd3b278c590c2c9d47d60089729d46324f70495';
const pinnedControlPlaneImagePattern = new RegExp(
  `image: "[^"]*in-falcone-control-plane@${controlPlaneDigest}"`,
);
let passed = 0;

function helm(args, { fail = false } = {}) {
  const result = spawnSync('helm', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (fail) assert.notEqual(result.status, 0, `expected helm to reject ${args.join(' ')}`);
  else assert.equal(result.status, 0, result.stderr);
  return `${result.stdout}\n${result.stderr}`;
}

function rejectRender(args, { label, suppliedValue }) {
  const result = spawnSync(
    'helm',
    ['template', 'falcone', chart, '--namespace', 'falcone-test', ...args],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  assert.notEqual(result.status, 0, `${label} must fail template rendering`);
  assert.equal(result.stdout, '', `${label} must not produce a partial manifest`);
  assert.match(
    result.stderr,
    /must not define reserved WEBHOOK_SIGNING_KEY; configure global\.webhookSigningKey Secret references only/,
    `${label} must return the bounded reserved-key error`,
  );
  assert.doesNotMatch(
    result.stderr,
    new RegExp(suppliedValue),
    `${label} must not echo the supplied value`,
  );
  assert.ok(result.stderr.length < 1024, `${label} must return a bounded error`);
}

function render(extra = []) {
  return helm(['template', 'falcone', chart, '--namespace', 'falcone-test', ...extra]);
}

function upgradeFrom(currentVersion, extra = []) {
  return render([
    '--is-upgrade',
    '--set', `deployment.upgrade.currentVersion=${currentVersion}`,
    ...upgradeProof,
    ...extra,
  ]);
}

function upgrade(extra = []) {
  return upgradeFrom('0.3.0', extra);
}

function documents(yaml) {
  return yaml.split(/^---\s*$/m);
}

function documentWith(yaml, ...needles) {
  return documents(yaml).find((doc) => needles.every((needle) => doc.includes(needle)));
}

function rbacRules(role) {
  return [...role.matchAll(
    /^  - apiGroups: (\[[^\n]+\])\n    resources: (\[[^\n]+\])(?:\n    resourceNames: (\[[^\n]+\]))?\n    verbs: (\[[^\n]+\])/gm,
  )].map((match) => ({
    apiGroups: JSON.parse(match[1]),
    resources: JSON.parse(match[2]),
    resourceNames: match[3] ? JSON.parse(match[3]) : null,
    verbs: JSON.parse(match[4]),
  }));
}

function assertLifecycleDeploymentRbac(rendered, label) {
  const role = documentWith(rendered, 'kind: Role', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.ok(role, `${label} must render the lifecycle Role`);
  const rules = rbacRules(role);
  const deploymentRules = rules.filter((rule) => rule.apiGroups.includes('apps'));

  assert.deepEqual(deploymentRules, [
    {
      apiGroups: ['apps'],
      resources: ['deployments'],
      resourceNames: ['falcone-control-plane'],
      verbs: ['get'],
    },
    {
      apiGroups: ['apps'],
      resources: ['deployments/scale'],
      resourceNames: ['falcone-control-plane'],
      verbs: ['patch'],
    },
  ], `${label} must separate Deployment inspection from scale mutation`);
  assert.equal(
    rules.some((rule) => rule.resources.includes('deployments') && (
      rule.verbs.includes('patch') || rule.verbs.includes('update')
    )),
    false,
    `${label} must not patch or update the full Deployment`,
  );
  assert.deepEqual(
    rules.filter((rule) => rule.verbs.includes('patch')),
    [deploymentRules[1]],
    `${label} must grant patch only on the named scale subresource`,
  );
  assert.equal(
    rules.some((rule) => rule.verbs.includes('update')),
    false,
    `${label} must not grant update on any lifecycle resource`,
  );
}

function assertCredentialSecretRbac(rendered, {
  label,
  secretName,
  allowCreate,
  finalizeSourceName = null,
}) {
  const credentialRole = documentWith(
    rendered,
    'kind: Role',
    'app.kubernetes.io/component: webhook-key-credential',
  );
  assert.ok(credentialRole, `${label} must render the credential Role`);

  const expectedCredentialRules = [
    {
      apiGroups: [''],
      resources: ['secrets'],
      resourceNames: [secretName],
      verbs: ['get'],
    },
  ];
  if (allowCreate) {
    expectedCredentialRules.push({
      apiGroups: [''],
      resources: ['secrets'],
      resourceNames: null,
      verbs: ['create'],
    });
  }
  assert.deepEqual(
    rbacRules(credentialRole),
    expectedCredentialRules,
    `${label} credential Secret access must match its executable create path exactly`,
  );

  const lifecycleRole = documentWith(
    rendered,
    'kind: Role',
    'app.kubernetes.io/component: webhook-key-lifecycle',
  );
  if (!lifecycleRole) {
    assert.equal(finalizeSourceName, null, `${label} must render the expected lifecycle Role`);
    return;
  }

  const lifecycleSecretRules = rbacRules(lifecycleRole)
    .filter((rule) => rule.apiGroups.includes('') && rule.resources.includes('secrets'));
  assert.deepEqual(
    lifecycleSecretRules,
    finalizeSourceName === null
      ? []
      : [{
          apiGroups: [''],
          resources: ['secrets'],
          resourceNames: [finalizeSourceName],
          verbs: ['get', 'delete'],
        }],
    `${label} must have no Secret mutation beyond the exact-name lifecycle-finalize rule`,
  );
}

function podSpec(document) {
  const lines = document.split('\n');
  const templateIndex = lines.findIndex((line) => line === '  template:');
  assert.notEqual(templateIndex, -1, 'workload document must contain spec.template');
  const specIndex = lines.findIndex((line, index) => index > templateIndex && line === '    spec:');
  assert.notEqual(specIndex, -1, 'workload document must contain spec.template.spec');
  const endIndex = lines.findIndex(
    (line, index) => index > specIndex && line.trim() !== '' && !line.startsWith('      '),
  );
  return lines.slice(specIndex + 1, endIndex === -1 ? lines.length : endIndex).join('\n');
}

function podImagePullSecretNames(document) {
  const spec = podSpec(document);
  const lines = spec.split('\n');
  const fieldIndex = lines.findIndex((line) => line === '      imagePullSecrets:');
  if (fieldIndex === -1) {
    assert.equal(
      lines.some((line) => /^\s*imagePullSecrets:/.test(line)),
      false,
      'imagePullSecrets must be at the Pod spec level when rendered',
    );
    return null;
  }
  const names = [];
  for (let index = fieldIndex + 1; index < lines.length && lines[index].startsWith('        '); index += 1) {
    const match = lines[index].match(/^        - name: "?([^"\s]+)"?$/);
    assert.ok(match, `imagePullSecrets must contain only non-empty name entries: ${lines[index]}`);
    names.push(match[1]);
  }
  assert.ok(names.length > 0, 'imagePullSecrets must be omitted instead of rendering an empty structure');
  return names;
}

function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`ok ${passed} - ${name}\n`);
}

const base = render();

check('pull secrets honor schema string/object forms and share exact deduplicated runtime JSON', () => {
  const scenarios = [
    {
      label: 'string form',
      values: ['--set', 'global.imagePullSecrets[0]=harbor-pull'],
      expected: ['harbor-pull'],
    },
    {
      label: 'object form',
      values: ['--set', 'global.imagePullSecrets[0].name=harbor-pull'],
      expected: ['harbor-pull'],
    },
    {
      label: 'mixed form with cross-source duplicates',
      values: [
        '--set', 'global.imagePullSecrets[0]=harbor-pull',
        '--set', 'global.imagePullSecrets[1].name=backup-pull',
        '--set', 'global.privateRegistry.pullSecretNames[0]=harbor-pull',
        '--set', 'global.privateRegistry.pullSecretNames[1]=registry-pull',
        '--set', 'eso.external-secrets.imagePullSecrets[0].name=harbor-pull',
        '--set', 'eso.external-secrets.imagePullSecrets[1].name=operator-local',
        '--set', 'eso.external-secrets.webhook.imagePullSecrets[0].name=webhook-local',
        '--set', 'eso.external-secrets.certController.imagePullSecrets[0].name=cert-local',
      ],
      expected: ['harbor-pull', 'backup-pull', 'registry-pull'],
      esoExpected: {
        operator: ['harbor-pull', 'backup-pull', 'registry-pull', 'operator-local'],
        webhook: ['harbor-pull', 'backup-pull', 'registry-pull', 'webhook-local'],
        certController: ['harbor-pull', 'backup-pull', 'registry-pull', 'cert-local'],
      },
    },
  ];

  for (const scenario of scenarios) {
    const rendered = helm([
      'template',
      'pull-secret',
      chart,
      '--namespace',
      'c25-ns',
      ...scenario.values,
    ]);
    const controlPlane = documentWith(
      rendered,
      'kind: Deployment',
      'name: pull-secret-control-plane',
    );
    assert.ok(controlPlane, `${scenario.label} renders the component-wrapper control plane`);
    assert.match(
      controlPlane,
      new RegExp(
        `- name: SEAWEEDFS_IMAGE_PULL_SECRETS\\s+value: '${JSON.stringify(scenario.expected).replaceAll('[', '\\[').replaceAll(']', '\\]')}'`,
      ),
      `${scenario.label} must pass the exact normalized list to runtime IAM Jobs`,
    );

    const consumers = [
      ['component wrapper', controlPlane],
      ['root helper', documentWith(rendered, 'kind: Job', 'name: pull-secret-seaweedfs-admin-seed')],
      ['Temporal helper', documentWith(rendered, 'kind: Deployment', 'name: pull-secret-temporal-frontend')],
      ['OpenBao helper', documentWith(rendered, 'kind: StatefulSet', 'name: openbao')],
      ['ESO helper', documentWith(rendered, 'kind: Job', 'name: eso-preflight')],
      ['SeaweedFS helper', documentWith(rendered, 'kind: StatefulSet', 'name: pull-secret-seaweedfs-master')],
      ['bootstrap inline path', documentWith(rendered, 'kind: Job', 'name: pull-secret-in-falcone-bootstrap')],
      ['DocumentDB inline path', documentWith(rendered, 'kind: Job', 'name: pull-secret-documentdb-init')],
      ['credential inline path', documentWith(rendered, 'kind: Job', 'name: pull-secret-in-falcone-credential-bootstrap')],
    ];
    for (const [consumer, document] of consumers) {
      assert.ok(document, `${scenario.label} renders the ${consumer} consumer`);
      assert.deepEqual(
        podImagePullSecretNames(document),
        scenario.expected,
        `${scenario.label} must normalize and deduplicate ${consumer} pull secrets`,
      );
    }

    const esoExpected = scenario.esoExpected ?? {
      operator: scenario.expected,
      webhook: scenario.expected,
      certController: scenario.expected,
    };
    for (const [consumer, document, expected] of [
      [
        'ESO operator Deployment',
        documentWith(rendered, 'kind: Deployment', 'name: eso-external-secrets\n'),
        esoExpected.operator,
      ],
      [
        'ESO webhook Deployment',
        documentWith(rendered, 'kind: Deployment', 'name: eso-external-secrets-webhook\n'),
        esoExpected.webhook,
      ],
      [
        'ESO certificate-controller Deployment',
        documentWith(rendered, 'kind: Deployment', 'name: eso-external-secrets-cert-controller\n'),
        esoExpected.certController,
      ],
    ]) {
      assert.ok(document, `${scenario.label} renders the ${consumer}`);
      assert.deepEqual(
        podImagePullSecretNames(document),
        expected,
        `${scenario.label} must merge global and local ${consumer} pull secrets`,
      );
    }
  }
});

check('base control plane has one required Secret reference and a Kubernetes-enforced readiness gate', () => {
  assert.equal((base.match(/^\s*- name: WEBHOOK_SIGNING_KEY$/gm) ?? []).length, 1);
  const controlPlane = documentWith(base, 'kind: Deployment', 'name: falcone-control-plane');
  assert.ok(controlPlane);
  assert.match(controlPlane, /- name: WEBHOOK_SIGNING_KEY\s+valueFrom:\s+secretKeyRef:\s+name: "in-falcone-webhook-signing-key"\s+key: "key"\s+optional: false/);
  assert.match(controlPlane, /- name: WEBHOOK_SIGNING_KEY_MODE\s+value: "canonical-v1"/);
  assert.match(controlPlane, /- name: WEBHOOK_SIGNING_KEY_ID\s+value: "wk1:[a-f0-9]{64}"/);
  assert.match(controlPlane, /in-falcone.io\/release-revision: "1"/);
  assert.match(
    controlPlane,
    /readinessProbe:\s+failureThreshold: 3\s+httpGet:\s+path: \/readyz\s+port: http\s+initialDelaySeconds: 0\s+periodSeconds: 5\s+successThreshold: 1\s+timeoutSeconds: 2/,
    'Kubernetes must not mark the control plane Ready before its C-25 startup verification succeeds',
  );
  for (const doc of documents(base).filter((item) => /kind: (Deployment|StatefulSet)/.test(item) && !item.includes('name: falcone-control-plane'))) {
    assert.doesNotMatch(doc, /WEBHOOK_SIGNING_KEY/);
  }
});

check('base control plane passes release-scoped SeaweedFS endpoints to dynamic IAM Jobs', () => {
  const controlPlane = documentWith(base, 'kind: Deployment', 'name: falcone-control-plane');
  assert.ok(controlPlane);
  assert.match(
    controlPlane,
    /- name: SEAWEEDFS_MASTER\s+value: ['"]falcone-seaweedfs-master\.falcone-test:9333['"]/,
  );
  assert.match(
    controlPlane,
    /- name: SEAWEEDFS_FILER\s+value: ['"]falcone-seaweedfs-filer\.falcone-test:8888['"]/,
  );
  assert.match(
    controlPlane,
    new RegExp(`- name: SEAWEEDFS_IMAGE\\s+value: ['"]chrislusf/seaweedfs@${seaweedfsDigest}['"]`),
  );
  assert.match(controlPlane, /- name: SEAWEEDFS_IMAGE_PULL_POLICY\s+value: ['"]IfNotPresent['"]/);
  assert.match(controlPlane, /- name: SEAWEEDFS_IMAGE_PULL_SECRETS\s+value: ['"]\[\]['"]/);
  assert.match(controlPlane, /- name: SEAWEEDFS_OPENSHIFT_RESTRICTED\s+value: ['"]false['"]/);

  for (const [label, rendered] of [
    ['base', helm(['template', 'c25-arbitrary', chart, '--namespace', 'c25-ns'])],
    ['kind', helm([
      'template',
      'c25-arbitrary',
      chart,
      '--namespace',
      'c25-ns',
      '-f',
      'deploy/kind/values-kind.yaml',
    ])],
  ]) {
    const custom = documentWith(rendered, 'kind: Deployment', 'name: c25-arbitrary-control-plane');
    assert.ok(custom, `${label} custom release renders its control plane`);
    assert.match(custom, /- name: STORAGE_S3_ENDPOINT\s+value: ['"]?http:\/\/c25-arbitrary-seaweedfs-s3:8333['"]?/);
    assert.match(custom, /- name: SEAWEEDFS_MASTER\s+value: ['"]c25-arbitrary-seaweedfs-master\.c25-ns:9333['"]/);
    assert.match(custom, /- name: SEAWEEDFS_FILER\s+value: ['"]c25-arbitrary-seaweedfs-filer\.c25-ns:8888['"]/);
  }

  const openshift = documentWith(
    render(['-f', 'deploy/openshift/values-openshift.yaml']),
    'kind: Deployment',
    'name: falcone-control-plane',
  );
  assert.ok(openshift);
  assert.match(
    openshift,
    new RegExp(`- name: SEAWEEDFS_IMAGE\\s+value: ['"]harbor\\.example\\.com/falcone/chrislusf/seaweedfs@${seaweedfsDigest}['"]`),
  );
  assert.match(openshift, /- name: SEAWEEDFS_IMAGE_PULL_SECRETS\s+value: ['"]\["harbor-pull"\]['"]/);
  assert.match(openshift, /- name: SEAWEEDFS_OPENSHIFT_RESTRICTED\s+value: ['"]true['"]/);
});

check('base observability workload mounts the release-scoped Prometheus ConfigMap', () => {
  const observability = documentWith(base, 'kind: Deployment', 'name: falcone-observability');
  assert.ok(observability);
  assert.match(
    observability,
    /- configMap:\s+name: ['"]falcone-prometheus-config['"]\s+name: prometheus-config/,
  );
  const customRelease = helm([
    'template',
    'c25-custom-release',
    chart,
    '--namespace',
    'falcone-test',
  ]);
  const customObservability = documentWith(
    customRelease,
    'kind: Deployment',
    'name: c25-custom-release-observability',
  );
  assert.ok(customObservability);
  assert.match(
    customObservability,
    /- configMap:\s+name: ['"]c25-custom-release-prometheus-config['"]\s+name: prometheus-config/,
  );
});

check('fresh managed credential hook has exact-name get plus separate create RBAC and no rendered key bytes', () => {
  const role = documentWith(base, 'kind: Role', 'app.kubernetes.io/component: webhook-key-credential');
  const job = documentWith(base, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential');
  assert.match(role, /resources: \["secrets"\]\s+resourceNames: \["in-falcone-webhook-signing-key"\]\s+verbs: \["get"\]/);
  assert.match(role, /resources: \["secrets"\]\s+verbs: \["create"\]/);
  assert.doesNotMatch(role, /"list"|"watch"|"update"|"patch"|"delete"/);
  assert.match(job, /hook-weight": "-45"/);
  assert.match(job, /WEBHOOK_KEY_IS_UPGRADE\s+value: "false"/);
  assert.doesNotMatch(job, /v1:[A-Za-z0-9_-]{43}/);
});

check('default hook Pod specs omit empty or invalid image pull-secret structures', () => {
  const lifecycleRender = upgrade([
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=default-pull-secret-rotate-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=default-pull-secret-rotation-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const jobs = [
    documentWith(base, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential'),
    documentWith(lifecycleRender, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential'),
    documentWith(lifecycleRender, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle'),
  ];
  for (const job of jobs) {
    assert.ok(job);
    assert.equal(podImagePullSecretNames(job), null);
  }
});

check('external credential hook is read-only', () => {
  const rendered = render(['--set', 'global.webhookSigningKey.create=false']);
  const role = documentWith(rendered, 'kind: Role', 'app.kubernetes.io/component: webhook-key-credential');
  assert.match(role, /resources: \["secrets"\]\s+resourceNames: \["in-falcone-webhook-signing-key"\]\s+verbs: \["get"\]/);
  assert.doesNotMatch(role, /"create"|"list"|"watch"|"update"|"patch"|"delete"/);
});

check('credential Secret create RBAC exists only for fresh managed install and managed rotate', () => {
  const scenarios = [
    {
      label: 'fresh managed install',
      rendered: base,
      secretName: 'in-falcone-webhook-signing-key',
      allowCreate: true,
    },
    {
      label: 'ordinary managed upgrade',
      rendered: upgrade(),
      secretName: 'in-falcone-webhook-signing-key',
      allowCreate: false,
    },
    {
      label: 'external legacy adoption',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.secretName=legacy-webhook-key',
        '--set', 'global.webhookSigningKey.adoption.mode=legacy',
        '--set', 'global.webhookSigningKey.adoption.requestId=rbac-adopt-create-001',
      ]),
      secretName: 'legacy-webhook-key',
      allowCreate: false,
    },
    {
      label: 'managed rotate',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v2-managed',
        '--set', 'global.webhookSigningKey.rotation.action=rotate',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-managed-rotate-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-managed-rotation-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'webhook-key-v2-managed',
      allowCreate: true,
    },
    {
      label: 'external rotate',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v2-external',
        '--set', 'global.webhookSigningKey.rotation.action=rotate',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-external-rotate-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-external-rotation-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'webhook-key-v2-external',
      allowCreate: false,
    },
    {
      label: 'managed recover',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v1-managed',
        '--set', 'global.webhookSigningKey.rotation.action=recover',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-managed-recover-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-managed-recovery-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v2-managed',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'webhook-key-v1-managed',
      allowCreate: false,
    },
    {
      label: 'external recover',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v1-external',
        '--set', 'global.webhookSigningKey.rotation.action=recover',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-external-recover-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-external-recovery-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v2-external',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'webhook-key-v1-external',
      allowCreate: false,
    },
    {
      label: 'managed finalize',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.rotation.action=finalize',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-managed-finalize-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-recovery-managed',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'in-falcone-webhook-signing-key',
      allowCreate: false,
      finalizeSourceName: 'webhook-key-recovery-managed',
    },
    {
      label: 'external finalize',
      rendered: upgrade([
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.rotation.action=finalize',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-external-finalize-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-recovery-external',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ]),
      secretName: 'in-falcone-webhook-signing-key',
      allowCreate: false,
      finalizeSourceName: 'webhook-key-recovery-external',
    },
  ];

  for (const scenario of scenarios) {
    assertCredentialSecretRbac(scenario.rendered, scenario);
  }
});

check('ordinary upgrade validates the retained current identity without a lifecycle transform', () => {
  const rendered = upgrade();
  const credential = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential');
  assert.match(credential, /WEBHOOK_KEY_IS_UPGRADE\s+value: "true"/);
  assert.match(credential, /WEBHOOK_KEY_LIFECYCLE_ACTION\s+value: "none"/);
  assert.equal(documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle'), undefined);
  const workload = documentWith(rendered, 'kind: Deployment', 'name: falcone-control-plane');
  assert.match(workload, /in-falcone.io\/release-revision: "1"/);
  assert.match(workload, /name: "in-falcone-webhook-signing-key"\s+key: "key"\s+optional: false/);
  const componentTemplate = readFileSync(
    resolve(root, 'charts/in-falcone/charts/component-wrapper/templates/workload.yaml'),
    'utf8',
  );
  assert.match(componentTemplate, /\.Release\.Revision/);
  assert.doesNotMatch(componentTemplate, /release-revision[^]*webhookSigningKey\.(value|data)|sha256sum\s+\$webhookKey\.(value|data)/);
});

check('same-reference external upgrade forces startup verification without deriving rollout data from bytes', () => {
  const rendered = upgrade(['--set', 'global.webhookSigningKey.create=false']);
  const workload = documentWith(rendered, 'kind: Deployment', 'name: falcone-control-plane');
  const credential = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential');
  assert.match(workload, /in-falcone.io\/release-revision: "1"/);
  assert.match(workload, /name: "in-falcone-webhook-signing-key"\s+key: "key"\s+optional: false/);
  assert.match(credential, /WEBHOOK_KEY_CREATE\s+value: "false"/);
  assert.equal(documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle'), undefined);
  assert.doesNotMatch(workload, /v1:[A-Za-z0-9_-]{43}|webhook-key-(value|digest|hash)/i);
});

check('installed 0.3.1 can render a truthful later finalization upgrade while version gates remain fail-closed', () => {
  const rendered = upgradeFrom('0.3.1', [
    '--set', 'deployment.upgrade.targetVersion=0.3.1',
    '--set', 'global.webhookSigningKey.rotation.action=finalize',
    '--set', 'global.webhookSigningKey.rotation.requestId=finalize-later-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v0',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const lifecycle = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.match(lifecycle, /WEBHOOK_KEY_LIFECYCLE_ACTION\s+value: "finalize"/);

  helm(['template', 'falcone', chart, '--namespace', 'falcone-test', '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.1.9',
    '--set', 'deployment.upgrade.targetVersion=0.3.1',
    ...upgradeProof], { fail: true });
  helm(['template', 'falcone', chart, '--namespace', 'falcone-test', '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.2',
    '--set', 'deployment.upgrade.targetVersion=0.3.1',
    '--set-json', 'deployment.upgrade.supportedPreviousVersions=["0.3.2"]',
    ...upgradeProof], { fail: true });
});

check('kind profile makes no installed-version claim and still renders a fresh install', () => {
  const kindValues = readFileSync(resolve(root, 'deploy/kind/values-kind.yaml'), 'utf8');
  assert.doesNotMatch(
    kindValues,
    /^\s*currentVersion\s*:/m,
    'reusable kind profile must not claim which version is already installed',
  );

  const rendered = render(['-f', 'deploy/kind/values-kind.yaml']);
  assert.ok(documentWith(rendered, 'kind: Deployment', 'name: falcone-control-plane'));
});

check('kind profile upgrade without an explicit installed version fails closed', () => {
  const result = spawnSync(
    'helm',
    [
      'template', 'falcone', chart,
      '--namespace', 'falcone-test',
      '--is-upgrade',
      '-f', 'deploy/kind/values-kind.yaml',
      ...upgradeProof,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '', 'missing currentVersion must not produce a partial manifest');
  assert.match(result.stderr, /deployment\.upgrade\.currentVersion is required during in-place upgrades/);
});

check('kind profile accepts a truthful installed-0.3.1 lifecycle upgrade', () => {
  const rendered = upgradeFrom('0.3.1', [
    '-f', 'deploy/kind/values-kind.yaml',
    '--set', 'deployment.upgrade.targetVersion=0.3.1',
    '--set', 'global.webhookSigningKey.rotation.action=finalize',
    '--set', 'global.webhookSigningKey.rotation.requestId=kind-finalize-later-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v0',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const lifecycle = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.match(lifecycle, /WEBHOOK_KEY_LIFECYCLE_ACTION\s+value: "finalize"/);
});

check('kind profile rejects an explicitly unsupported installed version', () => {
  const result = spawnSync(
    'helm',
    [
      'template', 'falcone', chart,
      '--namespace', 'falcone-test',
      '--is-upgrade',
      '-f', 'deploy/kind/values-kind.yaml',
      '--set', 'deployment.upgrade.currentVersion=0.1.9',
      '--set', 'deployment.upgrade.targetVersion=0.3.1',
      ...upgradeProof,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '', 'unsupported currentVersion must not produce a partial manifest');
  assert.match(
    result.stderr,
    /deployment\.upgrade\.currentVersion 0\.1\.9 is not in deployment\.upgrade\.supportedPreviousVersions/,
  );
});

check('legacy adoption renders an ordered restricted maintenance hook', () => {
  const rendered = upgrade([
    '--set', 'global.webhookSigningKey.create=false',
    '--set', 'global.webhookSigningKey.secretName=legacy-webhook-key',
    '--set', 'global.webhookSigningKey.adoption.mode=legacy',
    '--set', 'global.webhookSigningKey.adoption.requestId=adopt-001',
  ]);
  const credential = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential');
  const lifecycle = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle');
  const role = documentWith(rendered, 'kind: Role', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.match(credential, /hook-weight": "-45"/);
  assert.match(lifecycle, /hook-weight": "-35"/);
  assert.match(lifecycle, /WEBHOOK_KEY_LIFECYCLE_ACTION\s+value: "adopt"/);
  assert.match(lifecycle, /WEBHOOK_SIGNING_KEY\s+valueFrom:\s+secretKeyRef:[\s\S]*optional: false/);
  assertLifecycleDeploymentRbac(rendered, 'legacy adoption');
  assert.doesNotMatch(role, /resources: \["secrets"\]/);
});

check('SeaweedFS post-upgrade hooks cannot block a restricted lifecycle upgrade', () => {
  const rendered = upgrade();
  const seed = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: seaweedfs-admin-seed',
  );
  assert.ok(seed, 'filer-mode renders the SeaweedFS admin seed hook');
  assert.match(seed, /securityContext:\s+seccompProfile:\s+type: RuntimeDefault/);
  assert.match(
    seed,
    /name: admin-seed[\s\S]*securityContext:\s+allowPrivilegeEscalation: false[\s\S]*capabilities:\s+drop:\s+- ALL/,
  );
  assert.match(seed, /readOnlyRootFilesystem: true/);
  assert.match(seed, /runAsNonRoot: true/);
  assert.match(seed, /runAsUser: 1000/);
  assert.match(seed, /runAsGroup: 1000/);

  const bucket = documentWith(rendered, 'kind: Job', 'name: "falcone-bucket-hook"');
  assert.ok(bucket, 'the default bucket-creation hook renders');
  assert.match(bucket, /securityContext:\s+seccompProfile:\s+type: RuntimeDefault/);
  assert.match(
    bucket,
    /name: post-install-job[\s\S]*securityContext:\s+allowPrivilegeEscalation: false[\s\S]*capabilities:\s+drop:\s+- ALL/,
  );
  assert.match(bucket, /readOnlyRootFilesystem: true/);
  assert.match(bucket, /runAsNonRoot: true/);
  assert.match(bucket, /runAsUser: 1000/);
  assert.match(bucket, /runAsGroup: 1000/);

  const openshift = render(['-f', 'deploy/openshift/values-openshift.yaml']);
  for (const hook of [
    documentWith(
      openshift,
      'kind: Job',
      'app.kubernetes.io/component: seaweedfs-admin-seed',
    ),
    documentWith(openshift, 'kind: Job', 'name: "falcone-bucket-hook"'),
  ]) {
    assert.ok(hook, 'OpenShift renders each SeaweedFS post-upgrade hook');
    assert.doesNotMatch(hook, /runAsUser:/);
    assert.doesNotMatch(hook, /runAsGroup:/);
  }

  const openbaoInit = documentWith(rendered, 'kind: Job', 'name: openbao-init');
  assert.equal(openbaoInit, undefined, 'the full OpenBao payload/policy bootstrap is fresh-install-only');
  const openbaoReconcile = documentWith(rendered, 'kind: Job', 'name: openbao-auth-reconcile');
  assert.ok(openbaoReconcile, 'the OpenBao auth-metadata convergence hook renders');
  assert.match(
    openbaoReconcile,
    /"helm\.sh\/hook-delete-policy": before-hook-creation,hook-succeeded,hook-failed/,
    'the sensitive hook Pod must be deleted on success or failure',
  );
  assert.match(openbaoReconcile, /ttlSecondsAfterFinished: 300/);
  assert.match(
    openbaoReconcile,
    /securityContext:\s+runAsNonRoot: true\s+runAsUser: 1000\s+seccompProfile:\s+type: RuntimeDefault/,
  );
  for (const container of ['request-no-kv-canary-token', 'auth-metadata-reconciler']) {
    assert.match(
      openbaoReconcile,
      new RegExp(`name: ${container}[\\s\\S]*?securityContext:\\s+allowPrivilegeEscalation: false[\\s\\S]*?capabilities:\\s+drop:\\s+- ALL[\\s\\S]*?runAsNonRoot: true`),
    );
  }
  assert.doesNotMatch(openbaoReconcile, /\bbao\s+kv\b|\bbao\s+policy\s+(?:read|write|delete)\b/);
  assert.match(openbaoReconcile, /token_reviewer_jwt=""/);

  const documentdbInit = documentWith(rendered, 'kind: Job', 'name: falcone-documentdb-init');
  assert.ok(documentdbInit, 'the DocumentDB convergence hook renders');
  assert.match(
    documentdbInit,
    /securityContext:\s+fsGroup: 1001\s+runAsNonRoot: true\s+runAsUser: 999\s+seccompProfile:\s+type: RuntimeDefault/,
  );
});

check('every lifecycle mode grants named Deployment get and scale-only patch', () => {
  const scenarios = [
    {
      label: 'adopt',
      values: [
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.secretName=legacy-webhook-key',
        '--set', 'global.webhookSigningKey.adoption.mode=legacy',
        '--set', 'global.webhookSigningKey.adoption.requestId=rbac-adopt-001',
      ],
    },
    {
      label: 'rotate',
      values: [
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
        '--set', 'global.webhookSigningKey.rotation.action=rotate',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-rotate-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-rotation-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ],
    },
    {
      label: 'recover',
      values: [
        '--set', 'global.webhookSigningKey.create=false',
        '--set', 'global.webhookSigningKey.secretName=webhook-key-v1',
        '--set', 'global.webhookSigningKey.rotation.action=recover',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-recover-001',
        '--set', 'global.webhookSigningKey.rotation.rotationId=rbac-recovery-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v2',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ],
    },
    {
      label: 'finalize',
      values: [
        '--set', 'global.webhookSigningKey.rotation.action=finalize',
        '--set', 'global.webhookSigningKey.rotation.requestId=rbac-finalize-001',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v1',
        '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
      ],
    },
  ];

  for (const scenario of scenarios) {
    assertLifecycleDeploymentRbac(upgrade(scenario.values), scenario.label);
  }
});

check('rotate uses a distinct target and two required Secret references', () => {
  const rendered = upgrade([
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=rotate-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=rotation-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const lifecycle = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.match(lifecycle, /WEBHOOK_KEY_LIFECYCLE_ACTION\s+value: "rotate"/);
  assert.match(lifecycle, /name: "webhook-key-v2"/);
  assert.match(lifecycle, /name: "in-falcone-webhook-signing-key"/);
  assert.equal((lifecycle.match(/optional: false/g) ?? []).length >= 4, true);
  assert.doesNotMatch(lifecycle, /PGSSLMODE|PGSSLROOTCERT|falcone-transport-ca/);
});

check('hardened production rotate gives the lifecycle Job PostgreSQL TLS and the read-only CA mount', () => {
  const rendered = upgrade([
    '-f', 'deploy/kind/values-kind.yaml',
    '-f', 'deploy/kind/values-production.yaml',
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2-hardened',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=rotate-hardened-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=rotation-hardened-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const lifecycle = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-lifecycle',
  );
  const credential = documentWith(
    rendered,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-credential',
  );
  const controlPlane = documentWith(
    rendered,
    'kind: Deployment',
    'name: falcone-control-plane',
  );

  for (const workload of [controlPlane, lifecycle]) {
    assert.match(workload, /name: PGSSLMODE\s+value: verify-full/);
    assert.match(workload, /name: PGSSLROOTCERT\s+value: \/etc\/falcone\/tls\/ca\.crt/);
    assert.match(
      workload,
      /name: falcone-transport-ca\s+mountPath: \/etc\/falcone\/tls\s+readOnly: true/,
    );
    assert.match(
      workload,
      /name: falcone-transport-ca\s+secret:\s+secretName: falcone-transport-ca/,
    );
  }
  assert.equal((lifecycle.match(/name: PGSSLMODE/g) ?? []).length, 1);
  assert.equal((lifecycle.match(/name: PGSSLROOTCERT/g) ?? []).length, 1);
  assert.doesNotMatch(credential, /PGSSLMODE|PGSSLROOTCERT|falcone-transport-ca/);
  assert.doesNotMatch(lifecycle, /name: (MONGO_TLS|KAFKA_SSL|NODE_EXTRA_CA_CERTS)/);
  assertLifecycleDeploymentRbac(rendered, 'hardened production rotate');
});

check('recover and finalize render forward lifecycle actions; finalize alone gets bounded delete RBAC', () => {
  const recover = upgrade([
    '--set', 'global.webhookSigningKey.create=false',
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v1',
    '--set', 'global.webhookSigningKey.rotation.action=recover',
    '--set', 'global.webhookSigningKey.rotation.requestId=recover-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=recovery-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const externalRecoverJob = documentWith(
    recover,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-lifecycle',
  );
  assert.match(externalRecoverJob, /value: "recover"/);
  assert.match(
    externalRecoverJob,
    /WEBHOOK_SIGNING_KEY_MANAGED\s+value: "false"/,
  );

  const managedRecover = upgrade([
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v1-managed',
    '--set', 'global.webhookSigningKey.rotation.action=recover',
    '--set', 'global.webhookSigningKey.rotation.requestId=recover-managed-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=recovery-managed-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  assert.match(
    documentWith(
      managedRecover,
      'kind: Job',
      'app.kubernetes.io/component: webhook-key-lifecycle',
    ),
    /WEBHOOK_SIGNING_KEY_MANAGED\s+value: "true"/,
  );

  const finalize = upgrade([
    '--set', 'global.webhookSigningKey.rotation.action=finalize',
    '--set', 'global.webhookSigningKey.rotation.requestId=finalize-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=webhook-key-v1',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const job = documentWith(finalize, 'kind: Job', 'app.kubernetes.io/component: webhook-key-lifecycle');
  const role = documentWith(finalize, 'kind: Role', 'app.kubernetes.io/component: webhook-key-lifecycle');
  assert.match(job, /node \/app\/webhook-key-lifecycle-cli\.mjs/);
  assert.doesNotMatch(job, /webhook-key-credential-cli\.mjs/);
  assert.match(job, /WEBHOOK_SOURCE_SIGNING_KEY_ID\s+value: "wk1:[a-f0-9]{64}"/);
  assert.match(role, /resources: \["secrets"\][\s\S]*resourceNames: \["webhook-key-v1"\][\s\S]*verbs: \["get", "delete"\]/);
});

check('every chart-inspectable reserved-key override fails without producing a manifest or echoing values', () => {
  const bypasses = [
    {
      label: 'controlPlane.env literal',
      suppliedValue: 'c25-control-plane-literal-must-not-echo',
      args: [
        '--set-json',
        'controlPlane.env=[{"name":"WEBHOOK_SIGNING_KEY","value":"c25-control-plane-literal-must-not-echo"}]',
      ],
    },
    {
      label: 'controlPlane.env valueFrom',
      suppliedValue: 'c25-control-plane-reference-must-not-echo',
      args: [
        '--set-json',
        'controlPlane.env=[{"name":"WEBHOOK_SIGNING_KEY","valueFrom":{"secretKeyRef":{"name":"c25-control-plane-reference-must-not-echo","key":"key"}}}]',
      ],
    },
    {
      label: 'disabled global.transportSecurity.env literal',
      suppliedValue: 'c25-transport-literal-must-not-echo',
      args: [
        '--set',
        'global.transportSecurity.enabled=false',
        '--set-json',
        'global.transportSecurity.env=[{"name":"WEBHOOK_SIGNING_KEY","value":"c25-transport-literal-must-not-echo"}]',
      ],
    },
    {
      label: 'enabled and opted-in global.transportSecurity.env literal',
      suppliedValue: 'c25-enabled-transport-literal-must-not-echo',
      args: [
        '--set',
        'global.transportSecurity.enabled=true',
        '--set',
        'controlPlane.transportSecurityClient=true',
        '--set-json',
        'global.transportSecurity.env=[{"name":"WEBHOOK_SIGNING_KEY","value":"c25-enabled-transport-literal-must-not-echo"}]',
      ],
    },
    {
      label: 'controlPlane.config.inline ConfigMap value',
      suppliedValue: 'c25-configmap-literal-must-not-echo',
      args: [
        '--set-string',
        'controlPlane.config.inline.WEBHOOK_SIGNING_KEY=c25-configmap-literal-must-not-echo',
      ],
    },
  ];
  for (const bypass of bypasses) rejectRender(bypass.args, bypass);
});

check('invalid inline, incomplete, install-time, and same-identity values fail before rendering', () => {
  const invalid = [
    ['--set', 'global.webhookSigningKey.inline=forbidden'],
    ['--set', 'global.webhookSigningKey.rotation.action=rotate'],
  ];
  for (const args of invalid) helm(['template', 'falcone', chart, '--namespace', 'falcone-test', ...args], { fail: true });
  helm(['template', 'falcone', chart, '--namespace', 'falcone-test', '--is-upgrade',
    '--set', 'deployment.upgrade.currentVersion=0.3.0',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=rotate-1',
    '--set', 'global.webhookSigningKey.rotation.rotationId=rotation-1',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key'], { fail: true });
});

check('kind and OpenShift profiles render with restricted key lifecycle security contexts', () => {
  const kind = render(['-f', 'deploy/kind/values-kind.yaml']);
  const openshift = render(['-f', 'deploy/openshift/values-openshift.yaml']);
  const local = render(['-f', 'charts/in-falcone/values/local.example.yaml']);
  for (const rendered of [kind, openshift, local]) {
    const job = documentWith(rendered, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential');
    const controlPlane = documentWith(rendered, 'kind: Deployment', 'name: falcone-control-plane');
    assert.match(job, /allowPrivilegeEscalation: false/);
    assert.match(job, /capabilities:\s+drop:\s+- ALL/);
    assert.match(job, /seccompProfile:\s+type: RuntimeDefault/);
    assert.match(job, pinnedControlPlaneImagePattern);
    assert.match(controlPlane, pinnedControlPlaneImagePattern);
  }
  assert.doesNotMatch(documentWith(openshift, 'kind: Job', 'app.kubernetes.io/component: webhook-key-credential'), /runAsUser:/);
});

check('OpenShift Harbor fresh and lifecycle hook Pods use the rewritten image and normalized pull secret', () => {
  const fresh = render(['-f', 'deploy/openshift/values-openshift.yaml']);
  const lifecycleRender = upgrade([
    '-f', 'deploy/openshift/values-openshift.yaml',
    '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
    '--set', 'global.webhookSigningKey.rotation.action=rotate',
    '--set', 'global.webhookSigningKey.rotation.requestId=openshift-rotate-001',
    '--set', 'global.webhookSigningKey.rotation.rotationId=openshift-rotation-001',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
    '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
  ]);
  const freshCredential = documentWith(
    fresh,
    'kind: Job',
    'app.kubernetes.io/component: webhook-key-credential',
  );
  assert.match(
    freshCredential,
    new RegExp(
      `image: "harbor\\.example\\.com/falcone/gntik-ai/in-falcone-control-plane@${controlPlaneDigest}"`,
    ),
  );
  assert.deepEqual(podImagePullSecretNames(freshCredential), ['harbor-pull']);

  for (const component of ['webhook-key-credential', 'webhook-key-lifecycle']) {
    const job = documentWith(
      lifecycleRender,
      'kind: Job',
      `app.kubernetes.io/component: ${component}`,
    );
    assert.match(
      job,
      new RegExp(
        `image: "harbor\\.example\\.com/falcone/gntik-ai/in-falcone-control-plane@${controlPlaneDigest}"`,
      ),
    );
    assert.deepEqual(podImagePullSecretNames(job), ['harbor-pull']);
  }
});

check('base, kind, OpenShift, and local lifecycle hooks all use the compatible control-plane image', () => {
  const profiles = [
    [],
    ['-f', 'deploy/kind/values-kind.yaml'],
    ['-f', 'deploy/openshift/values-openshift.yaml'],
    ['-f', 'charts/in-falcone/values/local.example.yaml'],
  ];
  for (const profile of profiles) {
    const rendered = upgradeFrom('0.3.0', [
      ...profile,
      '--set', 'global.webhookSigningKey.secretName=webhook-key-v2',
      '--set', 'global.webhookSigningKey.rotation.action=rotate',
      '--set', 'global.webhookSigningKey.rotation.requestId=profile-rotate-001',
      '--set', 'global.webhookSigningKey.rotation.rotationId=profile-rotation-001',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretName=in-falcone-webhook-signing-key',
      '--set', 'global.webhookSigningKey.rotation.sourceSecretKey=key',
    ]);
    for (const component of ['webhook-key-credential', 'webhook-key-lifecycle']) {
      const job = documentWith(rendered, 'kind: Job', `app.kubernetes.io/component: ${component}`);
      assert.match(job, pinnedControlPlaneImagePattern);
    }
  }
});

check('tracked and rendered non-Secret surfaces contain no literal or canonical key payload', () => {
  const tracked = [
    'charts/in-falcone/values.yaml',
    'deploy/kind/values-kind.yaml',
    'deploy/helm/webhook-engine-values.yaml',
    'charts/in-falcone/templates/NOTES.txt',
  ].map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n');
  for (const content of [tracked, base]) {
    assert.doesNotMatch(content, /development-signing-key|kind-dev-webhook-signing-key|v1:[A-Za-z0-9_-]{43}/);
  }
});

process.stdout.write(`1..${passed}\n`);
