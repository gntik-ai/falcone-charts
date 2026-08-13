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
const publicHelm = spawnSync("sh", ["-c", "command -v helm"], {encoding: "utf8"}).stdout.trim();
const recoveryScript = path.join(
  repositoryRoot,
  "charts/in-falcone/migrations/revision-20-forward-recovery.sh"
);
const exactFixturePath = path.join(helperDirectory, "revision23-partial-manual-recovery.json");
const exactConfirmation =
  "default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.19/" +
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const baseFixture = JSON.parse(fs.readFileSync(exactFixturePath, "utf8"));

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

const evidenceDocument = (kind, now, validUntil, fixture) => ({
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
    chart: fixture.targetChart,
    packageDigest: fixture.packageDigest
  },
  evidence: {
    observedAt: now,
    validUntil,
    verified: true,
    reference: kind === "Revision20BackupEvidence"
      ? "bbx:revision23-partial-manual-recovery:backup"
      : "bbx:revision23-partial-manual-recovery:parity",
    ...(kind === "Revision20ParityEvidence"
      ? {backupReference: "bbx:revision23-partial-manual-recovery:backup"}
      : {})
  }
});

function runRecovery({
  mutate = () => {},
  confirmation = exactConfirmation,
  apply = true,
  attemptCount = 1,
  recoveryEntrypoint = recoveryScript,
  invokeWithBash = false,
  entrypointArguments = [],
  packagedArchive = null,
  realHelm = null,
  renderMutation = "none",
  mutateRetainedJobBetweenAttempts = null
} = {}) {
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
  let effectivePackagedArchive = packagedArchive;
  let effectiveRealHelm = realHelm;
  if (fixture.authRecovery?.enabled && !effectivePackagedArchive && !effectiveRealHelm) {
    assert.ok(publicHelm, "the public Helm executable is required for exact r24 package rendering");
    const packaged = spawnSync(
      publicHelm,
      ["package", path.join(repositoryRoot, "charts/in-falcone"), "--destination", scenarioDirectory],
      {cwd: repositoryRoot, encoding: "utf8"}
    );
    assert.equal(
      packaged.status,
      0,
      `exact r24 fixture package failed:\n${packaged.stdout}\n${packaged.stderr}`
    );
    const archives = fs.readdirSync(scenarioDirectory).filter((name) =>
      /^in-falcone-.+\.tgz$/.test(name)
    );
    assert.equal(archives.length, 1, "exact r24 fixture requires one public packaged chart");
    effectivePackagedArchive = path.join(scenarioDirectory, archives[0]);
    effectiveRealHelm = publicHelm;
  }
  fs.writeFileSync(scenarioFixturePath, `${JSON.stringify(fixture)}\n`);
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({
      upgrades: 0,
      storeHandedOff: fixture.legacyStoreHandoff.initiallyHandedOff,
      authRecoveryApplied: false,
      authRecoveryCompleted: false,
      authRecoveryLogReads: 0,
      authRecoveryCreatedRefs: [],
      authRecoveryCreatedJobs: [],
      authRecoveryCompletedRefs: [],
      authRecoveryCurrentRef: null,
      authRecoveryWaitFailures: fixture.authRecovery?.waitFailures ?? 0,
      storeWaitFailures: fixture.reachability?.storeWaitFailures ?? 0
    })}\n`
  );
  fs.writeFileSync(tracePath, "");
  fs.writeFileSync(mutationPath, "");

  const now = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const validUntil = new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.writeFileSync(
    backupPath,
    `${JSON.stringify(evidenceDocument("Revision20BackupEvidence", now, validUntil, fixture))}\n`
  );
  fs.writeFileSync(
    parityPath,
    `${JSON.stringify(evidenceDocument("Revision20ParityEvidence", now, validUntil, fixture))}\n`
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
    const recoveryArguments = [
      ...entrypointArguments,
      ...(apply
        ? [
          "--apply",
          "--confirm-target",
          confirmation,
          "--backup-attestation",
          backupPath,
          "--parity-attestation",
          parityPath
        ]
        : [])
    ];
    const attempts = [];
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      const traceBefore = fs.readFileSync(tracePath, "utf8");
      const mutationsBefore = fs.readFileSync(mutationPath, "utf8");
      const result = spawnSync(
        invokeWithBash ? "bash" : recoveryEntrypoint,
        invokeWithBash ? [recoveryEntrypoint, ...recoveryArguments] : recoveryArguments,
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDirectory}:${process.env.PATH}`,
            FALCONE_BBX_FIXTURE: scenarioFixturePath,
            FALCONE_BBX_STATE: statePath,
            FALCONE_BBX_TRACE: tracePath,
            FALCONE_BBX_MUTATIONS: mutationPath,
            ...(effectivePackagedArchive
              ? {FALCONE_BBX_PACKAGED_ARCHIVE: effectivePackagedArchive}
              : {}),
            ...(effectiveRealHelm ? {FALCONE_BBX_REAL_HELM: effectiveRealHelm} : {}),
            FALCONE_BBX_RENDER_MUTATION: renderMutation
          },
          timeout: 30_000
        }
      );
      const traceAfter = fs.readFileSync(tracePath, "utf8");
      const mutationsAfter = fs.readFileSync(mutationPath, "utf8");
      attempts.push({
        ...result,
        trace: traceAfter.slice(traceBefore.length),
        mutations: mutationsAfter.slice(mutationsBefore.length)
      });
      if (attempt + 1 < attemptCount && mutateRetainedJobBetweenAttempts) {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        const retained = state.authRecoveryCreatedJobs.find(
          (job) => job.ref === state.authRecoveryCurrentRef
        );
        assert.ok(retained, "a retained current Job is required between recovery attempts");
        mutateRetainedJobBetweenAttempts(retained.object, {attempt: attempt + 1});
        fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`);
      }
    }
    const result = attempts.at(-1);
    return {
      ...result,
      attempts,
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
    ["helm upgrade release=falcone version=0.4.19"],
    `${drift} must stop after exactly the first Phase-A upgrade`
  );
}

export function registerRevision23PartialManualRecoveryContract() {
  test("bbx-repair-staging-057 admits only the exact revision-23 partial manual recovery", async (t) => {
    await t.test("admits the exact partial recovery and applies immutable chart 0.4.19", () => {
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
        /phase-a=applied revision=25 chart=in-falcone-0\.4\.19 package-digest=sha256:b{64}/
      );
      assert.deepEqual(
        result.mutations.trim().split("\n"),
        [
          "helm upgrade release=falcone version=0.4.19",
          "helm upgrade release=falcone version=0.4.19"
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

export function registerRevision23PhaseAVectorPendingProgressContract() {
  test("bbx-repair-staging-058 completes Phase A without globally waiting for the pending vector", () => {
    const result = runRecovery({
      mutate: (fixture) => {
        fixture.phaseAPendingVector.enabled = true;
      }
    });

    assert.equal(
      result.status,
      0,
      [
        "Phase A must not block on the deliberately Pending postgresql-vector workload",
        `stdout:\n${result.stdout}`,
        `stderr:\n${result.stderr}`,
        `mutations:\n${result.mutations}`,
        `public trace:\n${result.trace}`
      ].join("\n")
    );

    const traceLines = result.trace.split("\n").filter(Boolean);
    const upgradeIndexes = traceLines
      .map((line, index) => line.startsWith("helm upgrade ") ? index : -1)
      .filter((index) => index !== -1);
    assert.equal(upgradeIndexes.length, 2, "Phase A and Phase B/JIT must each perform one upgrade");

    const phaseAUpgrade = traceLines[upgradeIndexes[0]];
    assert.doesNotMatch(
      phaseAUpgrade,
      /(?:^|\s)--wait(?:\s|$)/,
      "Phase A must not use Helm's global wait while postgresql-vector is deliberately Pending"
    );

    const phaseATrace = traceLines.slice(upgradeIndexes[0] + 1, upgradeIndexes[1]);
    for (const target of baseFixture.phaseAPendingVector.requiredHealthyRollouts) {
      const [kind, name] = target.split("/");
      const explicitWait = phaseATrace.some((line) =>
        line.startsWith("kubectl ") &&
        /\s(?:rollout status|wait)\s/.test(line) &&
        new RegExp(`(?:^|\\s)${kind}(?:/|\\s+)${name}(?:\\s|$)`).test(line)
      );
      assert.ok(explicitWait, `Phase A must explicitly wait for healthy ${target}`);
    }
    assert.equal(
      phaseATrace.some((line) =>
        /\s(?:rollout status|wait)\s/.test(line) &&
        line.includes(baseFixture.phaseAPendingVector.resource)
      ),
      false,
      "Phase A must leave postgresql-vector Pending for Phase B/JIT"
    );
    assert.deepEqual(
      result.mutations.trim().split("\n"),
      [
        "helm upgrade release=falcone version=0.4.19",
        "helm upgrade release=falcone version=0.4.19"
      ],
      "the recovery must preserve exactly one Phase-A and one Phase-B/JIT mutation"
    );
  });
}

const enableRevision24GlobalWaitRecovery = (fixture) => {
  const revision24 = fixture.revision24GlobalWait;
  revision24.enabled = true;
  fixture.legacyStoreHandoff.enabled = true;
  fixture.phaseAPendingVector.enabled = true;
  fixture.targetVersion = revision24.targetVersion;
  fixture.targetChart = revision24.targetChart;
  fixture.packageDigest = revision24.packageDigest;
  fixture.release = structuredClone(revision24.release);
  fixture.history = [
    ...fixture.history,
    {
      revision: 24,
      status: "failed",
      chart: "in-falcone-0.4.11",
      description: revision24.description
    }
  ];
  fixture.authRecovery ??= {};
  Object.assign(fixture.authRecovery, {
    enabled: true,
    waitFailures: fixture.authRecovery.waitFailures ?? 0,
    preflightLog: fixture.authRecovery.preflightLog ??
      "auth_source=recovery_root result=accepted\n" +
      "result=changed code=AUTH_METADATA_CONVERGED canary=passed",
    healthLog: fixture.authRecovery.healthLog ??
      "result=unchanged code=AUTH_METADATA_MATCHED canary=passed"
  });
  fixture.authRecovery.staleJobs = exactRevision24HistoricalJobs();
};

const revision24Confirmation =
  "default/in-falcone-staging/falcone@24/in-falcone-0.4.11->in-falcone-0.4.19/" +
  baseFixture.revision24GlobalWait.packageDigest;

function assertNoSecretReadsOrOwnershipEscape(result, contract) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bget (?:secret|secrets)(?:\s|$)/,
    `${contract} must not read Secret resources`
  );
  assert.doesNotMatch(result.trace, /(?:^|\s)--take-ownership(?:\s|$)/m, `${contract} forbids --take-ownership`);
  assert.doesNotMatch(
    result.mutations,
    /kubectl (?:-n|--namespace) external-secrets .*\bpatch\b|kubectl \bpatch\b (?:deployment|serviceaccount|service)\S* (?:external-secrets|external-secrets-cert-controller|external-secrets-webhook)(?:\s|$)/,
    `${contract} must not patch the administrator-owned ESO installation`
  );
}

export function registerLegacyClusterSecretStoreHandoffContract() {
  test("bbx-repair-staging-059 hands off the exact legacy ClusterSecretStore before Phase A", async (t) => {
    await t.test("dry-run detects the exact legacy hook store without mutation", () => {
      const result = runRecovery({mutate: enableRevision24GlobalWaitRecovery, apply: false});
      assert.equal(result.status, 0, `exact legacy store dry-run failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stdout,
        /legacy-clustersecretstore-handoff=required name=openbao-backend uid=f70a5ffd-56f3-4b37-8119-d54ba1108b69 resourceVersion=\S+/
      );
      assert.match(result.trace, /kubectl .*\bget clustersecretstore(?:s)?(?:\.external-secrets\.io)?\b.*\bopenbao-backend\b/);
      assert.equal(result.mutations, "", "dry-run must not mutate the legacy store or Helm release");
      assertNoSecretReadsOrOwnershipEscape(result, "legacy store dry-run");
    });

    await t.test("apply performs one guarded JSON handoff and waits for all ESO readiness before Helm", () => {
      const result = runRecovery({
        mutate: enableRevision24GlobalWaitRecovery,
        confirmation: revision24Confirmation
      });
      assert.equal(
        result.status,
        0,
        `exact legacy store handoff failed:\n${result.stdout}\n${result.stderr}\n${result.trace}`
      );
      const traceLines = result.trace.split("\n").filter(Boolean);
      const patchLines = traceLines.filter((line) => /kubectl .*\bpatch clustersecretstore/.test(line));
      assert.equal(patchLines.length, 1, "apply must issue exactly one ClusterSecretStore JSON patch");
      assert.match(patchLines[0], /(?:^|\s)--type(?:=|\s+)json(?:\s|$)/);
      assert.match(patchLines[0], /f70a5ffd-56f3-4b37-8119-d54ba1108b69/);
      assert.match(patchLines[0], /\/metadata\/resourceVersion/);
      assert.match(patchLines[0], /helm\.sh~1hook/);
      assert.match(patchLines[0], /helm\.sh~1hook-weight/);
      assert.match(patchLines[0], /eso-system/);

      const patchIndex = traceLines.indexOf(patchLines[0]);
      const storeReadyIndex = traceLines.findIndex((line) =>
        /kubectl .*\bwait\b.*clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(line)
      );
      const externalSecretsReadyIndex = traceLines.findIndex((line) =>
        /kubectl .*\bwait\b.*externalsecrets?(?:\.external-secrets\.io)?\b/.test(line)
      );
      const helmIndex = traceLines.findIndex((line) => line.startsWith("helm upgrade "));
      assert.ok(patchIndex < storeReadyIndex, "store Ready wait must follow the guarded handoff patch");
      assert.ok(storeReadyIndex < externalSecretsReadyIndex, "all 14 ExternalSecrets wait after store Ready");
      assert.ok(externalSecretsReadyIndex < helmIndex, "ESO readiness must complete before Helm Phase A");
      assert.equal(result.mutations.split("\n").filter((line) => /kubectl .*\bpatch\b/.test(line)).length, 1);
      assertNoSecretReadsOrOwnershipEscape(result, "legacy store apply");
    });

    await t.test("retry on the desired store state is idempotent", () => {
      const result = runRecovery({
        mutate: (fixture) => {
          enableRevision24GlobalWaitRecovery(fixture);
          fixture.legacyStoreHandoff.initiallyHandedOff = true;
        },
        confirmation: revision24Confirmation
      });
      assert.equal(result.status, 0, `desired-state retry failed:\n${result.stdout}\n${result.stderr}`);
      assert.equal(
        result.mutations.split("\n").filter((line) => /kubectl .*\bpatch\b/.test(line)).length,
        0,
        "desired store retry must not patch again"
      );
      assert.match(result.trace, /kubectl .*\bget clustersecretstore/);
      assert.match(result.trace, /kubectl .*\bwait\b.*clustersecretstore/);
      assertNoSecretReadsOrOwnershipEscape(result, "desired store retry");
    });

    const driftCases = [
      ["foreign Helm owner", (fixture) => {
        fixture.legacyStoreHandoff.live.metadata.annotations["meta.helm.sh/release-name"] = "foreign";
      }],
      ["hook annotation drift", (fixture) => {
        fixture.legacyStoreHandoff.live.metadata.annotations["helm.sh/hook-weight"] = "1";
      }],
      ["provider spec drift", (fixture) => {
        fixture.legacyStoreHandoff.live.spec.provider.vault.auth.kubernetes.role = "foreign-role";
      }],
      ["store cardinality drift", (fixture) => {
        fixture.legacyStoreHandoff.extraStores = [structuredClone(fixture.legacyStoreHandoff.live)];
        fixture.legacyStoreHandoff.extraStores[0].metadata.uid = "duplicate-store-uid";
      }],
      ["store UID drift", (fixture) => {
        fixture.legacyStoreHandoff.live.metadata.uid = "unexpected-store-uid";
      }],
      ["concurrent store resourceVersion drift", (fixture) => {
        fixture.legacyStoreHandoff.concurrentResourceVersionDrift = true;
      }]
    ];
    for (const [name, drift] of driftCases) {
      await t.test(`rejects ${name} before Helm`, () => {
        const result = runRecovery({
          mutate: (fixture) => {
            enableRevision24GlobalWaitRecovery(fixture);
            drift(fixture);
          },
          confirmation: revision24Confirmation
        });
        if (name === "concurrent store resourceVersion drift") {
          assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
          const mutations = result.mutations.trim().split("\n").filter(Boolean);
          assert.equal(
            mutations.length,
            1,
            `${name} may create only the required auth attempt before the guarded CAS conflict`
          );
          const created = mutations[0].match(
            /^kubectl create auth-reconcile-job ref=(\S+) generateName=(\S+) chart=(\S+) digest=(\S+) sourceRevision=(\S+) allowRecoveryRoot=(\S+)$/
          );
          assert.ok(created, `${name} did not record one semantic auth Job create: ${mutations[0]}`);
          const digest = baseFixture.revision24GlobalWait.packageDigest;
          const generateName = `openbao-auth-reconcile-r24-${digest.replace(/^sha256:/, "").slice(0, 12)}-`;
          assert.equal(created[2], generateName);
          assert.ok(
            created[1].startsWith(`job.batch/${generateName}`) &&
              /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(
                created[1].slice(`job.batch/${generateName}`.length)
              ),
            `${name} returned an invalid fresh Job ref: ${created[1]}`
          );
          assert.equal(created[3], baseFixture.revision24GlobalWait.targetChart);
          assert.equal(created[4], digest);
          assert.equal(created[5], "24");
          assert.equal(created[6], "true");
          assert.doesNotMatch(result.mutations, /kubectl .*\bpatch clustersecretstore|^helm upgrade\b/m);
        } else {
          assertRejectedBeforeMutation(result, name);
        }
        assert.match(
          result.trace,
          /kubectl .*\bget clustersecretstore(?:s)?(?:\.external-secrets\.io)?\b/,
          `${name} must be rejected from public ClusterSecretStore evidence`
        );
        assert.doesNotMatch(result.trace, /^helm upgrade /m, `${name} reached Helm Phase A`);
        assertNoSecretReadsOrOwnershipEscape(result, name);
      });
    }
  });
}

