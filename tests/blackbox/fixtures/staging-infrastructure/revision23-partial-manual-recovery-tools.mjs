#!/usr/bin/env node

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const helperPath = fileURLToPath(import.meta.url);
const helperDirectory = path.dirname(helperPath);
const repositoryRoot = path.resolve(helperDirectory, "../../../..");
const recoveryScript = path.join(
  repositoryRoot,
  "charts/in-falcone/migrations/revision-20-forward-recovery.sh"
);
const exactFixturePath = path.join(helperDirectory, "revision23-partial-manual-recovery.json");
const exactConfirmation =
  "default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.11/" +
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const baseFixture = JSON.parse(fs.readFileSync(exactFixturePath, "utf8"));

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

const evidenceDocument = (kind, now, validUntil) => ({
  apiVersion: "falcone.gntik.ai/v1",
  kind,
  target: {
    context: "default",
    namespace: "in-falcone-staging",
    release: "falcone",
    revision: 20,
    chart: "in-falcone-0.4.1"
  },
  repair: {
    chart: "in-falcone-0.4.11",
    packageDigest: baseFixture.packageDigest
  },
  evidence: {
    observedAt: now,
    validUntil,
    verified: true,
    reference: kind === "Revision20BackupEvidence"
      ? "bbx://revision23-partial-manual-recovery/backup"
      : "bbx://revision23-partial-manual-recovery/parity",
    ...(kind === "Revision20ParityEvidence"
      ? {backupReference: "bbx://revision23-partial-manual-recovery/backup"}
      : {})
  }
});

function runRecovery({mutate = () => {}, confirmation = exactConfirmation} = {}) {
  const scenarioDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "falcone-bbx-r23-partial-"));
  const binDirectory = path.join(scenarioDirectory, "bin");
  const scenarioFixturePath = path.join(scenarioDirectory, "fixture.json");
  const statePath = path.join(scenarioDirectory, "state.json");
  const tracePath = path.join(scenarioDirectory, "trace.log");
  const mutationPath = path.join(scenarioDirectory, "mutations.log");
  const backupPath = path.join(scenarioDirectory, "backup.json");
  const parityPath = path.join(scenarioDirectory, "parity.json");

  fs.mkdirSync(binDirectory);
  const fixture = structuredClone(baseFixture);
  mutate(fixture);
  fs.writeFileSync(scenarioFixturePath, `${JSON.stringify(fixture)}\n`);
  fs.writeFileSync(statePath, '{"upgrades":0}\n');
  fs.writeFileSync(tracePath, "");
  fs.writeFileSync(mutationPath, "");

  const now = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify(evidenceDocument("Revision20BackupEvidence", now, validUntil))}\n`
  );
  fs.writeFileSync(
    parityPath,
    `${JSON.stringify(evidenceDocument("Revision20ParityEvidence", now, validUntil))}\n`
  );

  for (const command of ["helm", "kubectl", "sha256sum"]) {
    const wrapper = path.join(binDirectory, command);
    fs.writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(helperPath)} ${command} "$@"\n`,
      {mode: 0o755}
    );
  }

  try {
    const result = spawnSync(
      recoveryScript,
      [
        "--apply",
        "--confirm-target",
        confirmation,
        "--backup-attestation",
        backupPath,
        "--parity-attestation",
        parityPath
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          FALCONE_BBX_FIXTURE: scenarioFixturePath,
          FALCONE_BBX_STATE: statePath,
          FALCONE_BBX_TRACE: tracePath,
          FALCONE_BBX_MUTATIONS: mutationPath
        },
        timeout: 20_000
      }
    );
    return {
      ...result,
      trace: fs.readFileSync(tracePath, "utf8"),
      mutations: fs.readFileSync(mutationPath, "utf8")
    };
  } finally {
    fs.rmSync(scenarioDirectory, {recursive: true, force: true});
  }
}

