import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const chartPath = resolve(repoRoot, "charts/in-falcone");
const toolsPath = resolve(chartPath, "tools");
const docsPath = resolve(chartPath, "docs/node-workload-security.md");
const historicalCommit = "c7cd7bb";
const historicalVersion = "0.4.18";
const chartReference = "oci://ghcr.io/gntik-ai/charts/in-falcone";
// Test-only package bytes. `--digest` is the sha256 of the downloaded .tgz
// bytes that are subsequently passed to `helm upgrade`; it is deliberately not
// represented as the OCI manifest digest or as the live 0.4.18 package digest.
const packageBytesFixture = minimalChartPackage("in-falcone", historicalVersion);
const operatorDigestFixture = packageDigest(packageBytesFixture);
const release = "bbx-node-downgrade";
const longRelease = "bbx-node-workload-identity-verification-release-12345";
const namespace = "bbx-node-downgrade";

const platformAssets = {
  vanilla: {
    script: resolve(toolsPath, "downgrade-node-workloads-vanilla.sh"),
    values: resolve(chartPath, "values/downgrade-node-workloads-vanilla.yaml"),
  },
  openshift: {
    script: resolve(toolsPath, "downgrade-node-workloads-openshift.sh"),
    values: resolve(chartPath, "values/downgrade-node-workloads-openshift.yaml"),
  },
};
const verifier = resolve(toolsPath, "verify-node-workloads.sh");

const targetContainers = [
  {
    deployment: `${release}-control-plane-executor`,
    name: "control-plane-executor",
  },
  {
    deployment: `${release}-workflow-worker`,
    name: "workflow-worker",
  },
];

function helmFullName(releaseName, component) {
  return `${releaseName}-${component}`.slice(0, 63).replace(/-+$/, "");
}

function packageDigest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function minimalChartPackage(chartName, chartVersion) {
  const path = "in-falcone/Chart.yaml";
  const content = Buffer.from(
    `apiVersion: v2\nname: ${chartName}\nversion: ${chartVersion}\n`,
  );
  const header = Buffer.alloc(512);
  const field = (value, offset, length) => {
    Buffer.from(value).copy(header, offset, 0, length);
  };
  const octal = (value, length) => `${value.toString(8).padStart(length - 1, "0")}\0`;
  field(path, 0, 100);
  field(octal(0o644, 8), 100, 8);
  field(octal(0, 8), 108, 8);
  field(octal(0, 8), 116, 8);
  field(octal(content.length, 12), 124, 12);
  field(octal(0, 12), 136, 12);
  header.fill(0x20, 148, 156);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  const contentPadding = Buffer.alloc((512 - (content.length % 512)) % 512);
  const tar = Buffer.concat([header, content, contentPadding, Buffer.alloc(1024)]);
  return gzipSync(tar, { level: 9, mtime: 0 });
}

function requireExecutable(path) {
  assert.equal(existsSync(path), true, `missing executable asset ${path}`);
  assert.notEqual(statSync(path).mode & 0o111, 0, `${path} is not executable`);
}