export function registerRevision24GlobalWaitRecoveryContract() {
  test("bbx-repair-staging-060 resumes only the exact revision-24 global-wait timeout", async (t) => {
    await t.test("admits the exact r24 precursor, hands off the store, and completes two 0.4.19 passes", () => {
      const result = runRecovery({
        mutate: enableRevision24GlobalWaitRecovery,
        confirmation: revision24Confirmation
      });
      assert.equal(
        result.status,
        0,
        `exact r24 global-wait recovery failed:\n${result.stdout}\n${result.stderr}\n${result.trace}`
      );
      assert.match(result.stdout, /revision24-global-wait-recovery=validated/);
      const traceLines = result.trace.split("\n").filter(Boolean);
      const patchIndex = traceLines.findIndex((line) => /kubectl .*\bpatch clustersecretstore/.test(line));
      const upgrades = traceLines.filter((line) => line.startsWith("helm upgrade "));
      assert.equal(upgrades.length, 2, "r24 recovery must complete exactly two Phase-A passes");
      assert.ok(upgrades.every((line) => /(?:^|\s)--version 0\.4\.19(?:\s|$)/.test(line)));
      assert.ok(upgrades.every((line) => !/(?:^|\s)--wait(?:\s|$)/.test(line)));
      assert.ok(patchIndex !== -1 && patchIndex < traceLines.indexOf(upgrades[0]), "store handoff precedes Helm");
      assertNoSecretReadsOrOwnershipEscape(result, "r24 recovery");
    });

    const driftCases = [
      ["history predecessor", (fixture) => {
        fixture.history[0].status = "failed";
      }, /helm history falcone/],
      ["r24 description", (fixture) => {
        fixture.history[3].description = fixture.history[3].description.replace(
          "context deadline exceeded",
          "context canceled"
        );
      }, /helm history falcone/],
      ["legacy store", (fixture) => {
        fixture.legacyStoreHandoff.live.metadata.annotations["helm.sh/hook"] = "post-upgrade";
      }, /kubectl .*\bget clustersecretstore/],
      ["ExternalSecret readiness", (fixture) => {
        fixture.legacyStoreHandoff.forcedReadyNames = [fixture.externalSecretNames[0]];
      }, /kubectl .*\bget externalsecrets/],
      ["vector PVC", (fixture) => {
        fixture.revision24GlobalWait.vectorPvc.metadata.uid = "unexpected-vector-pvc-uid";
      }, /kubectl .*\bget (?:pvc|persistentvolumeclaim)\b.*falcone-postgresql-vector-data/],
      ["ExternalSecret identity", (fixture) => {
        fixture.externalSecretNames[0] = "unexpected-identity";
      }, /kubectl .*\bget externalsecrets/]
    ];
    for (const [name, drift, evidencePattern] of driftCases) {
      await t.test(`rejects ${name} drift before mutation`, () => {
        const result = runRecovery({
          mutate: (fixture) => {
            enableRevision24GlobalWaitRecovery(fixture);
            drift(fixture);
          },
          confirmation: revision24Confirmation
        });
        assertRejectedBeforeMutation(result, `r24 ${name}`);
        assert.match(result.trace, evidencePattern, `r24 ${name} must be rejected from its public evidence`);
        assertNoSecretReadsOrOwnershipEscape(result, `r24 ${name}`);
      });
    }
  });
}