function assertRejectedBeforeMutation(result, drift) {
  assert.notEqual(
    result.status,
    0,
    `${drift} must fail closed before mutation\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.equal(
    result.mutations,
    "",
    `${drift} reached a mutating public operation:\n${result.mutations}`
  );
}

function assertRejectedAfterFirstPhaseAUpgrade(result, drift) {
  assert.notEqual(
    result.status,
    0,
    `${drift} must fail its live convergence health gate\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  assert.match(
    result.stderr,
    /(?:PHASE_A_HEALTH_GATE_FAILED|FINAL_HEALTH_GATE_FAILED)/,
    `${drift} must report the Phase-A or final health gate`
  );
  const upgrades = result.mutations.split("\n").filter((line) => line.startsWith("helm upgrade "));
  assert.deepEqual(
    upgrades,
    ["helm upgrade release=falcone version=0.4.11"],
    `${drift} must stop after exactly the first Phase-A upgrade`
  );
}

export function registerRevision23PartialManualRecoveryContract() {
  test("bbx-repair-staging-057 admits only the exact revision-23 partial manual recovery", async (t) => {
    await t.test("admits the exact partial recovery and applies immutable chart 0.4.11", () => {
      const result = runRecovery();

      assert.equal(
        result.status,
        0,
        [
          "the exact revision-23 partial manual recovery must be admitted",
          `stdout:\n${result.stdout}`,
          `stderr:\n${result.stderr}`,
          `public trace:\n${result.trace}`
        ].join("\n")
      );
      assert.match(
        result.stdout,
        /phase-a=applied revision=25 chart=in-falcone-0\.4\.11 package-digest=sha256:b{64}/
      );
      assert.deepEqual(
        result.mutations.trim().split("\n"),
        [
          "helm upgrade release=falcone version=0.4.11",
          "helm upgrade release=falcone version=0.4.11"
        ]
      );
      assert.doesNotMatch(result.trace, /helm (rollback|uninstall)|kubectl .* (delete|scale) /);
      assert.doesNotMatch(result.trace, /helm get manifest|kubectl .* get secret(?:s)?(?:\s|$)/);
      assert.match(
        result.trace,
        /kubectl .*\bget (?:replicasets?(?:\.apps)?|rs)\b.*(?:^|\s)-o json(?:\s|$)/m,
        "partial-manual recovery must query the public APISIX ReplicaSet owner chain"
      );
    });

    const driftCases = [
      {
        name: "rejects rendered APISIX runAsGroup drift before Phase-A apply",
        mutate: (fixture) => {
          fixture.renderedApisixPodSecurityContext.runAsGroup = 637;
          fixture.renderedApisixContainerSecurityContext.runAsGroup = 637;
        }
      },
      {
        name: "rejects a duplicate invalid rendered APISIX Deployment before Phase-A apply",
        mutate: (fixture) => {
          fixture.renderedChartVariants.duplicateApisixDeployment = true;
        }
      },
      {
        name: "rejects rendered APISIX contract fields misplaced on a sidecar and decoy volume",
        mutate: (fixture) => {
          fixture.renderedChartVariants.misplacedApisixContract = true;
        }
      },
      {
        name: "rejects an unexpected APISIX runAsGroup",
        mutate: (fixture) => {
          fixture.deployments["falcone-apisix"].spec.template.spec.securityContext.runAsGroup = 636;
        }
      },
      {
        name: "rejects a missing APISIX standalone-config mount",
        mutate: (fixture) => {
          fixture.deployments["falcone-apisix"].spec.template.spec.containers[0].volumeMounts = [];
        }
      },
      {
        name: "rejects a different APISIX standalone ConfigMap",
        mutate: (fixture) => {
          fixture.deployments["falcone-apisix"].spec.template.spec.volumes[0].configMap.name =
            "falcone-apisix-unexpected";
        }
      },
      {
        name: "rejects APISIX status.user.linux UID or GID drift",
        mutate: (fixture) => {
          fixture.pods[0].status.containerStatuses[0].user.linux.uid = 637;
          fixture.pods[0].status.containerStatuses[0].user.linux.gid = 637;
        }
      },
      {
        name: "rejects APISIX Pod cardinality drift",
        mutate: (fixture) => {
          fixture.pods = fixture.pods.filter((pod) => pod.metadata.name !== "falcone-apisix-7d636-c");
        }
      },
      {
        name: "rejects APISIX Pod ReplicaSet owner UID drift",
        mutate: (fixture) => {
          fixture.pods[0].metadata.ownerReferences[0].uid = "replicaset-falcone-apisix-wrong-uid";
        }
      },
      {
        name: "rejects APISIX ReplicaSet Deployment owner UID drift",
        mutate: (fixture) => {
          fixture.replicaSets[0].metadata.ownerReferences[0].uid = "deployment-falcone-apisix-wrong-uid";
        }
      },
      {
        name: "rejects APISIX ReplicaSet Deployment owner name drift",
        mutate: (fixture) => {
          fixture.replicaSets[0].metadata.ownerReferences[0].name = "falcone-apisix-other";
        }
      },
      {
        name: "rejects APISIX ReplicaSet deployment revision and generation drift",
        mutate: (fixture) => {
          fixture.replicaSets[0].metadata.annotations["deployment.kubernetes.io/revision"] = "6";
        }
      },
      {
        name: "rejects APISIX standalone ConfigMap defaultMode drift",
        mutate: (fixture) => {
          fixture.deployments["falcone-apisix"].spec.template.spec.volumes[0].configMap.defaultMode = 384;
        }
      },
      {
        name: "rejects APISIX standalone ConfigMap content drift",
        mutate: (fixture) => {
          fixture.configMaps["falcone-apisix-standalone"].data["apisix.yaml"] =
            "routes:\n  - id: unexpected\n#END";
        }
      },
      {
        name: "rejects any observability evidence change",
        mutate: (fixture) => {
          fixture.deployments["falcone-observability"].status.readyReplicas = 0;
        }
      },
      {
        name: "rejects another global named-user CreateContainerConfigError",
        mutate: (fixture) => {
          fixture.extraGlobalPods = [{
            apiVersion: "v1",
            kind: "Pod",
            metadata: {
              name: "unrelated-named-user-failure",
              namespace: "other-test-namespace",
              labels: {},
              ownerReferences: [{
                apiVersion: "apps/v1",
                kind: "ReplicaSet",
                name: "unrelated",
                controller: true
              }]
            },
            spec: {
              containers: [{name: "unrelated", image: "example.invalid/unrelated:fixture"}]
            },
            status: {
              phase: "Pending",
              containerStatuses: [{
                name: "unrelated",
                ready: false,
                restartCount: 0,
                state: {
                  waiting: {
                    reason: "CreateContainerConfigError",
                    message: "container has runAsNonRoot and image has non-numeric user (daemon), cannot verify user is non-root"
                  }
                }
              }]
            }
          }];
        }
      }
    ];

    for (const drift of driftCases) {
      await t.test(drift.name, () => {
        assertRejectedBeforeMutation(runRecovery({mutate: drift.mutate}), drift.name);
      });
    }

    await t.test("rejects APISIX live runAsGroup drift after the first Phase-A upgrade", () => {
      const result = runRecovery({
        mutate: (fixture) => {
          fixture.convergedApisixPodSecurityContext.runAsGroup = 637;
          fixture.convergedApisixContainerSecurityContext.runAsGroup = 637;
        }
      });
      assertRejectedAfterFirstPhaseAUpgrade(result, "converged APISIX runAsGroup drift");
    });

    await t.test("rejects observability container runAsGroup drift after the first Phase-A upgrade", () => {
      const result = runRecovery({
        mutate: (fixture) => {
          fixture.convergedObservabilityContainerSecurityContext.runAsGroup = 65535;
        }
      });
      assertRejectedAfterFirstPhaseAUpgrade(result, "converged observability container runAsGroup drift");
    });

    await t.test("rejects the historical 0.4.10 confirmation for this recovery", () => {
      const result = runRecovery({
        confirmation:
          "default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.10/" +
          baseFixture.packageDigest
      });
      assertRejectedBeforeMutation(result, "historical target confirmation 0.4.10");
    });
  });
}

const [tool, ...args] = process.argv.slice(2);
if (tool === "helm" || tool === "kubectl" || tool === "sha256sum") {
const fixturePath = process.env.FALCONE_BBX_FIXTURE;
const statePath = process.env.FALCONE_BBX_STATE;
const tracePath = process.env.FALCONE_BBX_TRACE;
const mutationPath = process.env.FALCONE_BBX_MUTATIONS;

if (!tool || !fixturePath || !statePath || !tracePath || !mutationPath) {
  process.stderr.write("fake public tool configuration is incomplete\n");
  process.exit(97);
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const append = (file, line) => fs.appendFileSync(file, `${line}\n`);
append(tracePath, `${tool} ${args.join(" ")}`);

if (tool === "sha256sum") {
  const input = fs.readFileSync(0);
  const digest = input.equals(Buffer.from("routes: []\n#END"))
    ? "28aa61f223b1306a9604817f44abf6c8c1c867e6ba9020bc9ff85235dd2c555b"
    : createHash("sha256").update(input).digest("hex");
  process.stdout.write(`${digest}  -\n`);
  process.exit(0);
}

const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const json = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const assertTargetVersion = () => {
  const version = option("--version");
  if (version !== fixture.targetVersion) {
    fail(`FAKE_TARGET_VERSION_MISMATCH expected=${fixture.targetVersion} actual=${version ?? "missing"}`);
  }
};
const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const writeState = (state) => fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);

const externalSecretSpec = (name) => ({
  refreshInterval: "1h",
  secretStoreRef: {
    kind: "ClusterSecretStore",
    name: "openbao-backend"
  },
  target: {
    name,
    creationPolicy: "Owner",
    deletionPolicy: "Retain"
  },
  data: []
});

const externalSecrets = () => fixture.externalSecretNames.map((name, index) => ({
  apiVersion: "external-secrets.io/v1beta1",
  kind: "ExternalSecret",
  metadata: {
    name,
    namespace: fixture.release.namespace,
    uid: `external-secret-${index + 1}`,
    resourceVersion: `${1000 + index}`,
    labels: {
      "app.kubernetes.io/managed-by": "Helm"
    },
    annotations: {
      "meta.helm.sh/release-name": fixture.release.name,
      "meta.helm.sh/release-namespace": fixture.release.namespace
    }
  },
  spec: externalSecretSpec(name),
  status: {
    conditions: [
      {
        type: "Ready",
        status: "True"
      }
    ]
  }
}));

const renderedApisixDeployment = () => {
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name: "falcone-apisix",
      namespace: fixture.release.namespace,
      labels: {
        "app.kubernetes.io/instance": fixture.release.name,
        "app.kubernetes.io/name": "apisix"
      }
    },
    spec: {
      replicas: 3,
      selector: {
        matchLabels: {
          "app.kubernetes.io/instance": fixture.release.name,
          "app.kubernetes.io/name": "apisix"
        }
      },
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/instance": fixture.release.name,
            "app.kubernetes.io/name": "apisix"
          }
        },
        spec: {
          securityContext: structuredClone(fixture.renderedApisixPodSecurityContext),
          containers: [{
            name: "apisix",
            image: "docker.io/apache/apisix:3.10.0-debian",
            securityContext: structuredClone(fixture.renderedApisixContainerSecurityContext),
            volumeMounts: [{
              name: "standalone-config",
              mountPath: "/usr/local/apisix/conf/apisix.yaml",
              subPath: "apisix.yaml"
            }]
          }],
          volumes: [{
            name: "standalone-config",
            configMap: {
              name: "falcone-apisix-standalone",
              defaultMode: 420
            }
          }]
        }
      }
    }
  };
  if (fixture.renderedChartVariants.misplacedApisixContract) {
    const podSpec = deployment.spec.template.spec;
    podSpec.containers[0].securityContext = structuredClone(
      fixture.renderedApisixContainerSecurityContext
    );
    podSpec.containers[0].securityContext.runAsUser = 637;
    podSpec.containers[0].securityContext.runAsGroup = 637;
    podSpec.containers[0].volumeMounts[0].mountPath = "/tmp/not-apisix.yaml";
    podSpec.containers[0].volumeMounts[0].subPath = "wrong.yaml";
    podSpec.containers.push({
      name: "contract-decoy",
      image: "example.invalid/contract-decoy:fixture",
      securityContext: structuredClone(fixture.renderedApisixContainerSecurityContext),
      volumeMounts: [{
        name: "contract-decoy-config",
        mountPath: "/usr/local/apisix/conf/apisix.yaml",
        subPath: "apisix.yaml"
      }]
    });
    podSpec.volumes[0].configMap = {
      name: "falcone-apisix-unexpected",
      defaultMode: 384
    };
    podSpec.volumes.push({
      name: "contract-decoy-config",
      configMap: {
        name: "falcone-apisix-standalone",
        defaultMode: 420
      }
    });
  }
  return deployment;
};