function extractHistoricalChart() {
  const root = mkdtempSync(join(tmpdir(), "bbx-falcone-chart-0418-"));
  const archive = spawnSync(
    "git",
    ["archive", historicalCommit, "charts/in-falcone"],
    { cwd: repoRoot, encoding: null, maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(archive.status, 0, archive.stderr?.toString() ?? "git archive failed");
  const unpack = spawnSync("tar", ["-x", "-C", root], {
    input: archive.stdout,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(unpack.status, 0, unpack.stderr?.toString() ?? "tar failed");

  const historicalChart = resolve(root, "charts/in-falcone");
  const metadata = YAML.parse(readFileSync(resolve(historicalChart, "Chart.yaml"), "utf8"));
  assert.equal(metadata.version, historicalVersion);
  return historicalChart;
}

function renderHistorical(valuesFile) {
  const historicalChart = extractHistoricalChart();
  const output = execFileSync(
    "helm",
    [
      "template",
      release,
      historicalChart,
      "--namespace",
      namespace,
      "--values",
      valuesFile,
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  return YAML.parseAllDocuments(output).map((document) => document.toJSON()).filter(Boolean);
}

function deployment(documents, name) {
  const matches = documents.filter(
    (document) => document.kind === "Deployment" && document.metadata?.name === name,
  );
  assert.equal(matches.length, 1, `expected exactly one Deployment/${name}`);
  return matches[0];
}

function container(workload, name) {
  const matches = (workload.spec?.template?.spec?.containers ?? []).filter(
    (entry) => entry.name === name,
  );
  assert.equal(matches.length, 1, `expected exactly one ${name} container`);
  return matches[0];
}

function fakeHelmEnvironment() {
  const root = mkdtempSync(join(tmpdir(), "bbx-fake-helm-"));
  const log = resolve(root, "helm-args.jsonl");
  const operationLog = resolve(root, "operation-order.log");
  const helm = resolve(root, "helm");
  writeFileSync(
    helm,
    `#!/usr/bin/env node
const fs=require("node:fs");
const path=require("node:path");
const args=process.argv.slice(2);
fs.appendFileSync(process.env.BBX_HELM_LOG,JSON.stringify(args)+"\\n");
fs.appendFileSync(process.env.BBX_OPERATION_LOG,"helm:"+args[0]+"\\n");
if(args[0]==="pull"){
  const destinationFlag=args.findIndex((arg)=>arg==="--destination"||arg==="-d");
  const destination=destinationFlag===-1?process.cwd():args[destinationFlag+1];
  const packageCount=Number(process.env.BBX_PACKAGE_COUNT||"1");
  if(process.env.BBX_PACKAGE_BASE64!=="missing"){
    fs.mkdirSync(destination,{recursive:true});
    const packageBytes=Buffer.from(process.env.BBX_PACKAGE_BASE64,"base64");
    for(let i=0;i<packageCount;i++) fs.writeFileSync(path.join(destination,i===0?"in-falcone-0.4.18.tgz":"unexpected-"+i+".tgz"),packageBytes);
  }
  process.stdout.write("Pulled: ghcr.io/gntik-ai/charts/in-falcone:0.4.18\\nDigest: "+process.env.BBX_MANIFEST_DIGEST+"\\n");
  process.exit(0);
}
if(args[0]==="upgrade") process.exit(0);
process.exit(64);
`,
  );
  chmodSync(helm, 0o755);
  return { log, operationLog, root };
}

function readInvocationLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function invokeDowngrade(
  platform,
  {
    packageBytes = packageBytesFixture,
    operatorDigest = packageDigest(packageBytes),
    packageCount = 1,
    manifestDigest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    argumentsOverride,
  } = {},
) {
  const asset = platformAssets[platform];
  requireExecutable(asset.script);
  assert.equal(existsSync(asset.values), true, `missing security values ${asset.values}`);
  const fakeHelm = fakeHelmEnvironment();
  const securityContext = platform === "vanilla" ? vanillaSecurity : openShiftSecurity;
  const fakeKubectl = fakeKubectlEnvironment(
    [
      expectedDeployment("control-plane-executor", securityContext),
      expectedDeployment("workflow-worker", securityContext),
      unrelatedDeployment(),
    ],
    [...affectedPods(), unrelatedPod()],
  );
  const result = spawnSync(
    asset.script,
    argumentsOverride ?? [
        "--namespace",
        namespace,
        "--release",
        release,
        "--version",
        historicalVersion,
        "--digest",
        operatorDigest,
      ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fakeKubectl.variables,
        BBX_HELM_LOG: fakeHelm.log,
        BBX_OPERATION_LOG: fakeHelm.operationLog,
        BBX_MANIFEST_DIGEST: manifestDigest,
        BBX_PACKAGE_BASE64:
          packageBytes === "missing" ? "missing" : Buffer.from(packageBytes).toString("base64"),
        BBX_PACKAGE_COUNT: String(packageCount),
        PATH: `${fakeHelm.root}:${fakeKubectl.root}:${process.env.PATH}`,
      },
    },
  );
  return {
    asset,
    helmInvocations: readInvocationLog(fakeHelm.log),
    kubectlInvocations: readInvocationLog(fakeKubectl.log),
    operationOrder: existsSync(fakeHelm.operationLog)
      ? readFileSync(fakeHelm.operationLog, "utf8").trim().split("\n").filter(Boolean)
      : [],
    result,
  };
}

function assertSuccessfulDowngrade(platform) {
  const invocation = invokeDowngrade(platform);
  assert.equal(invocation.result.status, 0, `${invocation.result.stdout}\n${invocation.result.stderr}`);
  assert.equal(invocation.helmInvocations.length, 2, "expected artifact preflight then upgrade");
  const [pullArgs, args] = invocation.helmInvocations;
  assert.equal(pullArgs[0], "pull", "exact OCI artifact must be inspected before upgrade");
  assert.equal(pullArgs.includes(chartReference), true);
  assert.deepEqual(pullArgs.slice(pullArgs.indexOf("--version"), pullArgs.indexOf("--version") + 2), [
    "--version",
    historicalVersion,
  ]);
  assert.equal(args[0], "upgrade", "downgrade must use fail-forward helm upgrade");
  assert.equal(args.includes("rollback"), false, "helm rollback is forbidden");
  assert.equal(
    args.includes("--reuse-values"),
    true,
    "downgrade must preserve the live release's unrelated values",
  );
  assert.equal(args.includes(release), true);
  assert.match(
    args[2] ?? "",
    /\/in-falcone-0\.4\.18\.tgz$/,
    "helm upgrade must consume the same downloaded .tgz whose bytes were verified",
  );
  assert.deepEqual(args.slice(args.indexOf("--namespace"), args.indexOf("--namespace") + 2), [
    "--namespace",
    namespace,
  ]);
  const valueFlag = args.findIndex((arg) => arg === "--values" || arg === "-f");
  assert.notEqual(valueFlag, -1, "downgrade must pass its platform security values file");
  assert.equal(resolve(args[valueFlag + 1]), invocation.asset.values);
  assert.equal(args.includes("--wait"), true, "downgrade must wait for workload convergence");
  const timeoutFlag = args.indexOf("--timeout");
  assert.notEqual(timeoutFlag, -1, "downgrade must use a finite Helm timeout");
  assert.match(
    args[timeoutFlag + 1] ?? "",
    /^[1-9][0-9]*(?:ms|s|m|h)(?:[0-9]+(?:ms|s|m|h))*$/,
    "Helm timeout must be a positive finite duration",
  );
  assert.equal(
    invocation.kubectlInvocations.some((entry) => entry.includes("deployments") || entry.includes("deployment")),
    true,
    "downgrade must invoke live Deployment verification by default",
  );
  assert.equal(
    invocation.kubectlInvocations.some((entry) => entry.includes("pods") || entry.includes("pod")),
    true,
    "downgrade must invoke live Pod verification by default",
  );
  if (platform === "vanilla") {
    assert.equal(
      invocation.kubectlInvocations.some(
        (entry) => entry.includes("namespace") || entry.includes("namespaces") || entry.includes("exec"),
      ),
      false,
      "vanilla verification must not use OpenShift namespace metadata or pod exec",
    );
  }
  assert.deepEqual(
    invocation.operationOrder.slice(0, 2),
    ["helm:pull", "helm:upgrade"],
    "artifact pull must precede upgrade",
  );
  assert.equal(
    invocation.operationOrder.findIndex((entry) => entry.startsWith("kubectl:")) > 1,
    true,
    "the public verifier must run only after helm upgrade returns successfully",
  );
}

function expectedDeployment(
  component,
  securityContext,
  {
    availableReplicas = 2,
    podSecurityContext = {},
    readyReplicas = 2,
    releaseName = release,
    updatedReplicas = 2,
  } = {},
) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: helmFullName(releaseName, component) },
    spec: {
      replicas: 2,
      template: {
        spec: {
          containers: [{ name: component, securityContext }],
          securityContext: podSecurityContext,
        },
      },
    },
    status: { availableReplicas, readyReplicas, updatedReplicas },
  };
}

function affectedPods({ releaseName = release, waitingReason = null } = {}) {
  return targetContainers.flatMap(({ name }) =>
    Array.from({ length: 2 }, (_, index) => ({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        annotations: { "openshift.io/scc": "restricted-v2" },
        labels: {
          "app.kubernetes.io/instance": releaseName,
          "app.kubernetes.io/name": name,
        },
        name: `${helmFullName(releaseName, name).slice(0, 57)}-${index}`,
      },
      status: {
        conditions: [{ status: "True", type: "Ready" }],
        containerStatuses: [
          {
            name,
            ready: waitingReason === null,
            state: waitingReason ? { waiting: { reason: waitingReason } } : { running: {} },
          },
        ],
        phase: "Running",
      },
    })),
  );
}

function unrelatedDeployment(releaseName = release) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: helmFullName(releaseName, "unrelated-service") },
    spec: {
      replicas: 7,
      template: {
        spec: {
          containers: [{ name: "unrelated-service", securityContext: { runAsUser: 0 } }],
        },
      },
    },
    status: { availableReplicas: 0 },
  };
}