const revision24AuthRecoveryDigest = `sha256:${"0419".repeat(16)}`;
const enableRevision24AuthRecovery = (fixture, {
  createMode,
  preflightLog,
  requireForcedRecoveryRoot,
  waitFailures,
  storeWaitFails,
  storeWaitFailures,
  retainAuthBlockedStoreAfterCompletion,
  externalSecretWaitFailure,
  targetVersion,
  requireUpgradeRenderContext,
  packageDigest,
  fixtureMutator
}) => {
  fixture.targetVersion = targetVersion;
  fixture.targetChart = `in-falcone-${targetVersion}`;
  fixture.packageDigest = packageDigest;
  fixture.revision24GlobalWait.targetVersion = targetVersion;
  fixture.revision24GlobalWait.targetChart = `in-falcone-${targetVersion}`;
  fixture.revision24GlobalWait.packageDigest = packageDigest;
  enableRevision24GlobalWaitRecovery(fixture);
  Object.assign(fixture.authRecovery, {
    enabled: true,
    createMode,
    waitFailures,
    preflightLog,
    requireForcedRecoveryRoot,
    requireUpgradeRenderContext,
    retainAuthBlockedStoreAfterCompletion,
    healthLog: "result=unchanged code=AUTH_METADATA_MATCHED canary=passed"
  });
  Object.assign(fixture.reachability, {
    storeWaitFails,
    storeWaitFailures,
    externalSecretWaitFailure
  });
  fixtureMutator(fixture);
};

export function runRevision24AuthRecovery({
  createMode = "success",
  preflightLog = "auth_source=recovery_root result=accepted\n" +
    "result=changed code=AUTH_METADATA_CONVERGED canary=passed",
  requireForcedRecoveryRoot = false,
  waitFails = false,
  waitFailures = waitFails ? 1 : 0,
  attemptCount = 1,
  storeWaitFails = false,
  storeWaitFailures = 0,
  retainAuthBlockedStoreAfterCompletion = false,
  externalSecretWaitFailure = null,
  targetVersion = "0.4.19",
  packageDigest = revision24AuthRecoveryDigest,
  requireUpgradeRenderContext = false,
  recoveryEntrypoint = recoveryScript,
  invokeWithBash = false,
  entrypointArguments = [],
  packagedArchive = null,
  realHelm = null,
  renderMutation = "none",
  mutateRetainedJobBetweenAttempts = null,
  fixtureMutator = () => {}
} = {}) {
  return runRecovery({
    mutate: (fixture) => enableRevision24AuthRecovery(fixture, {
      createMode,
      preflightLog,
      requireForcedRecoveryRoot,
      waitFailures,
      storeWaitFails,
      storeWaitFailures,
      retainAuthBlockedStoreAfterCompletion,
      externalSecretWaitFailure,
      targetVersion,
      requireUpgradeRenderContext,
      packageDigest,
      fixtureMutator
    }),
    confirmation:
      `default/in-falcone-staging/falcone@24/in-falcone-0.4.11->in-falcone-${targetVersion}/` +
      packageDigest,
    attemptCount,
    recoveryEntrypoint,
    invokeWithBash,
    entrypointArguments,
    packagedArchive,
    realHelm,
    renderMutation,
    mutateRetainedJobBetweenAttempts
  });
}

export const revision24AuthRecoveryContract = Object.freeze({
  targetVersion: "0.4.19",
  packageDigest: revision24AuthRecoveryDigest,
  sourceRevision: "24",
  jobPrefix: "job.batch/openbao-auth-reconcile-r24-041904190419-",
  staleJobRef: baseFixture.authRecovery.staleJobs[0].ref,
  externalSecretNames: Object.freeze([...baseFixture.externalSecretNames]),
  vectorResource: baseFixture.phaseAPendingVector.resource
});

const revision24SelfTokenPolicyDigest = `sha256:${"0419".repeat(16)}`;
const revision24PublishedPartialJobRef =
  "job.batch/openbao-auth-reconcile-r24-859e037a14be-7v86n";
const revision24Published016FailedJobRef =
  "job.batch/openbao-auth-reconcile-r24-10828ffdf9f1-f65tk";
