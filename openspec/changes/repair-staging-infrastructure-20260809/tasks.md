# Tasks

## 1. Historical 0.4.12 baseline

- [x] 1.1 Add failing black-box contracts for ESO/RBAC, OpenBao upgrade behavior,
  FerretDB rollout, staging storage/images, and migration safety.
- [x] 1.2 Preserve external ESO ownership and implement exact TokenRequest/TokenReview
  identities plus controller ServiceAccount preflight.
- [x] 1.3 Split fresh bootstrap from metadata-only auth reconciliation and remove
  persisted hook reviewer credentials.
- [x] 1.4 Add UID 999, zero unavailable/one surge, progress deadline and retained
  ReplicaSet history with OpenShift SCC compatibility.
- [x] 1.5 Add staging-only local-path/fsn1 and all six Falcone-main `d9cd0f6b` digests without
  production/base/HA/OpenShift drift.
- [x] 1.6 Add dry-run-first revision-20 Phase A/Phase B and forward recovery tools,
  structured target/package evidence, semantic owner gates and fail-forward errors.
- [x] 1.7 Add revision-22 failed-apply recovery with exact list/history fingerprint,
  live immutable-storage gates and explicit non-secret preservation overrides.
- [x] 1.8 Prepare chart 0.4.11 with verified APISIX/Prometheus numeric UID/GID values
  for vanilla Kubernetes and preserve OpenShift arbitrary-UID rendering.
- [x] 1.9 Admit only the exact revision-23 failed history and public two-rollout
  named-user evidence, then reuse the two-pass Phase-A fail-forward path with
  0.4.11-bound JIT evidence and no fabricated Phase-A attestation.
- [x] 1.10 Add bbx-repair-staging-057 and admit only the exact partial manual APISIX
  recovery while preserving the sole observability named-user failure.
- [x] 1.11 Make the APISIX numeric pod identity and existing standalone ConfigMap
  mount declarative in staging without creating or adopting the ConfigMap.
- [x] 1.12 Bind the partial precursor through Deployment/ReplicaSet/Pod owner UIDs
  and revision, then fail closed on render or post-upgrade numeric-user drift.
- [x] 1.13 Parse the unique APISIX render structurally without any Kubernetes
  create/apply verb, rejecting duplicates and misplaced security/mount fields.
- [x] 1.14 Update schemas, chart versions, release notes, detailed runbooks and OpenSpec.
- [x] 1.15 Run and record complete source/package validation on the final 0.4.11 diff.
- [x] 1.16 Obtain an independent system-reviewer decision for 0.4.11.
- [x] 1.17 Reproduce the revision-24 global-wait deadlock with the intentionally
  Pending vector workload and add bbx-repair-staging-058.
- [x] 1.18 Add exact legacy ClusterSecretStore handoff and revision-24 fail-forward
  contracts without reading Secret payloads or mutating the external ESO owner.
- [x] 1.19 Prepare chart 0.4.12 with explicit non-vector Phase-A rollout waits,
  package-bound r24 recovery, detailed runbooks and release notes.
- [x] 1.20 Run complete source/package validation and independent review for 0.4.12.

## 2. Chart 0.4.13 auth contract

- [x] 2.1 Add failing black-box coverage mapped exactly to `Auth reconcile
  excludes the default policy from ESO tokens`; require
  `token_no_default_policy=true` and exact token policies
  `functions,gateway,iam,platform` for canary and ESO logins.
- [x] 2.2 Change the official auth-reconcile role normalization and lookup canary
  so `default` or any extra/missing policy fails with stable metadata-only output,
  while login/lookup/revoke remains no-KV and credential-silent.
- [x] 2.3 Prove changed and unchanged reconciliations emit only their matching
  `AUTH_METADATA_CONVERGED` and `AUTH_METADATA_MATCHED` terminal results with
  `canary=passed` and no token or recovery credential material.

## 3. Exact r24 auth-first recovery

- [x] 3.1 Add failing black-box coverage mapped exactly to `Revision-24 recovery
  reconciles OpenBao auth before ESO handoff`, binding the Job render to the
  pulled 0.4.13 package digest and proving `allowRecoveryRoot=true`,
  `activeDeadlineSeconds=300`, metadata-only `generateName` transformation, the
  three full provenance annotations, exact fresh create ref, five-minute wait,
  retained attempt evidence, and zero store/ExternalSecret-owner/Helm mutation
  beforehand.