function unrelatedPod(releaseName = release) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      labels: {
        "app.kubernetes.io/instance": releaseName,
        "app.kubernetes.io/name": "unrelated-service",
      },
      name: `${helmFullName(releaseName, "unrelated-service").slice(0, 61)}-0`,
    },
    status: {
      conditions: [{ status: "False", type: "Ready" }],
      containerStatuses: [
        {
          name: "unrelated-service",
          ready: false,
          state: { waiting: { reason: "CreateContainerConfigError" } },
        },
      ],
      phase: "Pending",
    },
  };
}

function targetPodCount(pods, component, count, releaseName = release) {
  const unrelated = pods.filter(
    (pod) => pod.metadata?.labels?.["app.kubernetes.io/name"] !== component,
  );
  const matching = pods.filter(
    (pod) => pod.metadata?.labels?.["app.kubernetes.io/name"] === component,
  );
  const selected = matching.slice(0, count);
  while (selected.length < count) {
    const clone = structuredClone(matching[0]);
    clone.metadata.name = `${helmFullName(releaseName, component).slice(0, 54)}-extra-${selected.length}`;
    selected.push(clone);
  }
  return [...unrelated, ...selected];
}

function fakeKubectlEnvironment(
  deployments,
  pods,
  {
    deploymentExitCode = 0,
    deploymentJson,
    execUids = Object.fromEntries(pods.map((pod, index) => [pod.metadata.name, 1000000001 + index])),
    namespaceExitCode = 0,
    namespaceJson,
    namespaceUidRange = "1000000000/10000",
    podExitCode = 0,
    podJson,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "bbx-fake-kubectl-"));
  const deploymentFixture = resolve(root, "deployments.json");
  const namespaceFixture = resolve(root, "namespace.json");
  const podFixture = resolve(root, "pods.json");
  const execFixture = resolve(root, "exec-uids.json");
  const log = resolve(root, "kubectl-args.jsonl");
  const kubectl = resolve(root, "kubectl");
  writeFileSync(
    deploymentFixture,
    deploymentJson ?? JSON.stringify({ apiVersion: "v1", items: deployments, kind: "List" }),
  );
  writeFileSync(
    namespaceFixture,
    namespaceJson ??
      JSON.stringify({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          annotations: namespaceUidRange
            ? { "openshift.io/sa.scc.uid-range": namespaceUidRange }
            : {},
          name: namespace,
        },
      }),
  );
  writeFileSync(
    podFixture,
    podJson ?? JSON.stringify({ apiVersion: "v1", items: pods, kind: "List" }),
  );
  writeFileSync(execFixture, JSON.stringify(execUids));
  writeFileSync(
    kubectl,
    `#!/usr/bin/env node
const fs=require("node:fs");
const a=process.argv.slice(2);
fs.appendFileSync(process.env.BBX_KUBECTL_LOG,JSON.stringify(a)+"\\n");
if(process.env.BBX_OPERATION_LOG) fs.appendFileSync(process.env.BBX_OPERATION_LOG,"kubectl:"+(a.includes("exec")?"exec":"get")+"\\n");
if(a.includes("deployment")||a.includes("deployments")){if(Number(process.env.BBX_DEPLOYMENTS_EXIT)!==0)process.exit(Number(process.env.BBX_DEPLOYMENTS_EXIT));process.stdout.write(fs.readFileSync(process.env.BBX_DEPLOYMENTS));process.exit(0)}
if(a.includes("pod")||a.includes("pods")){if(Number(process.env.BBX_PODS_EXIT)!==0)process.exit(Number(process.env.BBX_PODS_EXIT));process.stdout.write(fs.readFileSync(process.env.BBX_PODS));process.exit(0)}
if(a.includes("namespace")||a.includes("namespaces")){if(Number(process.env.BBX_NAMESPACE_EXIT)!==0)process.exit(Number(process.env.BBX_NAMESPACE_EXIT));process.stdout.write(fs.readFileSync(process.env.BBX_NAMESPACE));process.exit(0)}
if(a.includes("exec")){
  const pod=a[a.indexOf("exec")+1];
  const uids=JSON.parse(fs.readFileSync(process.env.BBX_EXEC_UIDS));
  if(!Object.hasOwn(uids,pod)||uids[pod]===null) process.exit(70);
  process.stdout.write(String(uids[pod])+"\\n");process.exit(0);
}
process.exit(64);
`,
  );
  chmodSync(kubectl, 0o755);
  return {
    log,
    root,
    variables: {
      BBX_DEPLOYMENTS: deploymentFixture,
      BBX_DEPLOYMENTS_EXIT: String(deploymentExitCode),
      BBX_EXEC_UIDS: execFixture,
      BBX_KUBECTL_LOG: log,
      BBX_NAMESPACE: namespaceFixture,
      BBX_NAMESPACE_EXIT: String(namespaceExitCode),
      BBX_PODS: podFixture,
      BBX_PODS_EXIT: String(podExitCode),
    },
  };
}