const retainedAuthFailureJob = ({name, uid, digest, targetChart}) => ({
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    name,
    namespace: "secret-store",
    uid,
    annotations: {
      "in-falcone.io/recovery-package-digest": digest,
      "in-falcone.io/recovery-target-chart": targetChart,
      "in-falcone.io/recovery-source-revision": "24",
      "helm.sh/hook": "post-install,post-upgrade",
      "helm.sh/hook-weight": "-3",
      "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded"
    }
  },
  status: {
    failed: 1,
    conditions: ["FailureTarget", "Failed"].map((type) => ({
      type,
      status: "True",
      reason: "BackoffLimitExceeded"
    }))
  }
});
const revision24Published014FailedJob = retainedAuthFailureJob({
  name: revision24PublishedPartialJobRef.replace(/^job(?:\.batch)?\//, ""),
  uid: "352c1698-ac65-4af2-a25a-00bd183e9a11",
  digest: "sha256:859e037a14be87dce1419737b2bda09e9a66125cd0384f51b842e5f65eafbe70",
  targetChart: "in-falcone-0.4.14"
});
const revision24Published016FailedJob = retainedAuthFailureJob({
  name: revision24Published016FailedJobRef.replace(/^job(?:\.batch)?\//, ""),
  uid: "979dac0c-507c-4b19-9f07-2c5e98a66acc",
  digest: "sha256:10828ffdf9f134501f32af35d96e61c3db33f6071bb0bc015fc2ceac0c3b025e",
  targetChart: "in-falcone-0.4.16"
});
const revision24Published017FailedJobRef =
  "job.batch/openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw";
const revision24Published017FailedJob = retainedAuthFailureJob({
  name: revision24Published017FailedJobRef.replace(/^job(?:\.batch)?\//, ""),
  uid: "c8fd1c27-f68b-4d33-b10f-3b832c741cd3",
  digest: "sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328",
  targetChart: "in-falcone-0.4.17"
});
function exactRevision24HistoricalJobs() {
  return [
    [revision24PublishedPartialJobRef, revision24Published014FailedJob],
    [revision24Published016FailedJobRef, revision24Published016FailedJob],
    [revision24Published017FailedJobRef, revision24Published017FailedJob]
  ].map(([ref, object]) => ({ref, status: "Failed", object: structuredClone(object)}));
}
const revision24PublishedPreCreate018Digest = `sha256:${"0418".repeat(16)}`;

// 0.4.18 consumed its JIT authorization but failed before Job creation.  This
// factory exists only to prove that an impossible .18 Job is rejected; it is
// deliberately absent from every accepted retained-history fixture.
export function makeRevision24Impossible018JobEvidence({
  suffix = "unexpected",
  uid = "00000000-0000-4000-8000-000000000018"
} = {}) {
  const digest12 = revision24PublishedPreCreate018Digest.replace(/^sha256:/, "").slice(0, 12);
  const name = `openbao-auth-reconcile-r24-${digest12}-${suffix}`;
  return {
    ref: `job.batch/${name}`,
    status: "Failed",
    object: retainedAuthFailureJob({
      name,
      uid,
      digest: revision24PublishedPreCreate018Digest,
      targetChart: "in-falcone-0.4.18"
    })
  };
}

export function makeRevision24FailedRetryJob({
  suffix = "prior1",
  uid = "00000000-0000-4000-8000-000000000117"
} = {}) {
  const digest12 = revision24SelfTokenPolicyDigest.replace(/^sha256:/, "").slice(0, 12);
  const name = `openbao-auth-reconcile-r24-${digest12}-${suffix}`;
  const job = {
    ref: `job.batch/${name}`,
    status: "Failed",
    object: retainedAuthFailureJob({
      name,
      uid,
      digest: revision24SelfTokenPolicyDigest,
      targetChart: "in-falcone-0.4.19"
    })
  };
  job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"] = "0.4.19";
  return job;
}
const revision24AuthBlockedMessage =
  "unable to validate store: invalid vault credentials: Error making API request.\n\n" +
  "URL: GET https://openbao.secret-store.svc.cluster.local:8200/v1/auth/token/lookup-self\n" +
  "Code: 403. Errors:\n\n" +
  "* 1 error occurred:\n\t* permission denied\n\n";

const enableRevision24SelfTokenPolicyPrecursor = (fixture, mutatePrecursor) => {
  const store = structuredClone(fixture.legacyStoreHandoff.live);
  delete store.metadata.annotations["helm.sh/hook"];
  delete store.metadata.annotations["helm.sh/hook-weight"];
  store.metadata.annotations["in-falcone.io/reconcile-request"] =
    "phase-a-0.4.12-auth-updated";
  store.metadata.resourceVersion = String(Number(store.metadata.resourceVersion) + 1);
  store.spec = structuredClone(fixture.legacyStoreHandoff.desiredSpec);
  store.status = {
    conditions: [{
      type: "Ready",
      status: "False",
      reason: "ValidationFailed",
      message: revision24AuthBlockedMessage
    }]
  };
  fixture.authBlockedStore = {enabled: true, store};
  fixture.legacyStoreHandoff.initiallyHandedOff = true;
  fixture.authRecovery.staleJobs = [
    {
      ref: revision24PublishedPartialJobRef,
      status: "Failed",
      object: structuredClone(revision24Published014FailedJob)
    },
    {
      ref: revision24Published016FailedJobRef,
      status: "Failed",
      object: structuredClone(revision24Published016FailedJob)
    },
    {
      ref: revision24Published017FailedJobRef,
      status: "Failed",
      object: structuredClone(revision24Published017FailedJob)
    }
  ];
  mutatePrecursor(fixture);
};

export function runRevision24SelfTokenPolicyRecovery({
  targetVersion = "0.4.19",
  attemptCount = 1,
  waitFailures = 0,
  mutatePrecursor = () => {}
} = {}) {
  return runRevision24AuthRecovery({
    targetVersion,
    packageDigest: revision24SelfTokenPolicyDigest,
    attemptCount,
    waitFailures,
    fixtureMutator: (fixture) =>
      enableRevision24SelfTokenPolicyPrecursor(fixture, mutatePrecursor)
  });
}

export const revision24SelfTokenPolicyContract = Object.freeze({
  targetVersion: "0.4.19",
  packageDigest: revision24SelfTokenPolicyDigest,
  sourceRevision: "24",
  sourceChart: "in-falcone-0.4.11",
  publishedPartialVersion: "0.4.14",
  publishedPartialJobRef: revision24PublishedPartialJobRef,
  publishedFailedVersion: "0.4.16",
  publishedFailedJobRef: revision24Published016FailedJobRef,
  publishedFailed017Version: "0.4.17",
  publishedFailed017JobRef: revision24Published017FailedJobRef,
  publishedPreCreate018Version: "0.4.18",
  publishedPreCreate018Digest: revision24PublishedPreCreate018Digest,
  jobPrefix: "job.batch/openbao-auth-reconcile-r24-041904190419-",
  failedRetryJob: Object.freeze(makeRevision24FailedRetryJob()),
  storeUid: "f70a5ffd-56f3-4b37-8119-d54ba1108b69",
  storeReconcileRequest: "phase-a-0.4.12-auth-updated",
  storeReason: "ValidationFailed",
  storeMessage: revision24AuthBlockedMessage,
  externalSecretNames: Object.freeze([...baseFixture.externalSecretNames])
});

const revision24ExternalSecretPrecursorDigest = `sha256:${"0419".repeat(16)}`;
const revision24Published015Digest = `sha256:${"0415".repeat(16)}`;
const revision24Published016Digest =
  "sha256:10828ffdf9f134501f32af35d96e61c3db33f6071bb0bc015fc2ceac0c3b025e";
const revision24ExternalSecretErrorMessage =
  "could not get secret data from provider";

const enableRevision24ExternalSecretPrecursor = (
  fixture,
  externalSecretState,
  mutatePrecursor
) => {
  enableRevision24SelfTokenPolicyPrecursor(fixture, () => {});
  Object.assign(fixture.authBlockedStore, {
    externalSecretMode: externalSecretState,
    externalSecretErrorMessage: revision24ExternalSecretErrorMessage,
    externalSecretOverrides: {}
  });
  mutatePrecursor(fixture);
};

export function runRevision24ExternalSecretPrecursorRecovery({
  targetVersion = "0.4.19",
  packageDigest = revision24ExternalSecretPrecursorDigest,
  externalSecretState = "ready",
  attemptCount = 1,
  waitFailures = 0,
  mutatePrecursor = () => {}
} = {}) {
  return runRevision24AuthRecovery({
    targetVersion,
    packageDigest,
    attemptCount,
    waitFailures,
    fixtureMutator: (fixture) =>
      enableRevision24ExternalSecretPrecursor(
        fixture,
        externalSecretState,
        mutatePrecursor
      )
  });
}

export const revision24ExternalSecretPrecursorContract = Object.freeze({
  targetVersion: "0.4.19",
  packageDigest: revision24ExternalSecretPrecursorDigest,
  sourceRevision: "24",
  sourceChart: "in-falcone-0.4.11",
  publishedButUnappliedVersion: "0.4.15",
  publishedButUnappliedDigest: revision24Published015Digest,
  publishedFailedVersion: "0.4.16",
  publishedFailedDigest: revision24Published016Digest,
  publishedFailedJobRef: revision24Published016FailedJobRef,
  publishedFailed017Version: "0.4.17",
  publishedFailed017Digest:
    "sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328",
  publishedFailed017JobRef: revision24Published017FailedJobRef,
  publishedPreCreate018Version: "0.4.18",
  publishedPreCreate018Digest: revision24PublishedPreCreate018Digest,
  partialJobVersion: "0.4.14",
  partialJobRef: revision24PublishedPartialJobRef,
  jobPrefix: "job.batch/openbao-auth-reconcile-r24-041904190419-",
  storeUid: "f70a5ffd-56f3-4b37-8119-d54ba1108b69",
  storeReconcileRequest: "phase-a-0.4.12-auth-updated",
  storeReason: "ValidationFailed",
  storeMessage: revision24AuthBlockedMessage,
  externalSecretReadyCondition: Object.freeze({
    type: "Ready",
    status: "True",
    reason: "SecretSynced",
    message: "secret synced"
  }),
  externalSecretBlockedCondition: Object.freeze({
    type: "Ready",
    status: "False",
    reason: "SecretSyncedError",
    message: revision24ExternalSecretErrorMessage
  }),
  externalSecretNames: Object.freeze([...baseFixture.externalSecretNames])
});

const revision24ForcedRecoveryRootDigest = `sha256:${"0419".repeat(16)}`;
const revision24ForcedRootSuccessLog =
  "auth_source=recovery_root result=accepted\n" +
  "result=changed code=AUTH_METADATA_CONVERGED canary=passed";

const enableRevision24ForcedRecoveryRootPrecursor = (fixture, mutatePrecursor) => {
  enableRevision24ExternalSecretPrecursor(fixture, "auth-blocked", () => {});
  fixture.authRecovery.staleJobs = [
    {
      ref: revision24PublishedPartialJobRef,
      status: "Failed",
      object: structuredClone(revision24Published014FailedJob)
    },
    {
      ref: revision24Published016FailedJobRef,
      status: "Failed",
      object: structuredClone(revision24Published016FailedJob)
    },
    {
      ref: revision24Published017FailedJobRef,
      status: "Failed",
      object: structuredClone(revision24Published017FailedJob)
    }
  ];
  mutatePrecursor(fixture);
};

export function runRevision24ForcedRecoveryRoot({
  targetVersion = "0.4.19",
  packageDigest = revision24ForcedRecoveryRootDigest,
  attemptCount = 1,
  waitFailures = 0,
  preflightLog = revision24ForcedRootSuccessLog,
  mutatePrecursor = () => {}
} = {}) {
  return runRevision24AuthRecovery({
    targetVersion,
    packageDigest,
    attemptCount,
    waitFailures,
    preflightLog,
    requireForcedRecoveryRoot: true,
    fixtureMutator: (fixture) =>
      enableRevision24ForcedRecoveryRootPrecursor(fixture, mutatePrecursor)
  });
}

export const revision24ForcedRecoveryRootContract = Object.freeze({
  targetVersion: "0.4.19",
  packageDigest: revision24ForcedRecoveryRootDigest,
  sourceRevision: "24",
  sourceChart: "in-falcone-0.4.11",
  publishedPartial014Version: "0.4.14",
  publishedPartial014JobRef: revision24PublishedPartialJobRef,
  publishedFailed016Version: "0.4.16",
  publishedFailed016JobRef: revision24Published016FailedJobRef,
  publishedFailed017Version: "0.4.17",
  publishedFailed017JobRef: revision24Published017FailedJobRef,
  publishedPreCreate018Version: "0.4.18",
  publishedPreCreate018Digest: revision24PublishedPreCreate018Digest,
  retainedJobs: Object.freeze([
    structuredClone(revision24Published014FailedJob),
    structuredClone(revision24Published016FailedJob),
    structuredClone(revision24Published017FailedJob)
  ]),
  jobPrefix: "job.batch/openbao-auth-reconcile-r24-041904190419-",
  successLog: revision24ForcedRootSuccessLog,
  storeMessage: revision24AuthBlockedMessage,
  externalSecretCondition: Object.freeze({
    type: "Ready",
    status: "False",
    reason: "SecretSyncedError",
    message: revision24ExternalSecretErrorMessage
  }),
  externalSecretNames: Object.freeze([...baseFixture.externalSecretNames])
});

const revision24DigestBoundPolicyDigest = `sha256:${"0419".repeat(16)}`;

export function makeRevision24Failed019RetryJob({
  suffix = "prior1",
  uid = "00000000-0000-4000-8000-000000000118"
} = {}) {
  const digest12 = revision24DigestBoundPolicyDigest.replace(/^sha256:/, "").slice(0, 12);
  const name = `openbao-auth-reconcile-r24-${digest12}-${suffix}`;
  const job = {
    ref: `job.batch/${name}`,
    status: "Failed",
    object: retainedAuthFailureJob({
      name,
      uid,
      digest: revision24DigestBoundPolicyDigest,
      targetChart: "in-falcone-0.4.19"
    })
  };
  job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"] = "0.4.19";
  return job;
}

const enableRevision24DigestBoundPolicyPrecursor = (fixture, mutatePrecursor) => {
  enableRevision24ForcedRecoveryRootPrecursor(fixture, () => {});
  mutatePrecursor(fixture);
};

export function runRevision24DigestBoundPolicyRecovery({
  targetVersion = "0.4.19",
  packageDigest = revision24DigestBoundPolicyDigest,
  attemptCount = 1,
  waitFailures = 0,
  storeWaitFails = false,
  storeWaitFailures = 0,
  retainAuthBlockedStoreAfterCompletion = false,
  preflightLog = revision24ForcedRootSuccessLog,
  createMode = "success",
  recoveryEntrypoint = recoveryScript,
  invokeWithBash = false,
  entrypointArguments = [],
  packagedArchive = null,
  realHelm = null,
  renderMutation = "none",
  mutateRetainedJobBetweenAttempts = null,
  mutatePrecursor = () => {}
} = {}) {
  return runRevision24AuthRecovery({
    targetVersion,
    packageDigest,
    attemptCount,
    waitFailures,
    storeWaitFails,
    storeWaitFailures,
    retainAuthBlockedStoreAfterCompletion,
    preflightLog,
    createMode,
    requireForcedRecoveryRoot: true,
    recoveryEntrypoint,
    invokeWithBash,
    entrypointArguments,
    packagedArchive,
    realHelm,
    renderMutation,
    mutateRetainedJobBetweenAttempts,
    fixtureMutator: (fixture) =>
      enableRevision24DigestBoundPolicyPrecursor(fixture, mutatePrecursor)
  });
}

export const revision24DigestBoundPolicyContract = Object.freeze({
  targetVersion: "0.4.19",
  packageDigest: revision24DigestBoundPolicyDigest,
  sourceRevision: "24",
  sourceChart: "in-falcone-0.4.11",
  publishedPartial014JobRef: revision24PublishedPartialJobRef,
  publishedFailed016JobRef: revision24Published016FailedJobRef,
  publishedFailed017JobRef: revision24Published017FailedJobRef,
  publishedFailed017Digest:
    "sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328",
  publishedPreCreate018Version: "0.4.18",
  publishedPreCreate018Digest: revision24PublishedPreCreate018Digest,
  jobPrefix: "job.batch/openbao-auth-reconcile-r24-041904190419-",
  retainedJobs: Object.freeze([
    structuredClone(revision24Published014FailedJob),
    structuredClone(revision24Published016FailedJob),
    structuredClone(revision24Published017FailedJob)
  ]),
  successLog: revision24ForcedRootSuccessLog,
  storeMessage: revision24AuthBlockedMessage,
  externalSecretCondition: Object.freeze({
    type: "Ready",
    status: "False",
    reason: "SecretSyncedError",
    message: revision24ExternalSecretErrorMessage
  }),
  externalSecretNames: Object.freeze([...baseFixture.externalSecretNames])
});

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

const realPackagedArchive = process.env.FALCONE_BBX_PACKAGED_ARCHIVE;
const realHelm = process.env.FALCONE_BBX_REAL_HELM;
const renderMutation = process.env.FALCONE_BBX_RENDER_MUTATION ?? "none";
const replaceExactlyOnce = (source, pattern, replacement, label) => {
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) {
    fail(`FAKE_REAL_RENDER_MUTATION_CARDINALITY label=${label} count=${matches.length}`);
  }
  return source.replace(pattern, replacement);
};
const mutateRealAuthRender = (source) => {
  switch (renderMutation) {
    case "none":
      return source;
    case "canary-assignment":
      return replaceExactlyOnce(
        source,
        /canary_json="\$\(bao write -format=json auth\/kubernetes\/login/g,
        'other_json="$(bao write -format=json auth/kubernetes/login',
        renderMutation
      );
    case "canary-role":
      return replaceExactlyOnce(
        source,
        /role="\$role" jwt="\$\(cat \/canary\/token\)"/g,
        'role="unexpected-role" jwt="$(cat /canary/token)"',
        renderMutation
      );
    case "canary-token":
      return replaceExactlyOnce(
        source,
        /jwt="\$\(cat \/canary\/token\)"/g,
        'jwt="$(cat /canary/unexpected-token)"',
        renderMutation
      );
    case "canary-duplicate": {
      const block = /(\n\s*canary_json="\$\(bao write -format=json auth\/kubernetes\/login \\\n\s*role="\$role" jwt="\$\(cat \/canary\/token\)" 2>\/dev\/null \|\| true\)"\n)/g;
      return replaceExactlyOnce(source, block, "$1$1", renderMutation);
    }
    case "canary-order": {
      const block = /\n(\s*)canary_json="\$\(bao write -format=json auth\/kubernetes\/login \\\n\s*role="\$role" jwt="\$\(cat \/canary\/token\)" 2>\/dev\/null \|\| true\)"\n/g;
      const match = source.match(block);
      if (!match || match.length !== 1) {
        fail(`FAKE_REAL_RENDER_MUTATION_CARDINALITY label=${renderMutation} count=${match?.length ?? 0}`);
      }
      const withoutCanary = source.replace(block, "\n");
      return replaceExactlyOnce(
        withoutCanary,
        /\n(\s*)bao write auth\/kubernetes\/role\/openbao-init-role/g,
        `${match[0]}$1bao write auth/kubernetes/role/openbao-init-role`,
        renderMutation
      );
    }
    case "snapshot":
      return replaceExactlyOnce(
        source,
        /cat > \/openbao-platform\/platform\.hcl <<'FALCONE_PLATFORM_POLICY_SNAPSHOT'/g,
        "cat > /openbao-platform/platform-drift.hcl <<'FALCONE_PLATFORM_POLICY_SNAPSHOT'",
        renderMutation
      );
    case "hash":
      return replaceExactlyOnce(
        source,
        /platform_policy_sha256="[0-9a-f]{64}"/g,
        `platform_policy_sha256="${"0".repeat(64)}"`,
        renderMutation
      );
    case "mount":
      return replaceExactlyOnce(
        source,
        /mountPath: \/openbao-platform\n/g,
        "mountPath: /openbao-platform-drift\n",
        renderMutation
      );
    case "restart":
      return replaceExactlyOnce(source, /restartPolicy: Never\n/g, "restartPolicy: OnFailure\n", renderMutation);
    case "backoff":
      return replaceExactlyOnce(source, /backoffLimit: 0\n/g, "backoffLimit: 1\n", renderMutation);
    default:
      fail(`FAKE_REAL_RENDER_MUTATION_UNKNOWN name=${renderMutation}`);
  }
};

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

const storeIsHandedOff = () =>
  readState().storeHandedOff || fixture.legacyStoreHandoff.initiallyHandedOff;

const liveClusterSecretStore = () => {
  if (fixture.authBlockedStore?.enabled) {
    const store = structuredClone(fixture.authBlockedStore.store);
    if (
      readState().authRecoveryCompletedRefs.length > 0 &&
      !fixture.authRecovery?.retainAuthBlockedStoreAfterCompletion
    ) {
      store.status = {
        conditions: [{
          type: "Ready",
          status: "True",
          reason: "Valid",
          message: "store validated after self-token policy reconciliation"
        }]
      };
    }
    return store;
  }
  const store = structuredClone(fixture.legacyStoreHandoff.live);
  if (fixture.legacyStoreHandoff.enabled && !storeIsHandedOff()) return store;
  delete store.metadata.annotations["helm.sh/hook"];
  delete store.metadata.annotations["helm.sh/hook-weight"];
  store.metadata.resourceVersion = String(
    Number(fixture.legacyStoreHandoff.live.metadata.resourceVersion) + 1
  );
  store.spec = structuredClone(fixture.legacyStoreHandoff.desiredSpec);
  store.status = {
    conditions: [{type: "Ready", status: "True", reason: "Valid", message: "store validated"}]
  };
  return store;
};

const externalSecrets = () => fixture.externalSecretNames.map((name, index) => {
  const authRecoveryCompleted =
    readState().authRecoveryCompletedRefs.length > 0 &&
    !fixture.authRecovery?.retainAuthBlockedStoreAfterCompletion;
  const authBlockedMode = fixture.authBlockedStore?.externalSecretMode;
  const authBlockedReady = authRecoveryCompleted || (
    authBlockedMode === "auth-blocked"
      ? false
      : fixture.authBlockedStore?.externalSecretFailureName !== name
  );
  const ready = authBlockedReady && (
    !fixture.legacyStoreHandoff.enabled ||
    storeIsHandedOff() ||
    (fixture.legacyStoreHandoff.forcedReadyNames ?? []).includes(name)
  );
  const item = {
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
      conditions: [{
        type: "Ready",
        status: ready ? "True" : "False",
        ...(ready
          ? {reason: "SecretSynced", message: "secret synced"}
          : {
            reason: "SecretSyncedError",
            message: fixture.authBlockedStore?.externalSecretErrorMessage ??
              fixture.legacyStoreHandoff.externalSecretError
          })
      }]
    }
  };
  const override = fixture.authBlockedStore?.externalSecretOverrides?.[name];
  if (override?.namespace !== undefined) item.metadata.namespace = override.namespace;
  if (override && Object.hasOwn(override, "conditions")) {
    item.status.conditions = structuredClone(override.conditions);
  }
  return item;
});

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
  if (readState().upgrades === 0 && !fixture.revision24GlobalWait.enabled) return deployment;
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
  if (readState().upgrades === 0 && !fixture.revision24GlobalWait.enabled) return deployment;
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

const livePods = () => {
  if (!fixture.revision24GlobalWait.enabled) {
    return [...fixture.pods, ...(fixture.extraGlobalPods ?? [])];
  }
  const apisixPods = fixture.pods
    .filter((pod) => pod.metadata.labels?.["app.kubernetes.io/name"] === "apisix")
    .map((pod) => {
      const converged = structuredClone(pod);
      converged.spec.securityContext = structuredClone(fixture.convergedApisixPodSecurityContext);
      converged.spec.containers[0].securityContext = structuredClone(
        fixture.convergedApisixContainerSecurityContext
      );
      return converged;
    });
  const source = fixture.pods.find((pod) => pod.metadata.name === "falcone-observability-current-a");
  const observability = structuredClone(source);
  observability.spec.securityContext = structuredClone(fixture.convergedObservabilityPodSecurityContext);
  observability.spec.containers[0].securityContext = structuredClone(
    fixture.convergedObservabilityContainerSecurityContext
  );
  observability.status = {
    phase: "Running",
    conditions: [{type: "Ready", status: "True"}],
    containerStatuses: [{
      name: "observability",
      image: observability.spec.containers[0].image,
      ready: true,
      restartCount: 0,
      state: {running: {startedAt: "2026-08-10T01:00:00Z"}},
      user: {linux: {uid: 65534, gid: 65534}}
    }]
  };
  return [
    ...apisixPods,
    observability,
    structuredClone(fixture.revision24GlobalWait.vectorPod)
  ];
};

const renderedAuthRecoveryJob = (allowRecoveryRoot, forceRecoveryRoot = false) => `---
apiVersion: batch/v1
kind: Job
metadata:
  name: openbao-auth-reconcile
  namespace: secret-store
  annotations:
    falcone.gntik.ai/attested-chart-version: "${fixture.targetVersion}"
    helm.sh/hook: post-install,post-upgrade
    helm.sh/hook-weight: "-3"
    helm.sh/hook-delete-policy: before-hook-creation,hook-succeeded
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
  template:
    spec:
      serviceAccountName: openbao-auth-reconciler
      restartPolicy: Never
      initContainers:
        - name: request-no-kv-canary-token
          image: alpine/k8s:1.32.2
          command: ["/bin/sh", "-ec"]
          args:
            - |
              kubectl -n "eso-system" create token \
                "eso-openbao-auth" \
                --duration="600s" \
                > /canary/token
              test -s /canary/token
          volumeMounts:
            - name: canary
              mountPath: /canary
      containers:
        - name: auth-metadata-reconciler
          image: openbao/openbao:2.3.1
          command: ["/bin/sh", "-ec"]
          args:
            - |
              role="eso-role"
              desired_policies="functions,gateway,iam,platform"
              desired_token_no_default_policy="true"
              force_recovery_root="${forceRecoveryRoot}"
${forceRecoveryRoot ? `              fail() {
                echo "result=error code=$1" >&2
                exit 1
              }
              platform_policy_sha256="19e9b84ea64ace31f9d077cf448af04411aa9ae1256f9e001bb175cd053efd2b"
              auth_reconcile_policy_sha256="7968565b1e24ef962b1f90a73df59fe3dd234f18bc28e1d2b94cfedfd81b5cf8"
              cat > /openbao-platform/platform.hcl <<'FALCONE_PLATFORM_POLICY_SNAPSHOT'
              path "secret/data/platform/*" {
                capabilities = ["read"]
              }
              path "secret/metadata/platform/*" {
                capabilities = ["list", "read"]
              }
              path "auth/token/lookup-self" {
                capabilities = ["read"]
              }
              path "auth/token/revoke-self" {
                capabilities = ["update"]
              }
              FALCONE_PLATFORM_POLICY_SNAPSHOT
              cat > /openbao-auth-reconcile/auth-reconcile.hcl <<'FALCONE_AUTH_RECONCILE_POLICY_SNAPSHOT'
              path "auth/kubernetes/config" { capabilities = ["read", "update"] }
              path "auth/kubernetes/role/eso-role" { capabilities = ["read", "update"] }
              path "auth/token/lookup-self" { capabilities = ["read"] }
              path "auth/token/revoke-self" { capabilities = ["update"] }
              path "sys/policies/acl" { capabilities = ["list"] }
              FALCONE_AUTH_RECONCILE_POLICY_SNAPSHOT
              [ "$(sha256sum /openbao-platform/platform.hcl | awk '{print $1}')" = "$platform_policy_sha256" ] \\
                || fail PLATFORM_POLICY_SNAPSHOT_DRIFT
              [ "$(sha256sum /openbao-auth-reconcile/auth-reconcile.hcl | awk '{print $1}')" = "$auth_reconcile_policy_sha256" ] \\
                || fail RECONCILER_POLICY_SNAPSHOT_DRIFT
              if [ "$force_recovery_root" = "true" ]; then
                [ -s /openbao-recovery/root-token ] || fail AUTHENTICATION_UNAVAILABLE
                BAO_TOKEN="$(cat /openbao-recovery/root-token)"
                auth_source=recovery_root
                echo "auth_source=recovery_root result=accepted"
              else
                login_json="$(bao write -format=json auth/kubernetes/login \\
                  role=openbao-auth-reconcile-role \\
                  jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" 2>/dev/null || true)"
                BAO_TOKEN="$(printf '%s' "$login_json" | sed -n 's/.*"client_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
              fi
              export BAO_TOKEN
              bao policy write platform /openbao-platform/platform.hcl
              bao policy write auth-reconcile /openbao-auth-reconcile/auth-reconcile.hcl
              bao write auth/kubernetes/role/openbao-init-role token_policies=init
              bao write auth/kubernetes/role/openbao-auth-reconcile-role token_policies=auth-reconcile
              bao write "auth/kubernetes/role/$role" token_policies=platform,functions,gateway,iam token_no_default_policy=true
              canary_json="$(bao write -format=json auth/kubernetes/login \\
                role="$role" jwt="$(cat /canary/token)" 2>/dev/null || true)"
              canary_token="$(printf '%s' "$canary_json" | sed -n 's/.*"client_token"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
              BAO_TOKEN="$canary_token"; export BAO_TOKEN
              lookup_json="$(bao read -format=json auth/token/lookup-self 2>/dev/null || true)"
              bao write -force auth/token/revoke-self >/dev/null || fail AUTH_CANARY_REVOKE_FAILED