const liveApisixDeployment = () => {
  const deployment = structuredClone(fixture.deployments["falcone-apisix"]);
  if (readState().upgrades === 0) return deployment;
  deployment.metadata.generation = 8;
  deployment.status.observedGeneration = 8;
  deployment.spec.template.spec.securityContext = structuredClone(
    fixture.convergedApisixPodSecurityContext
  );
  deployment.spec.template.spec.containers[0].securityContext = structuredClone(
    fixture.convergedApisixContainerSecurityContext
  );
  return deployment;
};

const liveObservabilityDeployment = () => {
  const deployment = structuredClone(fixture.deployments["falcone-observability"]);
  if (readState().upgrades === 0) return deployment;
  deployment.metadata.generation = 6;
  deployment.spec.replicas = 1;
  deployment.spec.template.spec.securityContext = structuredClone(
    fixture.convergedObservabilityPodSecurityContext
  );
  deployment.spec.template.spec.containers[0].securityContext = structuredClone(
    fixture.convergedObservabilityContainerSecurityContext
  );
  deployment.status = {
    observedGeneration: 6,
    replicas: 1,
    updatedReplicas: 1,
    readyReplicas: 1,
    availableReplicas: 1,
    unavailableReplicas: 0
  };
  return deployment;
};

const renderedChart = () => {
  const imageContract = [
    "image: \"ghcr.io/gntik-ai/in-falcone-control-plane@sha256:26bb5ff1caa0ffbd9f902b5da645fa69caa9153ff6d19b28eda640f35f9c4254\"",
    "image: \"ghcr.io/gntik-ai/in-falcone-control-plane-executor@sha256:94809c39149cb6d2aa12a606f5b7db19d8365e1a857b83bcd45405554116feae\"",
    "image: \"ghcr.io/gntik-ai/in-falcone-web-console@sha256:4ccb885b4e15637e68f409fcedf93f180397fad3d6ccf331961d41e43af8c868\"",
    "image: \"ghcr.io/gntik-ai/in-falcone-workflow-worker@sha256:0520d57d36ee1383c2077388eb4880023f3b5c11536107151a1e01657001e8aa\"",
    "value: 'ghcr.io/gntik-ai/in-falcone-fn-runtime@sha256:b50e93fb529a2129daa4e682ea4ae3741967a649c5fc1cc5f2f2b6588eb1a0fd'",
    "MCP_RUNTIME_IMAGE: \"ghcr.io/gntik-ai/in-falcone-mcp-runtime:0.3.0\"",
    "MCP_RUNTIME_IMAGE_DIGEST: \"sha256:f0bb4c639f08c40c650e3f2b45a0d3c546fa84b0ae5d2eb9a4153860ec06a162\""
  ].map((line) => `# ${line}`).join("\n");
  const securityContext = fixture.renderedApisixPodSecurityContext;
  const containerSecurityContext = fixture.renderedApisixContainerSecurityContext;
  let apisixDocument = `---
# Source: in-falcone/charts/apisix/templates/workload.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: falcone-apisix
  labels:
    helm.sh/chart: "apisix-0.2.2"
    app.kubernetes.io/name: apisix
    app.kubernetes.io/instance: ${fixture.release.name}
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: in-falcone
spec:
  replicas: 3
  revisionHistoryLimit: 10
  progressDeadlineSeconds: 600
  selector:
    matchLabels:
      app.kubernetes.io/name: apisix
      app.kubernetes.io/instance: ${fixture.release.name}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: apisix
        app.kubernetes.io/instance: ${fixture.release.name}
    spec:
      serviceAccountName: falcone-apisix
      automountServiceAccountToken: false
      enableServiceLinks: false
      securityContext:
        fsGroup: ${securityContext.fsGroup}
        fsGroupChangePolicy: ${securityContext.fsGroupChangePolicy}
        runAsGroup: ${securityContext.runAsGroup}
        runAsNonRoot: ${securityContext.runAsNonRoot}
        runAsUser: ${securityContext.runAsUser}
        seccompProfile:
          type: ${securityContext.seccompProfile.type}
      containers:
        - name: apisix
          image: "docker.io/apache/apisix:3.10.0-debian"
          imagePullPolicy: IfNotPresent
          volumeMounts:
            - mountPath: /usr/local/apisix/conf/apisix.yaml
              name: standalone-config
              subPath: apisix.yaml
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: false
            runAsGroup: ${containerSecurityContext.runAsGroup}
            runAsNonRoot: ${containerSecurityContext.runAsNonRoot}
            runAsUser: ${containerSecurityContext.runAsUser}
      volumes:
        - configMap:
            defaultMode: 420
            name: falcone-apisix-standalone
          name: standalone-config`;
  if (fixture.renderedChartVariants.misplacedApisixContract) {
    apisixDocument = `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: falcone-apisix
  namespace: ${fixture.release.namespace}
  labels:
    app.kubernetes.io/instance: ${fixture.release.name}
    app.kubernetes.io/name: apisix
spec:
  replicas: 3
  selector:
    matchLabels:
      app.kubernetes.io/instance: ${fixture.release.name}
      app.kubernetes.io/name: apisix
  template:
    metadata:
      labels:
        app.kubernetes.io/instance: ${fixture.release.name}
        app.kubernetes.io/name: apisix
    spec:
      securityContext:
        fsGroup: ${securityContext.fsGroup}
        fsGroupChangePolicy: ${securityContext.fsGroupChangePolicy}
        runAsNonRoot: ${securityContext.runAsNonRoot}
        runAsUser: ${securityContext.runAsUser}
        runAsGroup: ${securityContext.runAsGroup}
        seccompProfile:
          type: ${securityContext.seccompProfile.type}
      containers:
        - name: apisix
          image: docker.io/apache/apisix:3.10.0-debian
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: false
            runAsNonRoot: true
            runAsUser: 637
            runAsGroup: 637
          volumeMounts:
            - name: standalone-config
              mountPath: /tmp/not-apisix.yaml
              subPath: wrong.yaml
        - name: contract-decoy
          image: example.invalid/contract-decoy:fixture
          securityContext:
            allowPrivilegeEscalation: ${containerSecurityContext.allowPrivilegeEscalation}
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: ${containerSecurityContext.readOnlyRootFilesystem}
            runAsNonRoot: ${containerSecurityContext.runAsNonRoot}
            runAsUser: ${containerSecurityContext.runAsUser}
            runAsGroup: ${containerSecurityContext.runAsGroup}
          volumeMounts:
            - name: contract-decoy-config
              mountPath: /usr/local/apisix/conf/apisix.yaml
              subPath: apisix.yaml
      volumes:
        - name: standalone-config
          configMap:
            name: falcone-apisix-unexpected
            defaultMode: 384
        - name: contract-decoy-config
          configMap:
            name: falcone-apisix-standalone
            defaultMode: 420`;
  }
  if (fixture.renderedChartVariants.duplicateApisixDeployment) {
    apisixDocument += `
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: falcone-apisix
  namespace: ${fixture.release.namespace}
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 637
        runAsGroup: 637
      containers:
        - name: apisix
          image: docker.io/apache/apisix:3.10.0-debian
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            readOnlyRootFilesystem: false
            runAsNonRoot: true
            runAsUser: 637
            runAsGroup: 637
          volumeMounts:
            - name: standalone-config
              mountPath: /tmp/not-apisix.yaml
              subPath: wrong.yaml
      volumes:
        - name: standalone-config
          configMap:
            name: falcone-apisix-unexpected
            defaultMode: 384`;
  }
  const externalSecretDocuments = fixture.externalSecretNames.map((name) => `---
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: ${name}
  namespace: ${fixture.release.namespace}
spec:
  refreshInterval: 1h
  secretStoreRef:
    kind: ClusterSecretStore
    name: openbao-backend
  target:
    name: ${name}
    creationPolicy: Owner
    deletionPolicy: Retain
  data: []`);
  return `${imageContract}\n${apisixDocument}\n${externalSecretDocuments.join("\n")}\n`;
};