function verify(
  platform,
  deployments,
  pods = affectedPods(),
  kubectlOptions = {},
  releaseName = release,
) {
  requireExecutable(verifier);
  const fake = fakeKubectlEnvironment(deployments, pods, kubectlOptions);
  const result = spawnSync(
    verifier,
    ["--namespace", namespace, "--release", releaseName, "--platform", platform],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...fake.variables,
        PATH: `${fake.root}:${process.env.PATH}`,
      },
    },
  );
  return { invocations: readInvocationLog(fake.log), result };
}

function verifyArguments(argumentsOverride) {
  const fake = fakeKubectlEnvironment(
    [
      expectedDeployment("control-plane-executor", vanillaSecurity),
      expectedDeployment("workflow-worker", vanillaSecurity),
    ],
    affectedPods(),
  );
  const result = spawnSync(verifier, argumentsOverride, {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...fake.variables,
      PATH: `${fake.root}:${process.env.PATH}`,
    },
  });
  return { invocations: readInvocationLog(fake.log), result };
}

function assertVerifierRejection(observation, code) {
  assert.notEqual(observation.result.status, 0);
  assert.match(
    observation.result.stderr,
    new RegExp(`(?:^|\\s)${code}(?:\\s|$)`),
    `expected stable secret-safe diagnostic ${code}`,
  );
}

const vanillaSecurity = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
  runAsGroup: 1000,
  runAsNonRoot: true,
  runAsUser: 1000,
};
const openShiftSecurity = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
};

// bbx-node-image-identity-008 | fn-deployment-packaging-node-downgrade | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("vanilla downgrade asset upgrades the explicit 0.4.18 OCI artifact with numeric security values", () => {
  assertSuccessfulDowngrade("vanilla");
  const documents = renderHistorical(platformAssets.vanilla.values);
  for (const target of targetContainers) {
    const app = container(deployment(documents, target.deployment), target.name);
    assert.equal(app.securityContext?.runAsUser, 1000);
    assert.equal(app.securityContext?.runAsGroup, 1000);
    assert.equal(app.securityContext?.runAsNonRoot, true);
  }
});

