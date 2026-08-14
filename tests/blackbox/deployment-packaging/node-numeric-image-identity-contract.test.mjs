import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const chartPath = `${repoRoot}/charts/in-falcone`;
const openShiftValuesPath = `${chartPath}/values/platform-openshift.yaml`;
const releaseName = "bbx-node-image-identity";
const namespace = "bbx-node-image-identity";

const targetDeployments = [
  {
    deployment: `${releaseName}-control-plane-executor`,
    container: "control-plane-executor",
    image: "ghcr.io/gntik-ai/in-falcone-control-plane-executor:0.3.0",
  },
  {
    deployment: `${releaseName}-workflow-worker`,
    container: "workflow-worker",
    image: "ghcr.io/gntik-ai/in-falcone-workflow-worker:0.3.0",
  },
];

function renderChart(extraArgs = []) {
  const rendered = execFileSync(
    "helm",
    [
      "template",
      releaseName,
      chartPath,
      "--namespace",
      namespace,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  return YAML.parseAllDocuments(rendered)
    .map((document) => document.toJSON())
    .filter(Boolean);
}

function attemptRender(extraArgs = []) {
  const result = spawnSync(
    "helm",
    [
      "template",
      releaseName,
      chartPath,
      "--namespace",
      namespace,
      ...extraArgs,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return {
    diagnostic: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    status: result.status,
  };
}

function deployment(documents, name) {
  const matches = documents.filter(
    (document) =>
      document.kind === "Deployment" && document.metadata?.name === name,
  );

  assert.equal(matches.length, 1, `expected exactly one Deployment/${name}`);
  return matches[0];
}

function applicationContainer(workload, name) {
  const matches = (workload.spec?.template?.spec?.containers ?? []).filter(
    (container) => container.name === name,
  );

  assert.equal(
    matches.length,
    1,
    `expected exactly one container ${name} in Deployment/${workload.metadata?.name}`,
  );
  return matches[0];
}

function workloadInventory(documents) {
  const workloadKinds = new Set([
    "CronJob",
    "DaemonSet",
    "Deployment",
    "Job",
    "StatefulSet",
  ]);

  return documents
    .filter((document) => workloadKinds.has(document.kind))
    .map((document) => {
      const podSpec =
        document.kind === "CronJob"
          ? document.spec?.jobTemplate?.spec?.template?.spec
          : document.spec?.template?.spec;

      return {
        kind: document.kind,
        name: document.metadata?.name,
        replicas: document.spec?.replicas ?? null,
        containers: (podSpec?.containers ?? []).map(({ image, name }) => ({
          image,
          name,
        })),
        initContainers: (podSpec?.initContainers ?? []).map(
          ({ image, name }) => ({ image, name }),
        ),
      };
    })
    .sort((left, right) =>
      `${left.kind}/${left.name}`.localeCompare(`${right.kind}/${right.name}`),
    );
}

function assertContainerHardening(container, label) {
  assert.equal(
    container.securityContext?.runAsNonRoot,
    true,
    `${label} must retain runAsNonRoot`,
  );
  assert.equal(
    container.securityContext?.allowPrivilegeEscalation,
    false,
    `${label} must forbid privilege escalation`,
  );
  assert.equal(
    container.securityContext?.readOnlyRootFilesystem,
    true,
    `${label} must retain a read-only root filesystem`,
  );
  assert.deepEqual(
    container.securityContext?.capabilities,
    { drop: ["ALL"] },
    `${label} must drop every Linux capability`,
  );
}

function manifestInventory(documents, excludedNames = new Set()) {
  return documents
    .filter((document) => !excludedNames.has(document.metadata?.name))
    .map((document) => JSON.parse(JSON.stringify(document)))
    .sort((left, right) =>
      `${left.kind}/${left.metadata?.namespace ?? ""}/${left.metadata?.name}`.localeCompare(
        `${right.kind}/${right.metadata?.namespace ?? ""}/${right.metadata?.name}`,
      ),
    );
}

function withoutNumericContainerIdentity(workload, containerName) {
  const normalized = JSON.parse(JSON.stringify(workload));
  const container = applicationContainer(normalized, containerName);
  delete container.securityContext?.runAsUser;
  delete container.securityContext?.runAsGroup;
  return normalized;
}

const defaultDocuments = renderChart();
const openShiftDocuments = renderChart(["-f", openShiftValuesPath]);

// bbx-node-image-identity-001 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: Vanilla Kubernetes starts Node images that declare named users
test("default Kubernetes render pins the numeric identity baked into both named-user Node images", () => {
  const observed = Object.fromEntries(
    targetDeployments.map((target) => {
      const workload = deployment(defaultDocuments, target.deployment);
      const container = applicationContainer(workload, target.container);

      return [
        target.container,
        {
          allowPrivilegeEscalation:
            container.securityContext?.allowPrivilegeEscalation,
          capabilities: container.securityContext?.capabilities,
          image: container.image,
          readOnlyRootFilesystem:
            container.securityContext?.readOnlyRootFilesystem,
          replicas: workload.spec?.replicas,
          runAsGroup: container.securityContext?.runAsGroup,
          runAsNonRoot: container.securityContext?.runAsNonRoot,
          runAsUser: container.securityContext?.runAsUser,
        },
      ];
    }),
  );

  assert.deepEqual(observed, {
    "control-plane-executor": {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      image: "ghcr.io/gntik-ai/in-falcone-control-plane-executor:0.3.0",
      readOnlyRootFilesystem: true,
      replicas: 2,
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
    },
    "workflow-worker": {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      image: "ghcr.io/gntik-ai/in-falcone-workflow-worker:0.3.0",
      readOnlyRootFilesystem: true,
      replicas: 2,
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
    },
  });
});

// bbx-node-image-identity-002 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: OpenShift retains arbitrary UID assignment for Node workloads
test("OpenShift render removes fixed Node identities without changing the workload inventory", () => {
  for (const target of targetDeployments) {
    const defaultWorkload = deployment(defaultDocuments, target.deployment);
    const openShiftWorkload = deployment(openShiftDocuments, target.deployment);
    const defaultContainer = applicationContainer(
      defaultWorkload,
      target.container,
    );
    const openShiftContainer = applicationContainer(
      openShiftWorkload,
      target.container,
    );
    const openShiftPodSecurityContext =
      openShiftWorkload.spec?.template?.spec?.securityContext ?? {};
    const openShiftContainerSecurityContext =
      openShiftContainer.securityContext ?? {};

    assert.equal(openShiftWorkload.spec?.replicas, 2);
    assert.equal(defaultContainer.image, target.image);
    assert.equal(openShiftContainer.image, target.image);
    assert.equal(openShiftPodSecurityContext.runAsNonRoot, true);
    assert.deepEqual(openShiftPodSecurityContext.seccompProfile, {
      type: "RuntimeDefault",
    });
    assert.equal(openShiftContainerSecurityContext.runAsNonRoot, true);
    assert.equal(
      openShiftContainerSecurityContext.allowPrivilegeEscalation,
      false,
    );
    assert.equal(openShiftContainerSecurityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(openShiftContainerSecurityContext.capabilities, {
      drop: ["ALL"],
    });
    assert.equal(
      Object.hasOwn(openShiftPodSecurityContext, "runAsUser"),
      false,
      `OpenShift pod securityContext must not pin runAsUser for ${target.container}`,
    );
    assert.equal(
      Object.hasOwn(openShiftPodSecurityContext, "runAsGroup"),
      false,
      `OpenShift pod securityContext must not pin runAsGroup for ${target.container}`,
    );
    assert.equal(
      Object.hasOwn(openShiftContainerSecurityContext, "runAsUser"),
      false,
      `OpenShift container securityContext must not pin runAsUser for ${target.container}`,
    );
    assert.equal(
      Object.hasOwn(openShiftContainerSecurityContext, "runAsGroup"),
      false,
      `OpenShift container securityContext must not pin runAsGroup for ${target.container}`,
    );
  }

  assert.deepEqual(
    workloadInventory(openShiftDocuments),
    workloadInventory(defaultDocuments),
    "the OpenShift identity overlay must not change rendered workloads, images, or replicas",
  );
});

// bbx-node-image-identity-003 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: Invalid identity override is rejected
test("schema validation rejects every unsafe or malformed Node UID/GID override before rendering", () => {
  const invalidValues = [
    { flag: "--set", label: "zero", value: "0" },
    { flag: "--set", label: "negative", value: "-1" },
    { flag: "--set-string", label: "string", value: "node" },
    { flag: "--set", label: "fractional", value: "1000.5" },
  ];
  const fields = ["runAsUser", "runAsGroup"];
  const components = ["controlPlaneExecutor", "workflowWorker"];

  const observed = [];
  for (const component of components) {
    for (const field of fields) {
      for (const invalid of invalidValues) {
        const result = attemptRender([
          invalid.flag,
          `${component}.securityContext.${field}=${invalid.value}`,
        ]);
        observed.push({
          component,
          field,
          invalid: invalid.label,
          rejected: result.status !== 0,
          schemaDiagnostic:
            /values don't meet the specifications of the schema|schema validation/i.test(
              result.diagnostic,
            ),
        });
      }
    }
  }

  assert.deepEqual(
    observed,
    observed.map(({ component, field, invalid }) => ({
      component,
      field,
      invalid,
      rejected: true,
      schemaDiagnostic: true,
    })),
  );
});

// bbx-node-image-identity-004 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: Compatible custom Node image uses an explicit non-root identity
test("positive custom Node identities render exactly and retain all container hardening", () => {
  const customTargets = [
    {
      ...targetDeployments[0],
      component: "controlPlaneExecutor",
      gid: 2002,
      image: "registry.example.invalid/falcone/custom-executor:uid-contract",
      repository: "registry.example.invalid/falcone/custom-executor",
      uid: 2001,
    },
    {
      ...targetDeployments[1],
      component: "workflowWorker",
      gid: 3002,
      image: "registry.example.invalid/falcone/custom-worker:uid-contract",
      repository: "registry.example.invalid/falcone/custom-worker",
      uid: 3001,
    },
  ];
  const overrideArgs = customTargets.flatMap((target) => [
    "--set",
    `${target.component}.image.repository=${target.repository}`,
    "--set",
    `${target.component}.image.tag=uid-contract`,
    "--set",
    `${target.component}.securityContext.runAsUser=${target.uid}`,
    "--set",
    `${target.component}.securityContext.runAsGroup=${target.gid}`,
  ]);
  const documents = renderChart(overrideArgs);

  for (const target of customTargets) {
    const workload = deployment(documents, target.deployment);
    const container = applicationContainer(workload, target.container);

    assert.equal(container.image, target.image);
    assert.equal(container.securityContext?.runAsUser, target.uid);
    assert.equal(container.securityContext?.runAsGroup, target.gid);
    assertContainerHardening(container, target.container);
  }
});

// bbx-node-image-identity-005 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: Existing release upgrades without persistent-data migration
test("the rendered legacy-to-default upgrade delta is limited to the two container identities", () => {
  const legacyDocuments = renderChart([
    "--set-json",
    "controlPlaneExecutor.securityContext.runAsUser=null",
    "--set-json",
    "controlPlaneExecutor.securityContext.runAsGroup=null",
    "--set-json",
    "workflowWorker.securityContext.runAsUser=null",
    "--set-json",
    "workflowWorker.securityContext.runAsGroup=null",
  ]);
  const excludedNames = new Set(
    targetDeployments.map((target) => target.deployment),
  );

  assert.deepEqual(
    manifestInventory(defaultDocuments, excludedNames),
    manifestInventory(legacyDocuments, excludedNames),
    "numeric identity defaults must not alter any non-target rendered resource",
  );

  for (const target of targetDeployments) {
    const currentWorkload = deployment(defaultDocuments, target.deployment);
    const legacyWorkload = deployment(legacyDocuments, target.deployment);

    assert.deepEqual(
      withoutNumericContainerIdentity(currentWorkload, target.container),
      withoutNumericContainerIdentity(legacyWorkload, target.container),
      `Deployment/${target.deployment} may change only runAsUser/runAsGroup`,
    );
  }
});

// bbx-node-image-identity-006 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("explicit vanilla rollback values preserve a kubelet-verifiable identity and hardening", () => {
  const rollbackDocuments = renderChart([
    "--set",
    "controlPlaneExecutor.securityContext.runAsUser=1000",
    "--set",
    "controlPlaneExecutor.securityContext.runAsGroup=1000",
    "--set",
    "workflowWorker.securityContext.runAsUser=1000",
    "--set",
    "workflowWorker.securityContext.runAsGroup=1000",
  ]);

  for (const target of targetDeployments) {
    const workload = deployment(rollbackDocuments, target.deployment);
    const container = applicationContainer(workload, target.container);

    assert.equal(container.securityContext?.runAsUser, 1000);
    assert.equal(container.securityContext?.runAsGroup, 1000);
    assertContainerHardening(container, target.container);
  }
});

// bbx-node-image-identity-007 | fn-deployment-packaging-numeric-image-identity | OpenSpec #### Scenario: OpenShift rollback preserves SCC authority
test("OpenShift rollback rendering strips explicit fixed identities and preserves SCC-compatible hardening", () => {
  const rollbackDocuments = renderChart([
    "-f",
    openShiftValuesPath,
    "--set",
    "controlPlaneExecutor.securityContext.runAsUser=1000",
    "--set",
    "controlPlaneExecutor.securityContext.runAsGroup=1000",
    "--set",
    "workflowWorker.securityContext.runAsUser=1000",
    "--set",
    "workflowWorker.securityContext.runAsGroup=1000",
  ]);

  for (const target of targetDeployments) {
    const workload = deployment(rollbackDocuments, target.deployment);
    const container = applicationContainer(workload, target.container);
    const podSecurityContext =
      workload.spec?.template?.spec?.securityContext ?? {};

    assert.equal(Object.hasOwn(podSecurityContext, "runAsUser"), false);
    assert.equal(Object.hasOwn(podSecurityContext, "runAsGroup"), false);
    assert.equal(Object.hasOwn(container.securityContext, "runAsUser"), false);
    assert.equal(Object.hasOwn(container.securityContext, "runAsGroup"), false);
    assert.deepEqual(podSecurityContext.seccompProfile, {
      type: "RuntimeDefault",
    });
    assertContainerHardening(container, target.container);
  }
});