if (tool === "helm") {
  const command = args[0];
  if (command === "list") {
    const state = readState();
    if (state.upgrades > 0) {
      json([{
        name: fixture.release.name,
        namespace: fixture.release.namespace,
        revision: String(Number(fixture.release.revision) + state.upgrades),
        chart: fixture.targetChart,
        status: "deployed"
      }]);
    } else {
      json([fixture.release]);
    }
    process.exit(0);
  }
  if (command === "history") {
    json(fixture.history);
    process.exit(0);
  }
  if (command === "get" && args[1] === "values") {
    json(fixture.legacyValues);
    process.exit(0);
  }
  if (command === "pull") {
    assertTargetVersion();
    const destination = option("--untardir");
    if (!destination) fail("FAKE_PULL_UNTARDIR_REQUIRED");
    const chartDirectory = path.join(destination, "in-falcone");
    fs.mkdirSync(path.join(chartDirectory, "values"), {recursive: true});
    fs.writeFileSync(path.join(chartDirectory, "Chart.yaml"), `apiVersion: v2\nname: in-falcone\nversion: ${fixture.targetVersion}\n`);
    fs.writeFileSync(path.join(chartDirectory, "values", "staging.yaml"), "global: {}\n");
    process.stdout.write(`Pulled: public fixture in-falcone:${fixture.targetVersion}\nDigest: ${fixture.packageDigest}\n`);
    process.exit(0);
  }
  if (command === "template") {
    assertTargetVersion();
    process.stdout.write(renderedChart());
    process.exit(0);
  }
  if (command === "plugin" && args[1] === "list") {
    process.stdout.write("NAME VERSION DESCRIPTION\ndiff 3.9.10 public-fixture\n");
    process.exit(0);
  }
  if (command === "diff" && args[1] === "upgrade") {
    assertTargetVersion();
    process.exit(0);
  }
  if (command === "upgrade") {
    assertTargetVersion();
    append(mutationPath, `helm upgrade release=${fixture.release.name} version=${fixture.targetVersion}`);
    const state = readState();
    state.upgrades += 1;
    writeState(state);
    process.stdout.write(`Release ${fixture.release.name} upgraded to ${fixture.targetChart}\n`);
    process.exit(0);
  }
  fail(`unsupported fake helm invocation: ${args.join(" ")}`, 96);
}