// bbx-node-image-identity-009 | fn-deployment-packaging-node-downgrade | OpenSpec #### Scenario: OpenShift rollback preserves SCC authority
test("OpenShift downgrade asset upgrades the explicit 0.4.18 OCI artifact without fixed identities", () => {
  assertSuccessfulDowngrade("openshift");
  const documents = renderHistorical(platformAssets.openshift.values);
  for (const target of targetContainers) {
    const workload = deployment(documents, target.deployment);
    const app = container(workload, target.name);
    assert.equal(Object.hasOwn(workload.spec?.template?.spec?.securityContext ?? {}, "runAsUser"), false);
    assert.equal(Object.hasOwn(workload.spec?.template?.spec?.securityContext ?? {}, "runAsGroup"), false);
    assert.equal(Object.hasOwn(app.securityContext ?? {}, "runAsUser"), false);
    assert.equal(Object.hasOwn(app.securityContext ?? {}, "runAsGroup"), false);
    assert.equal(app.securityContext?.runAsNonRoot, true);
  }
});

// bbx-node-image-identity-010 | fn-deployment-packaging-node-downgrade-verification | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("public verifier accepts only the exact available vanilla Node workloads and fails closed", () => {
  const valid = [
    expectedDeployment("control-plane-executor", vanillaSecurity),
    expectedDeployment("workflow-worker", vanillaSecurity),
    unrelatedDeployment(),
  ];
  const pods = [...affectedPods(), unrelatedPod()];
  const accepted = verify("vanilla", valid, pods);
  assert.equal(accepted.result.status, 0);
  assert.equal(
    accepted.invocations.some(
      (entry) => entry.includes("namespace") || entry.includes("namespaces") || entry.includes("exec"),
    ),
    false,
    "vanilla verification must not depend on OpenShift-only public APIs",
  );

  const duplicateTarget = [...valid, structuredClone(valid[0])];
  assert.notEqual(
    verify("vanilla", duplicateTarget, pods).result.status,
    0,
    "duplicate target Deployments must fail closed while unrelated Deployments are ignored",
  );

  const wrongIdentity = structuredClone(valid);
  wrongIdentity[0].spec.template.spec.containers[0].securityContext.runAsUser = 999;
  assert.notEqual(verify("vanilla", wrongIdentity, pods).result.status, 0);

  const unavailable = structuredClone(valid);
  unavailable[1].status.availableReplicas = 1;
  assert.notEqual(verify("vanilla", unavailable, pods).result.status, 0);

  const missingReady = structuredClone(valid);
  delete missingReady[0].status.readyReplicas;
  assert.notEqual(verify("vanilla", missingReady, pods).result.status, 0);

  const missingUpdated = structuredClone(valid);
  delete missingUpdated[1].status.updatedReplicas;
  assert.notEqual(verify("vanilla", missingUpdated, pods).result.status, 0);

  const wrongContainer = structuredClone(valid);
  wrongContainer[1].spec.template.spec.containers[0].name = "unexpected-worker";
  assert.notEqual(verify("vanilla", wrongContainer, pods).result.status, 0);

  for (const count of [1, 3]) {
    assert.notEqual(
      verify("vanilla", valid, targetPodCount(pods, "control-plane-executor", count)).result.status,
      0,
      `vanilla verification requires exactly two target pods, not ${count}`,
    );
  }

  const wrongStatus = structuredClone(pods);
  wrongStatus[0].status.containerStatuses[0].state = { terminated: { exitCode: 0 } };
  assert.notEqual(verify("vanilla", valid, wrongStatus).result.status, 0);

  const wrongStatusName = structuredClone(pods);
  wrongStatusName[0].status.containerStatuses[0].name = "unexpected-container";
  assert.notEqual(verify("vanilla", valid, wrongStatusName).result.status, 0);

  const notReady = structuredClone(pods);
  notReady[0].status.conditions[0].status = "False";
  notReady[0].status.containerStatuses[0].ready = false;
  assert.notEqual(verify("vanilla", valid, notReady).result.status, 0);

  assert.notEqual(
    verify("vanilla", valid, affectedPods({ waitingReason: "CreateContainerConfigError" })).result.status,
    0,
  );
});