` : ""}
              if [ "$changed" = "true" ]; then
                echo "result=changed code=AUTH_METADATA_CONVERGED canary=passed"
              else
                echo "result=unchanged code=AUTH_METADATA_MATCHED canary=passed"
              fi
          volumeMounts:
            - name: tls
              mountPath: /openbao/tls
              readOnly: true
            - name: canary
              mountPath: /canary
              readOnly: true
${allowRecoveryRoot ? `            - name: auth-reconcile-policy
              mountPath: /openbao-auth-reconcile
            - name: platform-policy
              mountPath: /openbao-platform
            - name: recovery
              mountPath: /openbao-recovery
              readOnly: true
` : ""}      volumes:
        - name: tls
          secret:
            secretName: openbao-server-tls
        - name: canary
          emptyDir:
            medium: Memory
${allowRecoveryRoot ? `        - name: auth-reconcile-policy
          emptyDir: {}
        - name: platform-policy
          emptyDir: {}
        - name: recovery
          secret:
            secretName: openbao-recovery
` : ""}`;

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
  const clusterSecretStoreDocument = fixture.legacyStoreHandoff.enabled
    ? `---
apiVersion: external-secrets.io/v1beta1
kind: ClusterSecretStore
metadata:
  name: openbao-backend
  labels:
    app.kubernetes.io/name: external-secrets
    app.kubernetes.io/instance: falcone
    app.kubernetes.io/managed-by: Helm
    app.kubernetes.io/part-of: in-falcone
    in-falcone.io/component: eso
spec:
  provider:
    vault:
      server: https://openbao.secret-store.svc.cluster.local:8200
      path: secret
      version: v2
      caProvider:
        type: Secret
        name: openbao-server-tls
        key: ca.crt
        namespace: secret-store
      auth:
        kubernetes:
          mountPath: kubernetes
          role: eso-role
          serviceAccountRef:
            name: eso-openbao-auth
            namespace: eso-system`
    : "";
  const renderedStorageDocuments = [
    ["falcone-documentdb-data", "local-path"],
    ["falcone-kafka-data", "local-path"],
    ["falcone-observability-data", "local-path"],
    ["falcone-postgresql-data", "local-path"],
    ["falcone-postgresql-vector-data", "hcloud-volumes"]
  ].map(([name, storageClassName]) => `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${name}
  namespace: ${fixture.release.namespace}
spec:
  storageClassName: ${storageClassName}
  resources:
    requests:
      storage: 10Gi`).join("\n");
  const renderedSeaweedfsDocuments = [
    ["falcone-seaweedfs-filer", "data-filer", "filer"],
    ["falcone-seaweedfs-master", "data-in-falcone-staging", "master"]
  ].map(([name, claimName, component]) => `---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${name}
  namespace: ${fixture.release.namespace}
spec:
  serviceName: ${name}
  selector:
    matchLabels:
      app.kubernetes.io/name: seaweedfs
      app.kubernetes.io/instance: ${fixture.release.name}
      app.kubernetes.io/component: ${component}
  volumeClaimTemplates:
    - metadata:
        name: ${claimName}
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: hcloud-volumes
        resources:
          requests:
            storage: 10Gi`).join("\n");
  const authRecoveryDocument = fixture.authRecovery?.enabled
    ? renderedAuthRecoveryJob(
        args.join(" ").includes("openbao.openbao.authReconcile.allowRecoveryRoot=true"),
        args.join(" ").includes("openbao.openbao.authReconcile.forceRecoveryRoot=true")
      )
    : "";
  return `${imageContract}\n${apisixDocument}\n${clusterSecretStoreDocument}\n${renderedStorageDocuments}\n${renderedSeaweedfsDocuments}\n${externalSecretDocuments.join("\n")}\n${authRecoveryDocument}\n`;
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
    if (realPackagedArchive) {
      fs.mkdirSync(destination, {recursive: true});
      const extracted = spawnSync("tar", ["-xzf", realPackagedArchive, "-C", destination], {
        encoding: "utf8"
      });
      if (extracted.status !== 0) {
        fail(`FAKE_REAL_PACKAGE_EXTRACTION_FAILED ${extracted.stderr || extracted.stdout}`);
      }
      process.stdout.write(
        `Pulled: packaged black-box in-falcone:${fixture.targetVersion}\nDigest: ${fixture.packageDigest}\n`
      );
      process.exit(0);
    }
    const chartDirectory = path.join(destination, "in-falcone");
    fs.mkdirSync(path.join(chartDirectory, "values"), {recursive: true});
    fs.writeFileSync(path.join(chartDirectory, "Chart.yaml"), `apiVersion: v2\nname: in-falcone\nversion: ${fixture.targetVersion}\n`);
    fs.writeFileSync(path.join(chartDirectory, "values", "staging.yaml"), "global: {}\n");
    process.stdout.write(`Pulled: public fixture in-falcone:${fixture.targetVersion}\nDigest: ${fixture.packageDigest}\n`);
    process.exit(0);
  }
  if (command === "template") {
    assertTargetVersion();
    const showOnly = option("--show-only");
    const allowRecoveryRoot = args.join(" ").includes(
      "openbao.openbao.authReconcile.allowRecoveryRoot=true"
    );
    const forceRecoveryRoot = args.join(" ").includes(
      "openbao.openbao.authReconcile.forceRecoveryRoot=true"
    );
    if (showOnly?.includes("openbao-auth-reconcile-job.yaml")) {
      if (fixture.authRecovery?.requireUpgradeRenderContext && !args.includes("--is-upgrade")) {
        fail(
          "Error: execution error at (in-falcone/templates/validate.yaml): " +
          "webhook key adoption/rotation/recovery/finalization is upgrade-only"
        );
      }
      if (realHelm) {
        const rendered = spawnSync(realHelm, args, {encoding: "utf8"});
        if (rendered.status !== 0) {
          process.stderr.write(rendered.stderr || rendered.stdout);
          process.exit(rendered.status ?? 1);
        }
        process.stdout.write(mutateRealAuthRender(rendered.stdout));
        process.exit(0);
      }
      process.stdout.write(`${renderedAuthRecoveryJob(allowRecoveryRoot, forceRecoveryRoot)}\n`);
    } else {
      if (realHelm) {
        const rendered = spawnSync(realHelm, args, {encoding: "utf8"});
        if (rendered.status !== 0) {
          process.stderr.write(rendered.stderr || rendered.stdout);
          process.exit(rendered.status ?? 1);
        }
        process.stdout.write(rendered.stdout);
        process.exit(0);
      }
      process.stdout.write(renderedChart());
    }
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
    if (fixture.legacyStoreHandoff.enabled && !storeIsHandedOff()) {
      fail("LEGACY_CLUSTERSECRETSTORE_HANDOFF_REQUIRED_BEFORE_HELM");
    }
    append(mutationPath, `helm upgrade release=${fixture.release.name} version=${fixture.targetVersion}`);
    const state = readState();
    if (fixture.phaseAPendingVector.enabled && state.upgrades === 0 && args.includes("--wait")) {
      fail(
        "Error: UPGRADE FAILED: timed out waiting for the condition on " +
        fixture.phaseAPendingVector.resource
      );
    }
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

const authJobNamePrefix = () =>
  `openbao-auth-reconcile-r24-${fixture.packageDigest.replace(/^sha256:/, "").slice(0, 12)}-`;
const canonicalJobRef = (value) => {
  const match = value?.match(/^job(?:\.batch)?\/(.+)$/);
  return match ? `job.batch/${match[1]}` : null;
};
const createAuthRecoveryJob = (source) => {
  if (!fixture.authRecovery?.enabled) return false;
  const kinds = [...source.matchAll(/^kind:\s*([^\s]+)\s*$/gm)].map((match) => match[1]);
  if (kinds.length !== 1 || kinds[0] !== "Job") return false;

  const expectedGenerateName = authJobNamePrefix();
  const generateName = source.match(/^\s{2}generateName:\s*([^\s]+)\s*$/m)?.[1];
  if (generateName !== expectedGenerateName || /^\s{2}name:\s*openbao-auth-reconcile\s*$/m.test(source)) {
    fail(`FAKE_AUTH_RECOVERY_GENERATE_NAME_REQUIRED expected=${expectedGenerateName}`);
  }
  if (!source.includes(`falcone.gntik.ai/attested-chart-version: "${fixture.targetVersion}"`)) {
    fail("FAKE_AUTH_RECOVERY_JOB_NOT_FROM_ATTESTED_CHART");
  }
  if (!/^\s*activeDeadlineSeconds:\s*300\s*$/m.test(source)) {
    fail("FAKE_AUTH_RECOVERY_ACTIVE_DEADLINE_DRIFT");
  }
  if (!/^\s*secretName:\s*openbao-recovery\s*$/m.test(source)) {
    fail("FAKE_AUTH_RECOVERY_ROOT_NOT_ENABLED");
  }
  if (fixture.authRecovery.requireForcedRecoveryRoot) {
    if (!source.includes('auth_source=recovery_root result=accepted')) {
      fail("FAKE_AUTH_RECOVERY_FORCE_ROOT_MARKER_REQUIRED");
    }
  }
  const metadata = source.match(/^metadata:\s*\n([\s\S]*?)^spec:\s*$/m)?.[1] ?? "";
  const annotations = metadata.match(/^\s{2}annotations:\s*\n([\s\S]*)$/m)?.[1] ?? "";
  const hasAnnotation = (key, value) => {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s{4}${escapedKey}:\\s*["']?${escapedValue}["']?\\s*$`, "m").test(annotations);
  };
  if (!hasAnnotation("in-falcone.io/recovery-package-digest", fixture.packageDigest)) {
    fail("FAKE_AUTH_RECOVERY_ANNOTATION_MISSING field=package-digest");
  }
  if (!hasAnnotation("in-falcone.io/recovery-target-chart", fixture.targetChart)) {
    fail("FAKE_AUTH_RECOVERY_ANNOTATION_MISSING field=chart");
  }
  if (!hasAnnotation("in-falcone.io/recovery-source-revision", "24")) {
    fail("FAKE_AUTH_RECOVERY_ANNOTATION_MISSING field=source-revision");
  }
  for (const [key, value] of [
    ["falcone.gntik.ai/attested-chart-version", fixture.targetVersion],
    ["helm.sh/hook", "post-install,post-upgrade"],
    ["helm.sh/hook-delete-policy", "before-hook-creation,hook-succeeded"]
  ]) {
    if (!hasAnnotation(key, value)) fail(`FAKE_AUTH_RECOVERY_METADATA_NOT_PRESERVED field=${key}`);
  }
  const nameOutput = kubectlArgs.some((argument, index) =>
    argument === "--output=name" || argument === "-o=name" ||
    ((argument === "-o" || argument === "--output") && kubectlArgs[index + 1] === "name")
  );
  if (!nameOutput) fail("FAKE_AUTH_RECOVERY_NAME_OUTPUT_REQUIRED");
  if (namespace !== "secret-store" && !/^\s{2}namespace:\s*secret-store\s*$/m.test(source)) {
    fail("FAKE_AUTH_RECOVERY_NAMESPACE_DRIFT");
  }
  if (fixture.authRecovery.createMode === "fail") {
    fail("Error from server (InternalError): synthetic auth recovery Job create failure");
  }

  const state = readState();
  const suffix = fixture.authRecovery.createdJobSuffixes[state.authRecoveryCreatedRefs.length];
  if (!suffix) fail("FAKE_AUTH_RECOVERY_UNIQUE_SUFFIX_EXHAUSTED");
  const ref = `job.batch/${expectedGenerateName}${suffix}`;
  const unquoteYamlScalar = (value) => {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replaceAll("''", "'");
    }
    return trimmed;
  };
  const persistedAnnotations = {};
  for (const line of annotations.split("\n")) {
    const match = line.match(/^\s{4}([^:\s]+):\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].replace(/^["']|["']$/g, "");
    persistedAnnotations[key] = unquoteYamlScalar(match[2]);
  }
  const expectedAnnotationKeys = [
    "falcone.gntik.ai/attested-chart-version",
    "helm.sh/hook",
    "helm.sh/hook-weight",
    "helm.sh/hook-delete-policy",
    "in-falcone.io/recovery-package-digest",
    "in-falcone.io/recovery-target-chart",
    "in-falcone.io/recovery-source-revision"
  ].sort();
  if (JSON.stringify(Object.keys(persistedAnnotations).sort()) !== JSON.stringify(expectedAnnotationKeys)) {
    fail(
      `FAKE_AUTH_RECOVERY_ANNOTATION_SET_DRIFT actual=${Object.keys(persistedAnnotations).sort().join(",")}`
    );
  }
  const creationIndex = state.authRecoveryCreatedRefs.length;
  const createdName = ref.replace(/^job(?:\.batch)?\//, "");
  const persistedJob = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: createdName,
      generateName: expectedGenerateName,
      namespace: "secret-store",
      uid: `00000000-0000-4000-8000-${(creationIndex + 1).toString(16).padStart(12, "0")}`,
      annotations: persistedAnnotations
    }
  };
  state.authRecoveryApplied = true;
  state.authRecoveryCompleted = false;
  state.authRecoveryCurrentRef = ref;
  state.authRecoveryCreatedRefs.push(ref);
  state.authRecoveryCreatedJobs.push({ref, object: persistedJob});
  writeState(state);
  const summary = [
    "kubectl create auth-reconcile-job",
    `ref=${ref}`,
    `generateName=${expectedGenerateName}`,
    `chart=${fixture.targetChart}`,
    `digest=${fixture.packageDigest}`,
    "sourceRevision=24",
    "allowRecoveryRoot=true"
  ].join(" ");
  append(tracePath, summary);
  append(mutationPath, summary);
  if (fixture.authRecovery.createMode === "wrong-prefix") {
    const returnedRef = `job.batch/openbao-auth-reconcile-unbound-${suffix}`;
    append(tracePath, `kubectl create auth-reconcile-output lineCount=1 value=${returnedRef}`);
    process.stdout.write(`${returnedRef}\n`);
  } else if (fixture.authRecovery.createMode === "multiple") {
    const extraRef = `job.batch/${expectedGenerateName}extra-${suffix}`;
    append(tracePath, `kubectl create auth-reconcile-output lineCount=2 values=${ref},${extraRef}`);
    process.stdout.write(`${ref}\n${extraRef}\n`);
  } else {
    append(tracePath, `kubectl create auth-reconcile-output lineCount=1 value=${ref}`);
    process.stdout.write(`${ref}\n`);
  }
  return true;
};

const manifestInput = () => {
  const fileIndex = kubectlArgs.findIndex((argument) => argument === "-f" || argument === "--filename");
  if (fileIndex === -1) return fs.readFileSync(0, "utf8");
  const source = kubectlArgs[fileIndex + 1];
  return source === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(source, "utf8");
};

if (kubectlCommand === "create") {
  const source = manifestInput();
  const kind = source.match(/\n\s*kind:\s*([^\s]+)\s*\n/)?.[1];
  const name = source.match(/\n\s*name:\s*([^\s]+)\s*\n/)?.[1];
  const generateName = source.match(/\n\s*generateName:\s*([^\s]+)\s*\n/)?.[1];
  if (kind === "Job" && (name === "openbao-auth-reconcile" || generateName?.startsWith("openbao-auth-reconcile-r24-"))) {
    if (kubectlArgs.some((argument) => argument.startsWith("--dry-run"))) {
      json({apiVersion: "batch/v1", kind, metadata: {name, namespace: "secret-store"}});
      process.exit(0);
    }
    if (createAuthRecoveryJob(source)) process.exit(0);
  }
  if (kind === "Deployment" && name === "falcone-apisix") {
    json(renderedApisixDeployment());
    process.exit(0);
  }
  if (kind === "ClusterSecretStore" && name === "openbao-backend") {
    json({
      apiVersion: "external-secrets.io/v1beta1",
      kind: "ClusterSecretStore",
      metadata: {
        name,
        labels: structuredClone(fixture.legacyStoreHandoff.live.metadata.labels)
      },
      spec: structuredClone(fixture.legacyStoreHandoff.desiredSpec)
    });
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

if (kubectlCommand === "apply" && kubectlArgs.some((argument) => argument === "-f" || argument === "--filename")) {
  const source = manifestInput();
  if (/^kind:\s*Job\s*$/m.test(source) && /openbao-auth-reconcile/.test(source)) {
    fail("FAKE_AUTH_RECOVERY_CREATE_REQUIRED");
  }
  append(mutationPath, `kubectl ${kubectlArgs.join(" ")}`);
  process.exit(0);
}

if (kubectlCommand === "wait") {
  const waitTarget = kubectlArgs.join(" ");
  const requestedJobRef = kubectlArgs.map(canonicalJobRef).find(Boolean);
  if (requestedJobRef?.startsWith(`job.batch/${authJobNamePrefix()}`)) {
    const state = readState();
    if (requestedJobRef !== state.authRecoveryCurrentRef) {
      fail(`FAKE_AUTH_RECOVERY_STALE_JOB_WAIT ref=${requestedJobRef}`);
    }
    if (!/--for=condition=(?:Complete|complete)(?:\s|$)/.test(waitTarget)) {
      fail("FAKE_AUTH_RECOVERY_COMPLETE_WAIT_REQUIRED");
    }
    if (!/(?:^|\s)--timeout(?:=|\s+)5m(?:\s|$)/.test(waitTarget)) {
      fail("FAKE_AUTH_RECOVERY_FIVE_MINUTE_WAIT_REQUIRED");
    }
    if (state.authRecoveryWaitFailures > 0) {
      state.authRecoveryWaitFailures -= 1;
      writeState(state);
      fail(`error: timed out waiting for the condition on ${requestedJobRef}`);
    }
    state.authRecoveryCompleted = true;
    state.authRecoveryCompletedRefs.push(requestedJobRef);
    writeState(state);
    process.exit(0);
  }
  if (requestedJobRef === "job.batch/openbao-auth-reconcile" &&
      fixture.authRecovery?.enabled && readState().authRecoveryLogReads === 0) {
    fail("FAKE_AUTH_RECOVERY_FRESH_JOB_REF_REQUIRED");
  }
  if (
    fixture.legacyStoreHandoff.enabled &&
    /(?:clustersecretstore|externalsecret)/.test(waitTarget) &&
    !storeIsHandedOff()
  ) {
    fail("FAKE_ESO_READINESS_REQUIRES_STORE_HANDOFF");
  }
  if (/clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(waitTarget) &&
      fixture.reachability?.storeWaitFails) {
    fail("error: timed out waiting for condition Ready on clustersecretstore/openbao-backend");
  }
  if (/clustersecretstore(?:\.external-secrets\.io)?\/openbao-backend/.test(waitTarget)) {
    const state = readState();
    if (state.storeWaitFailures > 0) {
      state.storeWaitFailures -= 1;
      writeState(state);
      fail("error: timed out waiting for condition Ready on clustersecretstore/openbao-backend");
    }
  }
  const externalSecretName = waitTarget.match(/externalsecret(?:\.external-secrets\.io)?\/([^\s]+)/)?.[1];
  if (externalSecretName && externalSecretName === fixture.reachability?.externalSecretWaitFailure) {
    fail(`error: timed out waiting for condition Ready on externalsecret/${externalSecretName}`);
  }
  process.exit(0);
}

if (kubectlCommand === "rollout" && kubectlArgs[1] === "status") {
  process.exit(0);
}

if (kubectlCommand === "logs" && canonicalJobRef(kubectlArgs[1])) {
  if (fixture.authRecovery?.enabled) {
    const state = readState();
    const requestedJobRef = canonicalJobRef(kubectlArgs[1]);
    const isFreshRecoveryJob = requestedJobRef?.startsWith(`job.batch/${authJobNamePrefix()}`);
    if (isFreshRecoveryJob) {
      if (requestedJobRef !== state.authRecoveryCurrentRef) {
        fail(`FAKE_AUTH_RECOVERY_STALE_JOB_LOG ref=${requestedJobRef}`);
      }
      if (!state.authRecoveryCompletedRefs.includes(requestedJobRef)) {
        fail("FAKE_AUTH_RECOVERY_LOG_BEFORE_COMPLETE");
      }
    } else if (state.authRecoveryLogReads === 0) {
      fail("FAKE_AUTH_RECOVERY_FRESH_JOB_LOG_REQUIRED");
    }
    const log = isFreshRecoveryJob
      ? fixture.authRecovery.preflightLog
      : fixture.authRecovery.healthLog;
    state.authRecoveryLogReads += 1;
    writeState(state);
    process.stdout.write(`${log}\n`);
  } else {
    process.stdout.write("result=unchanged code=AUTH_METADATA_MATCHED canary=passed\n");
  }
  process.exit(0);
}

if (
  kubectlCommand === "patch" &&
  ["clustersecretstore", "clustersecretstores", "clustersecretstore.external-secrets.io"].includes(
    kubectlArgs[1]
  ) &&
  kubectlArgs[2] === "openbao-backend"
) {
  if (fixture.authRecovery?.enabled && readState().authRecoveryLogReads < 1) {
    fail("AUTH_RECOVERY_REQUIRED_BEFORE_CLUSTERSECRETSTORE_HANDOFF");
  }
  const patchOptionIndex = kubectlArgs.findIndex((argument) => argument === "-p" || argument === "--patch");
  if (patchOptionIndex === -1) fail("FAKE_STORE_JSON_PATCH_REQUIRED");
  if (!kubectlArgs.some((argument, index) =>
    argument === "--type=json" || (argument === "--type" && kubectlArgs[index + 1] === "json")
  )) {
    fail("FAKE_STORE_JSON_PATCH_TYPE_REQUIRED");
  }
  let operations;
  try {
    operations = JSON.parse(kubectlArgs[patchOptionIndex + 1]);
  } catch {
    fail("FAKE_STORE_JSON_PATCH_INVALID");
  }
  assert.deepEqual(operations, [
    {
      op: "test",
      path: "/metadata/uid",
      value: fixture.legacyStoreHandoff.live.metadata.uid
    },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: fixture.legacyStoreHandoff.live.metadata.resourceVersion
    },
    {op: "remove", path: "/metadata/annotations/helm.sh~1hook"},
    {op: "remove", path: "/metadata/annotations/helm.sh~1hook-weight"},
    {op: "replace", path: "/spec", value: fixture.legacyStoreHandoff.desiredSpec}
  ]);
  if (fixture.legacyStoreHandoff.concurrentResourceVersionDrift) {
    fail(
      "Error from server (Conflict): JSON Patch resourceVersion test failed: expected " +
      fixture.legacyStoreHandoff.live.metadata.resourceVersion +
      " actual " +
      String(Number(fixture.legacyStoreHandoff.live.metadata.resourceVersion) + 1)
    );
  }
  append(mutationPath, `kubectl ${kubectlArgs.join(" ")}`);
  const state = readState();
  state.storeHandedOff = true;
  writeState(state);
  json(liveClusterSecretStore());
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

if (resource === "namespace" && [fixture.release.namespace, "eso-system"].includes(name)) {
  json({apiVersion: "v1", kind: "Namespace", metadata: {name}});
  process.exit(0);
}

if (
  resource === "serviceaccount" &&
  namespace === "eso-system" &&
  name === "eso-openbao-auth"
) {
  json(fixture.legacyStoreHandoff.serviceAccount);
  process.exit(0);
}

if (["job", "jobs", "job.batch", "jobs.batch"].includes(resource) && namespace === "secret-store") {
  const state = readState();
  const stale = (fixture.authRecovery?.staleJobs ?? []).map((job) =>
    job.object
      ? structuredClone(job.object)
      : {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: {name: job.ref.replace(/^job(?:\.batch)?\//, ""), namespace},
        status: {conditions: [{type: "Failed", status: "True"}]}
      }
  );
  const created = state.authRecoveryCreatedRefs.map((ref) => {
    const completed = state.authRecoveryCompletedRefs.includes(ref);
    const persisted = state.authRecoveryCreatedJobs?.find((job) => job.ref === ref)?.object;
    if (!persisted) fail(`FAKE_AUTH_RECOVERY_PERSISTED_JOB_MISSING ref=${ref}`);
    const job = structuredClone(persisted);
    if (!completed) {
      job.status = {
        failed: 1,
        conditions: ["FailureTarget", "Failed"].map((type) => ({
          type,
          status: "True",
          reason: "BackoffLimitExceeded"
        }))
      };
      return job;
    }
    job.status = {
      succeeded: 1,
      failed: 0,
      conditions: ["SuccessCriteriaMet", "Complete"].map((type) => ({
        type,
        status: "True",
        reason: "CompletionsReached"
      }))
    };
    return job;
  });
  const jobs = [...stale, ...created];
  if (name) {
    const job = jobs.find((candidate) => candidate.metadata.name === name);
    if (!job) fail(`fake auth recovery Job not found: ${name}`);
    json(job);
  } else {
    json({apiVersion: "v1", kind: "List", items: jobs});
  }
  process.exit(0);
}

if (
  ["clustersecretstore", "clustersecretstore.external-secrets.io"].includes(resource) &&
  name === "openbao-backend"
) {
  json(liveClusterSecretStore());
  process.exit(0);
}

if (["clustersecretstores", "clustersecretstores.external-secrets.io"].includes(resource)) {
  json({
    apiVersion: "v1",
    kind: "List",
    items: [liveClusterSecretStore(), ...(fixture.legacyStoreHandoff.extraStores ?? [])]
  });
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

if (
  ["pod", "pods"].includes(resource) &&
  name === fixture.revision24GlobalWait.vectorPod.metadata.name
) {
  json(fixture.revision24GlobalWait.vectorPod);
  process.exit(0);
}

if (resource === "pods") {
  let items = livePods();
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
  if (name === fixture.revision24GlobalWait.vectorPvc.metadata.name) {
    json(fixture.revision24GlobalWait.vectorPvc);
    process.exit(0);
  }
  const pvc = fixture.storage.pvcs[name];
  if (!pvc) fail(`fake pvc not found: ${name}`);
  json(pvc);
  process.exit(0);
}

if ((resource === "statefulset" || resource === "statefulset.apps") && name) {
  if (name === fixture.revision24GlobalWait.vectorStatefulSet.metadata.name) {
    json(fixture.revision24GlobalWait.vectorStatefulSet);
    process.exit(0);
  }
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

if (["externalsecrets.external-secrets.io", "externalsecrets"].includes(resource)) {
  json({apiVersion: "v1", kind: "List", items: externalSecrets()});
  process.exit(0);
}

if (["externalsecret.external-secrets.io", "externalsecret"].includes(resource) && name) {
  const externalSecret = externalSecrets().find((item) => item.metadata.name === name);
  if (!externalSecret) fail(`fake externalsecret not found: ${name}`);
  json(externalSecret);
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