if (tool !== "kubectl") {
  fail(`unsupported fake tool: ${tool}`, 96);
}

let kubectlArgs = [...args];
let namespace;
if (kubectlArgs[0] === "-n" || kubectlArgs[0] === "--namespace") {
  namespace = kubectlArgs[1];
  kubectlArgs = kubectlArgs.slice(2);
}

const kubectlCommand = kubectlArgs[0];
if (kubectlCommand === "config" && kubectlArgs[1] === "current-context") {
  process.stdout.write("default\n");
  process.exit(0);
}

if (kubectlCommand === "create") {
  const source = fs.readFileSync(0, "utf8");
  const kind = source.match(/\n\s*kind:\s*([^\s]+)\s*\n/)?.[1];
  const name = source.match(/\n\s*name:\s*([^\s]+)\s*\n/)?.[1];
  if (kind === "Deployment" && name === "falcone-apisix") {
    json(renderedApisixDeployment());
    process.exit(0);
  }
  if (!name || !fixture.externalSecretNames.includes(name)) fail("FAKE_EXTERNAL_SECRET_RENDER_INVALID");
  json({
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ExternalSecret",
    metadata: {name, namespace: fixture.release.namespace},
    spec: externalSecretSpec(name)
  });
  process.exit(0);
}

if (kubectlCommand === "wait") {
  process.exit(0);
}