// bbx-node-image-identity-014 | fn-deployment-packaging-node-downgrade-verification | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("verifier enforces complete hardening, Helm-compatible long names, and stable diagnostics", () => {
  const longDeployments = [
    expectedDeployment("control-plane-executor", vanillaSecurity, { releaseName: longRelease }),
    expectedDeployment("workflow-worker", vanillaSecurity, { releaseName: longRelease }),
    unrelatedDeployment(longRelease),
  ];
  const longPods = [...affectedPods({ releaseName: longRelease }), unrelatedPod(longRelease)];
  assert.equal(verify("vanilla", longDeployments, longPods, {}, longRelease).result.status, 0);
  for (const component of ["control-plane-executor", "workflow-worker"]) {
    const expectedName = helmFullName(longRelease, component);
    assert.equal(expectedName.length <= 63, true);
    assert.equal(expectedName.endsWith("-"), false);
    assert.equal(longDeployments.some((workload) => workload.metadata.name === expectedName), true);
  }

  const base = [
    expectedDeployment("control-plane-executor", vanillaSecurity),
    expectedDeployment("workflow-worker", vanillaSecurity),
  ];
  const hardeningDrifts = [
    ["runAsNonRoot", false],
    ["allowPrivilegeEscalation", true],
    ["readOnlyRootFilesystem", false],
    ["capabilities", { drop: ["ALL", "NET_RAW"] }],
  ];
  for (const [field, value] of hardeningDrifts) {
    const drifted = structuredClone(base);
    drifted[0].spec.template.spec.containers[0].securityContext[field] = value;
    assertVerifierRejection(verify("vanilla", drifted), "NODE_VERIFY_HARDENING");
  }

  const wrongIdentity = structuredClone(base);
  wrongIdentity[0].spec.template.spec.containers[0].securityContext.runAsUser = 999;
  assertVerifierRejection(verify("vanilla", wrongIdentity), "NODE_VERIFY_IDENTITY");

  const unavailable = structuredClone(base);
  unavailable[0].status.availableReplicas = 1;
  assertVerifierRejection(verify("vanilla", unavailable), "NODE_VERIFY_AVAILABILITY");

  assertVerifierRejection(
    verify("vanilla", base, targetPodCount(affectedPods(), "workflow-worker", 1)),
    "NODE_VERIFY_PODS",
  );

  const emptyRelease = spawnSync(
    verifier,
    ["--namespace", namespace, "--release", "", "--platform", "vanilla"],
    { cwd: repoRoot, encoding: "utf8", env: { ...process.env, PATH: process.env.PATH } },
  );
  assert.notEqual(emptyRelease.status, 0);
  assert.match(emptyRelease.stderr, /NODE_VERIFY_INPUT/);
});

// bbx-node-image-identity-011 | fn-deployment-packaging-node-downgrade-verification | OpenSpec #### Scenario: OpenShift rollback preserves SCC authority
test("public verifier accepts SCC-owned available workloads and rejects fixed identities or pod startup errors", () => {
  const valid = [
    expectedDeployment("control-plane-executor", openShiftSecurity),
    expectedDeployment("workflow-worker", openShiftSecurity),
    unrelatedDeployment(),
  ];
  const pods = [...affectedPods(), unrelatedPod()];
  const accepted = verify("openshift", valid, pods);
  assert.equal(accepted.result.status, 0);
  assert.equal(
    accepted.invocations.some((entry) => entry.includes("namespace") || entry.includes("namespaces")),
    true,
    "OpenShift verification must read the namespace UID range",
  );
  assert.equal(
    accepted.invocations.filter((entry) => entry.includes("exec")).length,
    4,
    "OpenShift verification must read the effective UID in exactly two pods per component",
  );
  assert.equal(
    accepted.invocations.some((entry) => entry.includes(`${release}-unrelated-service-0`) && entry.includes("exec")),
    false,
    "OpenShift verification must not exec into unrelated same-release pods",
  );

  const duplicateTarget = [...valid, structuredClone(valid[1])];
  assert.notEqual(
    verify("openshift", duplicateTarget, pods).result.status,
    0,
    "duplicate target Deployments must fail closed while unrelated Deployments are ignored",
  );

  const fixedIdentity = structuredClone(valid);
  fixedIdentity[0].spec.template.spec.containers[0].securityContext.runAsUser = 1000;
  assert.notEqual(verify("openshift", fixedIdentity, pods).result.status, 0);

  for (const field of ["runAsUser", "runAsGroup"]) {
    const fixedPodIdentity = structuredClone(valid);
    fixedPodIdentity[0].spec.template.spec.securityContext[field] = 1000;
    assertVerifierRejection(
      verify("openshift", fixedPodIdentity, pods),
      "NODE_VERIFY_PLATFORM",
    );
  }

  const hardeningDrifts = [
    ["runAsNonRoot", false],
    ["allowPrivilegeEscalation", true],
    ["readOnlyRootFilesystem", false],
    ["capabilities", { drop: [] }],
  ];
  for (const [field, value] of hardeningDrifts) {
    const drifted = structuredClone(valid);
    drifted[1].spec.template.spec.containers[0].securityContext[field] = value;
    assertVerifierRejection(
      verify("openshift", drifted, pods),
      "NODE_VERIFY_HARDENING",
    );
  }

  const unavailable = structuredClone(valid);
  unavailable[0].status.availableReplicas = 1;
  assert.notEqual(verify("openshift", unavailable, pods).result.status, 0);

  const missingReady = structuredClone(valid);
  delete missingReady[0].status.readyReplicas;
  assert.notEqual(verify("openshift", missingReady, pods).result.status, 0);

  const missingUpdated = structuredClone(valid);
  delete missingUpdated[1].status.updatedReplicas;
  assert.notEqual(verify("openshift", missingUpdated, pods).result.status, 0);

  assert.notEqual(
    verify("openshift", valid, pods, { namespaceUidRange: null }).result.status,
    0,
    "missing openshift.io/sa.scc.uid-range must fail closed",
  );

  const outOfRangeUids = Object.fromEntries(
    pods.map((pod, index) => [pod.metadata.name, index === 0 ? 999999999 : 1000000001 + index]),
  );
  assert.notEqual(
    verify("openshift", valid, pods, { execUids: outOfRangeUids }).result.status,
    0,
    "an effective UID outside the namespace range must fail closed",
  );

  const execErrorUids = Object.fromEntries(
    pods.map((pod, index) => [pod.metadata.name, index === 0 ? null : 1000000001 + index]),
  );
  assert.notEqual(
    verify("openshift", valid, pods, { execUids: execErrorUids }).result.status,
    0,
    "a failed effective-UID query must fail closed",
  );

  const missingPod = pods.slice(1);
  assert.notEqual(
    verify("openshift", valid, missingPod).result.status,
    0,
    "OpenShift verification requires exactly two Running/Ready pods per component",
  );

  const extraTargetPod = targetPodCount(pods, "workflow-worker", 3);
  assert.notEqual(
    verify("openshift", valid, extraTargetPod).result.status,
    0,
    "OpenShift verification rejects a third target pod",
  );

  const wrongStatusName = structuredClone(pods);
  wrongStatusName[0].status.containerStatuses[0].name = "unexpected-container";
  assert.notEqual(verify("openshift", valid, wrongStatusName).result.status, 0);

  const notReady = structuredClone(pods);
  notReady[0].status.containerStatuses[0].ready = false;
  notReady[0].status.conditions[0].status = "False";
  assert.notEqual(verify("openshift", valid, notReady).result.status, 0);

  const missingScc = structuredClone(pods);
  delete missingScc[0].metadata.annotations["openshift.io/scc"];
  assert.notEqual(
    verify("openshift", valid, missingScc).result.status,
    0,
    "OpenShift verification requires restricted-v2 admission evidence on every affected pod",
  );

  assert.notEqual(
    verify("openshift", valid, affectedPods({ waitingReason: "CreateContainerConfigError" })).result.status,
    0,
  );
});