- [x] 3.2 Implement the package-bound pre-handoff execution of the official
  auth-reconcile Job for only the exact r24/chart-0.4.11 recovery fingerprint:
  preserve every non-metadata field, derive the 12-hex `generateName`, add full
  package/target/source annotations, run `kubectl create -f ... -o name`, and use
  only its validated fresh ref for wait/log; do not read Kubernetes Secret
  resources or payloads and do not print credentials.
- [x] 3.3 Add failing black-box coverage mapped exactly to `Revision-24 recovery
  fails closed when auth reconciliation does not complete`; cover Job creation,
  300-second deadline, five-minute wait timeout, failed completion, metadata, and
  invalid/duplicate/stale create refs, canary failures and stale Job evidence;
  assert `REVISION24_AUTH_RECONCILE_CREATE_FAILED`,
  `REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT`, other stable auth failures and
  fail-forward output, retained failed attempts, and absence of all later
  store/ExternalSecret-owner/Helm mutation.
- [x] 3.4 Add failing black-box coverage mapped exactly to `Revision-24 recovery
  requires exact auth reconciliation evidence`; accept exactly one paired
  changed/converged or unchanged/matched terminal line and reject missing,
  duplicated, cross-paired, malformed, credential-bearing, or drifting logs.
- [x] 3.5 Ensure any retry repeats package/live preflight and creates a new
  generated Job identity, retains all failed attempts and the successful attempt
  through recovery completion, never deletes/reuses/reapplies a prior identity,
  and validates only the exact wait/log ref returned by the new create.

## 4. Preserve post-auth Phase-A gates

- [x] 4.1 After auth proof, preserve the exact UID/resourceVersion CAS store
  handoff and idempotent already-desired retry, then require separate
  `--timeout=10m` Ready waits for the store and all fourteen canonical named
  ExternalSecrets before owner patches or Helm.
- [x] 4.2 Add failing black-box coverage mapped exactly to `External ESO network
  reachability remains an operator prerequisite`; simulate store/ExternalSecret
  non-convergence and prove fail-closed behavior before Helm without creating,
  adopting, or mutating `external-secrets`, its controller, or network policy.
- [x] 4.3 Preserve exactly two non-atomic Phase-A Helm upgrades without global
  wait and with `--timeout 20m`; after each pass preserve the exact non-vector
  workload vector with `rollout status --timeout=10m` per resource, ten-minute
  FerretDB/store readiness waits, stable first/final health-gate failures plus
  `FORWARD_RECOVERY_REQUIRED`, the intentionally Pending vector exclusion, and
  recovery-root disabled on the second pass; retain Phase-B global wait.
- [x] 4.4 Rebind backup/parity evidence, one-use target confirmations, rendered
  package checks, Phase-A attestations, and forward-recovery selection to
  immutable chart 0.4.13 without weakening the r20/r22/r23/r24 fingerprints.

## 5. Release, operations, and validation

- [x] 5.1 Bump the chart and every package-bound public value/schema/fixture
  surface to 0.4.13 while retaining 0.4.12 as immutable failed-recovery history.
- [x] 5.2 Update release notes and operator repair/storage procedures with the
  auth-first order, 300-second Job deadline, five-minute completion wait,
  generated per-attempt identity/provenance annotations, exact create ref,
  retained failure evidence, new-identity retry semantics, stale-Job rejection,
  two exact success lines, no-Secret/no-credential contract, the fourteen
  canonical names, external ESO egress prerequisite, ten-minute
  CAS/readiness/rollout gates, two-pass wait behavior, stable failure codes, and
  forward-only/no-rollback boundary.
- [x] 5.3 Run shell syntax, chart lint/schema/render, all staging repair black-box
  contracts, package/version/digest checks, secret-leak assertions, and
  non-staging/external-owner regression checks on the final 0.4.13 diff.
- [x] 5.4 Run `openspec validate repair-staging-infrastructure-20260809 --strict`
  and obtain independent reviewer approval before any live apply.

## 6. Independently gated live proof

- [ ] 6.1 Complete disposable clean-install and revision-20
  upgrade/failure/forward-recovery proof against immutable chart 0.4.13; do not
  use Helm rollback.
- [ ] 6.2 Obtain separate shared-staging authorization and Phase-B JIT destructive
  confirmation before any PVC mutation.