if (kubectlCommand === "logs" && kubectlArgs[1] === "job/openbao-auth-reconcile") {
  process.stdout.write("result=unchanged code=AUTH_METADATA_MATCHED canary=passed\n");
  process.exit(0);
}

if (["patch", "scale", "delete", "apply", "replace"].includes(kubectlCommand)) {
  append(mutationPath, `kubectl ${kubectlArgs.join(" ")}`);
  process.exit(0);
}

if (kubectlCommand !== "get") {
  fail(`unsupported fake kubectl invocation: ${kubectlArgs.join(" ")}`, 96);
}

const resource = kubectlArgs[1];
const name = kubectlArgs[2] && !kubectlArgs[2].startsWith("-") ? kubectlArgs[2] : undefined;
const selector = (() => {
  const index = kubectlArgs.indexOf("-l");
  return index === -1 ? "" : kubectlArgs[index + 1];
})();
const allNamespaces = kubectlArgs.includes("-A") || kubectlArgs.includes("--all-namespaces");

if (resource === "namespace" && name === fixture.release.namespace) {
  json({apiVersion: "v1", kind: "Namespace", metadata: {name}});
  process.exit(0);
}

if ((resource === "deployment" || resource === "deployment.apps") && name) {
  const key = namespace === "external-secrets"
    ? `external-secrets/${name}`
    : name;
  const deployment = fixture.deployments[key];
  if (key === "falcone-apisix") {
    json(liveApisixDeployment());
    process.exit(0);
  }
  if (key === "falcone-observability") {
    json(liveObservabilityDeployment());
    process.exit(0);
  }
  if (!deployment) fail(`fake deployment not found: ${key}`);
  json(deployment);
  process.exit(0);
}