// bbx-node-image-identity-017 | fn-deployment-packaging-node-downgrade-verification | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("verifier maps public input, Kubernetes, JSON, Pod, and OpenShift failures to stable categories", () => {
  for (const argumentsOverride of [
    ["--unknown"],
    [
      "--namespace",
      namespace,
      "--release",
      release,
      "--platform",
    ],
  ]) {
    const observation = verifyArguments(argumentsOverride);
    assert.equal(observation.result.status, 64);
    assert.equal(observation.result.stderr.trim(), "NODE_VERIFY_INPUT");
    assert.equal(observation.invocations.length, 0);
  }

  const vanillaDeployments = [
    expectedDeployment("control-plane-executor", vanillaSecurity),
    expectedDeployment("workflow-worker", vanillaSecurity),
  ];
  const vanillaPods = affectedPods();
  assertVerifierRejection(
    verify("vanilla", vanillaDeployments, vanillaPods, { deploymentExitCode: 70 }),
    "NODE_VERIFY_AVAILABILITY",
  );
  assertVerifierRejection(
    verify("vanilla", vanillaDeployments, vanillaPods, { podExitCode: 70 }),
    "NODE_VERIFY_PODS",
  );
  assertVerifierRejection(
    verify("vanilla", vanillaDeployments, vanillaPods, { deploymentJson: "not-json" }),
    "NODE_VERIFY_AVAILABILITY",
  );
  assertVerifierRejection(
    verify("vanilla", vanillaDeployments, vanillaPods, { podJson: "not-json" }),
    "NODE_VERIFY_PODS",
  );
  assertVerifierRejection(
    verify(
      "vanilla",
      vanillaDeployments,
      affectedPods({ waitingReason: "CreateContainerConfigError" }),
    ),
    "NODE_VERIFY_PODS",
  );

  const openShiftDeployments = [
    expectedDeployment("control-plane-executor", openShiftSecurity),
    expectedDeployment("workflow-worker", openShiftSecurity),
  ];
  const openShiftPods = affectedPods();
  for (const kubectlOptions of [
    { namespaceExitCode: 70 },
    { namespaceJson: "not-json" },
    { namespaceUidRange: null },
    { namespaceUidRange: "not-a-range" },
    {
      execUids: Object.fromEntries(
        openShiftPods.map((pod, index) => [
          pod.metadata.name,
          index === 0 ? null : 1000000001 + index,
        ]),
      ),
    },
  ]) {
    assertVerifierRejection(
      verify("openshift", openShiftDeployments, openShiftPods, kubectlOptions),
      "NODE_VERIFY_PLATFORM",
    );
  }
  const missingScc = structuredClone(openShiftPods);
  delete missingScc[0].metadata.annotations["openshift.io/scc"];
  assertVerifierRejection(
    verify("openshift", openShiftDeployments, missingScc),
    "NODE_VERIFY_PLATFORM",
  );
});

