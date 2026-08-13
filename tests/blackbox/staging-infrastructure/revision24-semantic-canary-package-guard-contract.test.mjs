/**
 * Revision-24 semantic-canary release contracts.
 *
 * Every recovery execution packages the public chart, invokes the repair CLI
 * distributed in that package, and delegates Helm rendering to the real Helm
 * binary against that same archive. Only live Kubernetes/registry effects and
 * explicitly named negative render drifts are substituted.
 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {after, test} from "node:test";
import {fileURLToPath} from "node:url";

import {
  runRevision24DigestBoundPolicyRecovery
} from "../fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../../..");
const chartSource = path.join(repositoryRoot, "charts/in-falcone");
const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "falcone-r24-semantic-canary-bbx-"));

const locateHelm = spawnSync("bash", ["-lc", "command -v helm"], {encoding: "utf8"});
assert.equal(locateHelm.status, 0, `real Helm is required: ${locateHelm.stderr}`);
const realHelm = locateHelm.stdout.trim();

const packaged = spawnSync(realHelm, ["package", chartSource, "--destination", workDirectory], {
  cwd: repositoryRoot,
  encoding: "utf8"
});
assert.equal(packaged.status, 0, `helm package failed:\n${packaged.stdout}\n${packaged.stderr}`);
const archives = fs.readdirSync(workDirectory).filter((name) => /^in-falcone-.+\.tgz$/.test(name));
assert.equal(archives.length, 1, "release proof requires exactly one packaged chart archive");
const archive = path.join(workDirectory, archives[0]);
const extractionDirectory = path.join(workDirectory, "extracted");
fs.mkdirSync(extractionDirectory);
const extracted = spawnSync("tar", ["-xzf", archive, "-C", extractionDirectory], {encoding: "utf8"});
assert.equal(extracted.status, 0, `packaged chart extraction failed: ${extracted.stderr}`);
const packagedChart = path.join(extractionDirectory, "in-falcone");
const chartMetadata = fs.readFileSync(path.join(packagedChart, "Chart.yaml"), "utf8");
const topLevelVersions = [...chartMetadata.matchAll(/^version:\s*(\S+)\s*$/gm)].map((match) => match[1]);
assert.equal(topLevelVersions.length, 1, "the package must expose one top-level chart version");
const targetVersion = topLevelVersions[0];
const targetChart = `in-falcone-${targetVersion}`;
const packageDigest = `sha256:${createHash("sha256").update(fs.readFileSync(archive)).digest("hex")}`;
const distributedRepairCli = path.join(packagedChart, "migrations/revision-20-repair.sh");

after(() => fs.rmSync(workDirectory, {recursive: true, force: true}));

const combined = (result) => `${result.stdout}\n${result.stderr}`;
const traceLines = (result) => result.trace.split("\n").filter(Boolean);
const authCreates = (result) => traceLines(result).filter((line) =>
  line.startsWith("kubectl create auth-reconcile-job ")
);

function runPackagedRecovery(options = {}) {
  return runRevision24DigestBoundPolicyRecovery({
    targetVersion,
    packageDigest,
    recoveryEntrypoint: distributedRepairCli,
    invokeWithBash: true,
    entrypointArguments: ["--phase-a"],
    packagedArchive: archive,
    realHelm,
    ...options
  });
}

function runHelm(args, context) {
  const result = spawnSync(realHelm, args, {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(
    result.status,
    0,
    `${context} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  );
  return result.stdout;
}

const upgradeEvidenceArgs = [
  "--set-string", "deployment.upgrade.currentVersion=0.3.1",
  "--set", "global.webhookDatabase.migration.backupVerified=true",
  "--set", "global.webhookDatabase.migration.parityVerified=true",
  "--set-string", "global.webhookDatabase.migration.backupReference=bbx:proof"
];

function renderForcedJob() {
  return runHelm([
    "template", "falcone", packagedChart,
    "--version", targetVersion,
    "--namespace", "in-falcone-staging",
    "--is-upgrade",
    ...upgradeEvidenceArgs,
    "--set", "openbao.openbao.authReconcile.allowRecoveryRoot=true",
    "--set", "openbao.openbao.authReconcile.forceRecoveryRoot=true",
    "--show-only", "charts/openbao/templates/openbao-auth-reconcile-job.yaml"
  ], "forced recovery Job render");
}

function renderRoutineJob() {
  return runHelm([
    "template", "falcone", packagedChart,
    "--version", targetVersion,
    "--namespace", "in-falcone-staging",
    "--is-upgrade",
    ...upgradeEvidenceArgs,
    "--show-only", "charts/openbao/templates/openbao-auth-reconcile-job.yaml"
  ], "routine auth Job render");
}

function assertNoSecretReadsOrRollback(result, context) {
  assert.doesNotMatch(
    result.trace,
    /kubectl .*\bget (?:secret|secrets)(?:\s|$)/,
    `${context} read a Kubernetes Secret resource`
  );
  assert.doesNotMatch(result.trace, /helm (?:rollback|uninstall)\b/, `${context} attempted rollback`);
}

function assertGuardRejectedBeforeCreate(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly passed the package guard`);
  assert.match(combined(result), /REVISION24_AUTH_RECONCILE_RENDER_DRIFT/);
  assert.equal(authCreates(result).length, 0, `${context} reached the auth Job create boundary`);
  assert.doesNotMatch(result.mutations, /kubectl .*\bpatch\b|^helm upgrade\b/m);
  assertNoSecretReadsOrRollback(result, context);
}

function currentFailedRetry(number) {
  const digest12 = packageDigest.replace(/^sha256:/, "").slice(0, 12);
  const suffix = `prior${number}`;
  const name = `openbao-auth-reconcile-r24-${digest12}-${suffix}`;
  return {
    ref: `job.batch/${name}`,
    status: "Failed",
    object: {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name,
        namespace: "secret-store",
        uid: `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`,
        annotations: {
          "falcone.gntik.ai/attested-chart-version": targetVersion,
          "helm.sh/hook": "post-install,post-upgrade",
          "helm.sh/hook-weight": "-3",
          "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
          "in-falcone.io/recovery-package-digest": packageDigest,
          "in-falcone.io/recovery-target-chart": targetChart,
          "in-falcone.io/recovery-source-revision": "24"
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
    }
  };
}

function currentSuccessfulRetry(number) {
  const retry = currentFailedRetry(number);
  retry.status = "Complete";
  retry.object.status = {
    succeeded: 1,
    failed: 0,
    conditions: ["SuccessCriteriaMet", "Complete"].map((type) => ({
      type,
      status: "True",
      reason: "CompletionsReached"
    }))
  };
  return retry;
}

function assertHistoryRejectedBeforeMutation(result, context) {
  assert.notEqual(result.status, 0, `${context} unexpectedly passed retained-history validation`);
  assert.match(combined(result), /REVISION24_AUTH_RECONCILE_HISTORY_DRIFT/);
  assert.equal(authCreates(result).length, 0, `${context} reached the create boundary`);
  assert.equal(result.mutations, "", `${context} reached a mutating public operation`);
}

// bbx-repair-staging-091 | fn-revision24-semantic-canary-binding | OpenSpec #### Scenario: Revision-24 package guard binds exactly one semantic canary assignment
test("bbx-repair-staging-091 binds the semantic canary in the exact real packaged render", () => {
  const render = renderForcedJob();
  const genericLogins = [...render.matchAll(/bao write -format=json auth\/kubernetes\/login/g)];
  const semanticCanaries = [...render.matchAll(
    /canary_json="\$\(bao write -format=json auth\/kubernetes\/login \\\n\s*role="\$role" jwt="\$\(cat \/canary\/token\)"/g
  )];
  assert.equal(genericLogins.length, 2, "the real render must retain dedicated and canary logins");
  assert.equal(semanticCanaries.length, 1, "the real render must contain one exact semantic canary");
  assert.ok(
    render.indexOf('login_json="$(bao write -format=json auth/kubernetes/login') <
      semanticCanaries[0].index,
    "the dedicated login must remain lexically earlier than the semantic canary"
  );

  const result = runPackagedRecovery();
  assert.equal(
    result.status,
    0,
    [
      "the distributed CLI rejected the exact real packaged render",
      `target=${targetChart}`,
      `stdout:\n${result.stdout}`,
      `stderr:\n${result.stderr}`,
      `trace:\n${result.trace}`
    ].join("\n")
  );
  assert.equal(authCreates(result).length, 1, "the semantic canary must lead to one fresh create");
});

// bbx-repair-staging-092 | fn-revision24-semantic-canary-drift | OpenSpec #### Scenario: Revision-24 package guard rejects canary identity drift before mutation
test("bbx-repair-staging-092 rejects every semantic canary identity drift before create", async (t) => {
  for (const mutation of [
    "canary-assignment",
    "canary-role",
    "canary-token",
    "canary-duplicate"
  ]) {
    await t.test(mutation, () => {
      assertGuardRejectedBeforeCreate(
        runPackagedRecovery({renderMutation: mutation}),
        mutation
      );
    });
  }
});

// bbx-repair-staging-093 | fn-revision24-forced-recovery-guard-order | OpenSpec #### Scenario: Revision-24 package guard enforces the complete forced-recovery order
test("bbx-repair-staging-093 enforces snapshots-to-terminal order and structural invariants", async (t) => {
  const render = renderForcedJob();
  const orderedAnchors = [
    "cat > /openbao-platform/platform.hcl",
    "cat > /openbao-auth-reconcile/auth-reconcile.hcl",
    "sha256sum /openbao-platform/platform.hcl",
    "sha256sum /openbao-auth-reconcile/auth-reconcile.hcl",
    "auth_source=recovery_root result=accepted",
    "bao policy write platform /openbao-platform/platform.hcl",
    "bao policy write auth-reconcile /openbao-auth-reconcile/auth-reconcile.hcl",
    "bao write auth/kubernetes/role/openbao-init-role",
    "bao write auth/kubernetes/role/openbao-auth-reconcile-role",
    'bao write "auth/kubernetes/role/$role"',
    'canary_json="$(bao write -format=json auth/kubernetes/login',
    "bao read -format=json auth/token/lookup-self",
    "bao write -force auth/token/revoke-self",
    "result=unchanged code=AUTH_METADATA_MATCHED canary=passed"
  ];
  const positions = orderedAnchors.map((anchor) => render.indexOf(anchor));
  assert.ok(positions.every((position) => position >= 0), `missing forced-order anchor: ${positions}`);
  assert.ok(
    positions.every((position, index) => index === 0 || positions[index - 1] < position),
    `forced recovery order drift: ${positions.join(" < ")}`
  );

  for (const mutation of ["canary-order", "snapshot", "hash", "mount", "restart", "backoff"]) {
    await t.test(mutation, () => {
      assertGuardRejectedBeforeCreate(
        runPackagedRecovery({renderMutation: mutation}),
        mutation
      );
    });
  }
});

// bbx-repair-staging-094 | fn-revision24-real-package-cli-guard | OpenSpec #### Scenario: Revision-24 public CLI validates the exact real packaged render
test("bbx-repair-staging-094 drives the distributed CLI through its exact packaged Helm render", () => {
  const result = runPackagedRecovery();
  const trace = traceLines(result);
  const pullIndex = trace.findIndex((line) => line.startsWith("helm pull "));
  const historyIndex = trace.findIndex((line) => line.startsWith("helm history "));
  const retainedJobsIndex = trace.findIndex((line) =>
    /kubectl -n secret-store get jobs\.batch -o json/.test(line)
  );
  const renderIndex = trace.findIndex((line) =>
    line.startsWith("helm template ") &&
    line.includes("--show-only charts/openbao/templates/openbao-auth-reconcile-job.yaml")
  );
  const createIndex = trace.findIndex((line) => line.startsWith("kubectl create auth-reconcile-job "));

  assert.equal(result.status, 0, `exact public package/CLI path failed:\n${combined(result)}\n${result.trace}`);
  assert.ok(pullIndex >= 0, "the CLI did not load its package-bound chart");
  assert.ok(historyIndex >= 0 && retainedJobsIndex > historyIndex, "history gates were not read-only ordered");
  assert.ok(renderIndex > retainedJobsIndex, "the real auth render preceded retained-history validation");
  assert.ok(createIndex > renderIndex, "create preceded the real package guard");
  assert.equal(authCreates(result).length, 1, "the public CLI must create exactly one fresh Job");
  assert.match(authCreates(result)[0], new RegExp(`chart=${targetChart.replaceAll(".", "\\.")}`));
  assert.match(authCreates(result)[0], new RegExp(`digest=${packageDigest}`));
});

// bbx-repair-staging-095 | fn-revision24-authorization-mutation-boundary | OpenSpec #### Scenario: Revision-24 pre-create failure distinguishes authorization consumption from cluster mutation
test("bbx-repair-staging-095 distinguishes consumed authorization from the create mutation boundary", async (t) => {
  await t.test("guard rejection consumes JIT but reports no cluster mutation", () => {
    const result = runPackagedRecovery({renderMutation: "canary-role"});
    assert.notEqual(result.status, 0);
    assert.match(combined(result), /authorization_consumed=true/);
    assert.match(combined(result), /mutation_started=false/);
    assert.doesNotMatch(combined(result), /mutation_started=true|FORWARD_RECOVERY_REQUIRED/);
    assert.equal(authCreates(result).length, 0);
    assert.equal(result.mutations, "");
  });

  await t.test("create failure marks possible mutation and fails forward", () => {
    const result = runPackagedRecovery({createMode: "fail"});
    assert.notEqual(result.status, 0);
    assert.match(combined(result), /REVISION24_AUTH_RECONCILE_CREATE_FAILED/);
    assert.match(combined(result), /authorization_consumed=true/);
    assert.match(combined(result), /mutation_started=true/);
    assert.match(combined(result), /FORWARD_RECOVERY_REQUIRED/);
    assert.match(result.trace, /kubectl -n secret-store create -f \S+ -o name/);
    assert.doesNotMatch(result.mutations, /kubectl .*\bpatch\b|^helm upgrade\b/m);
  });
});

// bbx-repair-staging-096 | fn-revision24-forward-history-fence | OpenSpec #### Scenario: Revision-24 recovery preserves only historical anchors and current 0.4.19 retries
test("bbx-repair-staging-096 admits only .14/.16/.17 anchors and current-target retries", async (t) => {
  await t.test("exact anchors plus zero current retries", () => {
    const result = runPackagedRecovery();
    assert.equal(result.status, 0, `exact retained history failed:\n${combined(result)}\n${result.trace}`);
    assert.equal(authCreates(result).length, 1);
  });

  await t.test("exact anchors plus N fully attested current retries", () => {
    const result = runPackagedRecovery({
      mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(
        currentFailedRetry(1),
        currentFailedRetry(2)
      )
    });
    assert.equal(result.status, 0, `current retry history failed:\n${combined(result)}\n${result.trace}`);
    assert.equal(authCreates(result).length, 1, "retained retries must never substitute for a fresh create");
  });

  await t.test("a created failed Job round-trips with exact metadata and a retry creates a new identity", () => {
    const result = runPackagedRecovery({attemptCount: 2, waitFailures: 1});
    assert.notEqual(result.attempts[0].status, 0, "first attempt must fail after creating its Job");
    assert.match(combined(result.attempts[0]), /REVISION24_AUTH_RECONCILE_INCOMPLETE/);
    assert.match(combined(result.attempts[0]), /mutation_started=true/);
    assert.equal(result.attempts[1].status, 0, `failed Job round trip was rejected:\n${combined(result)}`);
    const firstCreates = authCreates(result.attempts[0]);
    const secondCreates = authCreates(result.attempts[1]);
    assert.equal(firstCreates.length, 1);
    assert.equal(secondCreates.length, 1);
    const firstRef = firstCreates[0].match(/\bref=(\S+)/)?.[1];
    const secondRef = secondCreates[0].match(/\bref=(\S+)/)?.[1];
    assert.ok(firstRef && secondRef && firstRef !== secondRef, "retry reused the first created identity");
    assert.doesNotMatch(
      result.attempts[1].trace,
      new RegExp(`kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${firstRef.replaceAll(".", "\\.")}`),
      "retry operated on the retained failed Job"
    );
  });

  await t.test("a retained successful current Job remains evidence while a fresh identity runs", () => {
    const successful = currentSuccessfulRetry(3);
    successful.object.status.conditions.reverse();
    const result = runPackagedRecovery({
      mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(structuredClone(successful))
    });
    assert.equal(result.status, 0, `successful current Job was rejected:\n${combined(result)}\n${result.trace}`);
    const [fresh] = authCreates(result);
    assert.ok(fresh, "recovery did not create a fresh Job after retained success");
    assert.doesNotMatch(fresh, new RegExp(`ref=${successful.ref.replaceAll(".", "\\.")}(?:\\s|$)`));
    assert.doesNotMatch(
      result.trace,
      new RegExp(`kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${successful.ref.replaceAll(".", "\\.")}`),
      "recovery reused or mutated the retained successful Job"
    );
  });

  await t.test("a Job completed before a downstream failure round-trips and a retry creates a new identity", () => {
    const result = runPackagedRecovery({
      attemptCount: 2,
      storeWaitFailures: 1
    });
    assert.notEqual(result.attempts[0].status, 0, "first attempt must fail after successful auth");
    assert.match(combined(result.attempts[0]), /FORWARD_RECOVERY_REQUIRED/);
    assert.equal(result.attempts[1].status, 0, `successful Job round trip was rejected:\n${combined(result)}`);
    const firstCreates = authCreates(result.attempts[0]);
    const secondCreates = authCreates(result.attempts[1]);
    assert.equal(firstCreates.length, 1);
    assert.equal(secondCreates.length, 1);
    const secondTrace = traceLines(result.attempts[1]);
    const historyReadIndex = secondTrace.findIndex((line) =>
      /^kubectl -n secret-store get jobs\.batch -o json$/.test(line)
    );
    const createIndex = secondTrace.findIndex((line) =>
      /^kubectl -n secret-store create -f \S+ -o name$/.test(line)
    );
    assert.ok(historyReadIndex >= 0, "successful round-trip retry skipped retained Job history");
    assert.ok(createIndex > historyReadIndex, "successful round-trip retry created before history validation");
    const firstRef = firstCreates[0].match(/\bref=(\S+)/)?.[1];
    const secondRef = secondCreates[0].match(/\bref=(\S+)/)?.[1];
    assert.ok(firstRef && secondRef && firstRef !== secondRef, "retry reused the successful identity");
    assert.doesNotMatch(
      result.attempts[1].trace,
      new RegExp(`kubectl .*\\b(?:wait|logs|delete|apply)\\b.*${firstRef.replaceAll(".", "\\.")}`),
      "retry operated on the retained successful Job"
    );
  });

  await t.test("rejects retained successful Job drift on a complete-state retry before create", () => {
    const result = runPackagedRecovery({
      attemptCount: 2,
      storeWaitFailures: 1,
      mutateRetainedJobBetweenAttempts: (job) => {
        delete job.metadata.annotations["falcone.gntik.ai/attested-chart-version"];
      }
    });
    assert.notEqual(result.attempts[0].status, 0, "first attempt must fail after successful auth");
    assert.match(combined(result.attempts[0]), /FORWARD_RECOVERY_REQUIRED/);
    assertHistoryRejectedBeforeMutation(
      result.attempts[1],
      "complete-state retained successful Job annotation drift"
    );
    assert.match(result.attempts[1].trace, /^kubectl -n secret-store get jobs\.batch -o json$/m);
  });

  const retainedCurrentDrifts = [
    ["failed retry missing attested chart version", (job) => {
      delete job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"];
    }],
    ["failed retry attested chart version", (job) => {
      job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"] = "0.4.18";
    }],
    ["successful retry missing attested chart version", (job) => {
      delete job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"];
    }, true],
    ["successful retry attested chart version", (job) => {
      job.object.metadata.annotations["falcone.gntik.ai/attested-chart-version"] = "0.4.18";
    }, true],
    ["successful retry succeeded count", (job) => {
      job.object.status.succeeded = 2;
    }, true],
    ["successful retry failed count", (job) => {
      job.object.status.failed = 1;
    }, true],
    ["successful retry condition cardinality", (job) => {
      job.object.status.conditions.pop();
    }, true],
    ["successful retry condition type", (job) => {
      job.object.status.conditions[0].type = "Complete";
    }, true],
    ["successful retry condition status", (job) => {
      job.object.status.conditions[0].status = "False";
    }, true],
    ["successful retry condition reason", (job) => {
      job.object.status.conditions[0].reason = "Completed";
    }, true]
  ];
  for (const [name, mutate, successful] of retainedCurrentDrifts) {
    await t.test(`rejects ${name} drift before mutation`, () => {
      const job = successful ? currentSuccessfulRetry(4) : currentFailedRetry(4);
      mutate(job);
      const result = runPackagedRecovery({
        mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(job)
      });
      assertHistoryRejectedBeforeMutation(result, name);
    });
  }

  await t.test("0.4.18 is not a Job anchor after its pre-create failure", () => {
    assert.equal(targetVersion, "0.4.19", "the current retry line must be 0.4.19");
    const unexpected018 = currentFailedRetry(18);
    unexpected018.object.metadata.name = "openbao-auth-reconcile-r24-018018018018-unexpected";
    unexpected018.ref = `job.batch/${unexpected018.object.metadata.name}`;
    unexpected018.object.metadata.annotations["in-falcone.io/recovery-package-digest"] =
      `sha256:${"18".repeat(32)}`;
    unexpected018.object.metadata.annotations["in-falcone.io/recovery-target-chart"] =
      "in-falcone-0.4.18";
    const result = runPackagedRecovery({
      mutatePrecursor: (fixture) => fixture.authRecovery.staleJobs.push(unexpected018)
    });
    assert.notEqual(result.status, 0);
    assert.match(combined(result), /REVISION24_AUTH_RECONCILE_HISTORY_DRIFT/);
    assert.equal(authCreates(result).length, 0);
    assert.equal(result.mutations, "");
  });

  await t.test("0.4.18 is rejected as a superseded target before mutation", () => {
    const result = runPackagedRecovery({
      targetVersion: "0.4.18",
      packageDigest: `sha256:${"0418".repeat(16)}`
    });
    assert.notEqual(result.status, 0, "0.4.18 unexpectedly remained an accepted target");
    assert.match(combined(result), /JIT_TARGET_CONFIRMATION_REQUIRED/);
    assert.equal(authCreates(result).length, 0);
    assert.equal(result.mutations, "");
  });
});

// bbx-repair-staging-097 | fn-openbao-fresh-routine-dedicated-only | OpenSpec #### Scenario: Chart 0.4.19 preserves fresh-install and routine dedicated-only behavior
test("bbx-repair-staging-097 preserves fresh bootstrap and routine dedicated-only auth", () => {
  const values = runHelm(["show", "values", archive], "public packaged values");
  assert.match(values, /authReconcile:\n(?:.*\n){0,12}\s+allowRecoveryRoot: false\n\s+forceRecoveryRoot: false/);

  const freshInit = runHelm([
    "template", "falcone", packagedChart,
    "--namespace", "in-falcone-staging",
    "--show-only", "charts/openbao/templates/openbao-init-job.yaml"
  ], "fresh bootstrap Job render");
  const freshAuth = runHelm([
    "template", "falcone", packagedChart,
    "--namespace", "in-falcone-staging",
    "--show-only", "charts/openbao/templates/openbao-auth-reconcile-job.yaml"
  ], "fresh auth Job render");
  assert.match(freshInit, /"helm\.sh\/hook": post-install/);
  assert.match(freshInit, /"helm\.sh\/hook-weight": "-4"/);
  assert.match(freshAuth, /"helm\.sh\/hook-weight": "-3"/);

  const routine = renderRoutineJob();
  assert.match(
    routine,
    /login_json="\$\(bao write -format=json auth\/kubernetes\/login \\\n\s+role=openbao-auth-reconcile-role \\\n\s+jwt="\$\(cat \/var\/run\/secrets\/kubernetes\.io\/serviceaccount\/token\)"/
  );
  assert.doesNotMatch(routine, /auth_source=recovery_root result=accepted/);
  assert.doesNotMatch(routine, /FALCONE_(?:PLATFORM|AUTH_RECONCILE)_POLICY_SNAPSHOT/);
  assert.doesNotMatch(routine, /bao policy write (?:platform|auth-reconcile)/);
  assert.doesNotMatch(routine, /mountPath: \/openbao-recovery|secretName: openbao-recovery/);
});

// bbx-repair-staging-098 | fn-revision24-isolation-forward-only-boundary | OpenSpec #### Scenario: Chart 0.4.19 preserves isolation and the forward-only rollback boundary
test("bbx-repair-staging-098 preserves secret isolation and the forward-only boundary", () => {
  const result = runPackagedRecovery();
  assert.equal(result.status, 0, `exact forward-only recovery failed:\n${combined(result)}\n${result.trace}`);
  assertNoSecretReadsOrRollback(result, "exact recovery");
  assert.doesNotMatch(
    result.mutations,
    /kubectl -n external-secrets .*\b(?:patch|delete|apply|replace)\b/,
    "recovery mutated administrator-owned ESO resources"
  );
  assert.doesNotMatch(result.trace, /helm rollback\b.*in-falcone-0\.4\.(?:11|1[2-8])\b/);
  assert.match(result.stdout, /phase-a=applied/);
});