if (resource === "deployments" || resource === "deployments.apps") {
  json({
    apiVersion: "v1",
    kind: "List",
    items: [liveApisixDeployment(), liveObservabilityDeployment()]
  });
  process.exit(0);
}

if (["replicaset", "replicasets", "replicaset.apps", "replicasets.apps", "rs"].includes(resource)) {
  let items = fixture.replicaSets;
  if (selector.includes("app.kubernetes.io/name=apisix")) {
    items = items.filter((item) => item.metadata.labels?.["app.kubernetes.io/name"] === "apisix");
  }
  if (selector.includes("app.kubernetes.io/name=observability")) {
    items = items.filter((item) => item.metadata.labels?.["app.kubernetes.io/name"] === "observability");
  }
  if (name) {
    const replicaSet = items.find((item) => item.metadata.name === name);
    if (!replicaSet) fail(`fake replicaset not found: ${name}`);
    json(replicaSet);
    process.exit(0);
  }
  json({apiVersion: "v1", kind: "List", items});
  process.exit(0);
}

if (resource === "pods") {
  let items = [...fixture.pods, ...(fixture.extraGlobalPods ?? [])];
  if (!allNamespaces) {
    items = items.filter((item) => item.metadata.namespace === (namespace ?? fixture.release.namespace));
  }
  if (selector.includes("app.kubernetes.io/instance=falcone")) {
    items = items.filter((item) => item.metadata.labels?.["app.kubernetes.io/instance"] === "falcone");
  }
  if (selector.includes("app.kubernetes.io/name=apisix")) {
    items = items.filter((item) => item.metadata.labels?.["app.kubernetes.io/name"] === "apisix");
  }
  if (selector.includes("app.kubernetes.io/name=observability")) {
    items = items.filter((item) => item.metadata.labels?.["app.kubernetes.io/name"] === "observability");
  }
  json({apiVersion: "v1", kind: "List", items});
  process.exit(0);
}