// bbx-node-image-identity-013 | fn-deployment-packaging-node-downgrade | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("missing or mismatched downloaded-package digest blocks downgrade before helm upgrade", () => {
  for (const scenario of [
    { label: "missing operator digest", operatorDigest: "" },
    {
      label: "missing downloaded package despite matching Digest output",
      manifestDigest: operatorDigestFixture,
      packageBytes: "missing",
    },
    { label: "more than one downloaded package", packageCount: 2 },
    { label: "downloaded package byte mismatch", packageBytes: "different package bytes\n" },
  ]) {
    const invocation = invokeDowngrade("vanilla", scenario);
    assert.notEqual(invocation.result.status, 0);
    assert.equal(
      invocation.helmInvocations.some((args) => args[0] === "upgrade"),
      false,
      `${scenario.label} must block before upgrade`,
    );
    assert.equal(
      invocation.kubectlInvocations.length,
      0,
      "a rejected artifact must not proceed to live verification",
    );
    assert.match(
      invocation.result.stderr,
      /NODE_DOWNGRADE_(?:INPUT|PROVENANCE)/,
      "package rejection must emit a stable secret-safe provenance diagnostic",
    );
  }
});

// bbx-node-image-identity-015 | fn-deployment-packaging-node-downgrade | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("a byte-attested package with the wrong chart name or version is rejected before mutation", () => {
  const cases = [
    {
      label: "wrong chart name",
      packageBytes: minimalChartPackage("not-in-falcone", historicalVersion),
      platform: "vanilla",
    },
    {
      label: "wrong chart version",
      packageBytes: minimalChartPackage("in-falcone", "0.4.17"),
      platform: "openshift",
    },
  ];
  for (const scenario of cases) {
    const invocation = invokeDowngrade(scenario.platform, {
      packageBytes: scenario.packageBytes,
    });
    assert.equal(
      invocation.result.status,
      65,
      `${scenario.label} must be a provenance rejection`,
    );
    assert.equal(invocation.result.stderr.trim(), "NODE_DOWNGRADE_PROVENANCE");
    assert.deepEqual(
      invocation.helmInvocations.map((args) => args[0]),
      ["pull"],
      `${scenario.label} must block before helm upgrade`,
    );
    assert.equal(
      invocation.kubectlInvocations.length,
      0,
      `${scenario.label} must block before live verification`,
    );
  }
});

// bbx-node-image-identity-016 | fn-deployment-packaging-node-downgrade | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("unknown arguments and required flags without values fail as stable input errors before mutation", () => {
  const cases = [
    { argumentsOverride: ["--unknown"], label: "unknown argument" },
    {
      argumentsOverride: [
        "--namespace",
        namespace,
        "--release",
        release,
        "--version",
        historicalVersion,
        "--digest",
      ],
      label: "required digest without value",
    },
  ];
  for (const platform of ["vanilla", "openshift"]) {
    for (const scenario of cases) {
      const invocation = invokeDowngrade(platform, scenario);
      assert.equal(invocation.result.status, 64, `${scenario.label} must be an input rejection`);
      assert.equal(invocation.result.stderr.trim(), "NODE_DOWNGRADE_INPUT");
      assert.equal(invocation.helmInvocations.length, 0);
      assert.equal(invocation.kubectlInvocations.length, 0);
      assert.equal(invocation.operationOrder.length, 0);
    }
  }
});

// bbx-node-image-identity-012 | fn-deployment-packaging-node-downgrade-docs | OpenSpec #### Scenario: Vanilla Kubernetes rollback preserves startup compatibility
test("operator docs invoke both exact fail-forward downgrade assets and verifier without helm rollback", () => {
  const docs = readFileSync(docsPath, "utf8");
  const bash = [...docs.matchAll(/```bash\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1])
    .join("\n");
  const commands = bash
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  assert.match(
    bash,
    /helm\s+pull\s+oci:\/\/ghcr\.io\/gntik-ai\/charts\/in-falcone[\s\S]*--version\s+0\.4\.18/,
  );
  assert.match(bash, /PACKAGE_TGZ=.*in-falcone-0\.4\.18\.tgz/);
  assert.match(
    bash,
    /PACKAGE_DIGEST=.*sha256sum\s+"?\$PACKAGE_TGZ"?/,
    "docs must derive PACKAGE_DIGEST from the downloaded .tgz bytes",
  );
  for (const platform of ["vanilla", "openshift"]) {
    const helperCommand = commands.find((line) =>
      line.startsWith(`tools/downgrade-node-workloads-${platform}.sh`),
    );
    assert.ok(helperCommand, `docs need a ${platform} helper command`);
    assert.match(helperCommand, /--namespace\s+"?\$NAMESPACE"?/);
    assert.match(helperCommand, /--release\s+"?\$RELEASE"?/);
    assert.match(helperCommand, /--version\s+0\.4\.18/);
    assert.match(helperCommand, /--digest\s+"?\$PACKAGE_DIGEST"?/);

    const verifierCommand = commands.find(
      (line) =>
        line.startsWith("tools/verify-node-workloads.sh") &&
        new RegExp(`--platform\\s+${platform}(?:\\s|$)`).test(line),
    );
    assert.ok(verifierCommand, `docs need a ${platform} verifier command`);
    assert.match(verifierCommand, /--namespace\s+"?\$NAMESPACE"?/);
    assert.match(verifierCommand, /--release\s+"?\$RELEASE"?/);
  }
  assert.doesNotMatch(docs, /helm\s+rollback/i);
});