if ((resource === "pvc" || resource === "persistentvolumeclaim") && name) {
  const pvc = fixture.storage.pvcs[name];
  if (!pvc) fail(`fake pvc not found: ${name}`);
  json(pvc);
  process.exit(0);
}

if ((resource === "statefulset" || resource === "statefulset.apps") && name) {
  const statefulSet = fixture.storage.statefulSets[name];
  if (!statefulSet) fail(`fake statefulset not found: ${name}`);
  json(statefulSet);
  process.exit(0);
}

if (resource === "configmap" && name) {
  const configMap = fixture.configMaps[name];
  if (!configMap) fail(`fake configmap not found: ${name}`);
  json(configMap);
  process.exit(0);
}

if (resource === "externalsecrets.external-secrets.io") {
  json({apiVersion: "v1", kind: "List", items: externalSecrets()});
  process.exit(0);
}

if (resource === "endpointslices.discovery.k8s.io") {
  json({
    apiVersion: "v1",
    kind: "List",
    items: [{
      endpoints: [
        {conditions: {ready: true}},
        {conditions: {ready: true}}
      ]
    }]
  });
  process.exit(0);
}

if (resource === "pv") {
  json({apiVersion: "v1", kind: "List", items: []});
  process.exit(0);
}

if (name) {
  json({
    apiVersion: resource.includes(".") ? "fixture.gntik.ai/v1" : "v1",
    kind: "FixtureObject",
    metadata: {
      name,
      namespace: namespace ?? null,
      uid: `${resource}-${namespace ?? "cluster"}-${name}`,
      labels: {},
      annotations: {},
      ownerReferences: []
    }
  });
  process.exit(0);
}

fail(`unsupported fake kubectl get: ${kubectlArgs.join(" ")}`, 96);
}
