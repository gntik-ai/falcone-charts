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

## 2. Historical chart 0.4.13 auth contract

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
  pulled 0.4.15 package digest and proving `allowRecoveryRoot=true`,
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
  immutable chart 0.4.15 without weakening the r20/r22/r23/r24 fingerprints.

## 5. Release, operations, and validation

- [x] 5.1 Bump the chart and every package-bound public surface to 0.4.15 while
  retaining failed-recovery chart 0.4.12, published-but-unapplied 0.4.13, and
  the published partial-recovery 0.4.14 as distinct immutable history.
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
  non-staging/external-owner regression checks on the final 0.4.15 diff.
- [x] 5.4 Run `openspec validate repair-staging-infrastructure-20260809 --strict`.
- [x] 5.5 Make packaged forward recovery invoke its package-local repair
  delegate through Bash so extracted mode 0644 cannot produce exit 126.
- [x] 5.6 Render the exact r24 auth-only preflight with `--is-upgrade`, preserving
  upgrade-only chart validation and the pre-mutation failure boundary.
- [x] 5.7 Run the packaged bbx061-bbx072 regression contracts, shell syntax,
  Helm lint/render, package/version, OpenSpec strict, and diff hygiene on 0.4.15.
- [x] 5.8 Record the historical independent reviewer approval of the 0.4.14 diff.
- [x] 5.9 Add only platform `lookup-self/read` and `revoke-self/update`, mount and
  write that exact policy only in recovery-root auth before role/canary, and keep
  the routine reconciler least-privilege.
- [x] 5.10 Admit only the exact 0.4.14 desired-store self-token 403 precursor,
  preserve its stale Job, avoid a store patch, and create a fresh digest-bound
  0.4.15 Job before readiness waits.
- [x] 5.11 Run focal bbx073-bbx078: 16 tests, 16 pass, 0 fail.
- [x] 5.12 Obtain independent reviewer approval on the 0.4.15 diff before any
  live apply.

## 6. Independently gated live proof

- [ ] 6.1 Complete disposable clean-install and revision-20
  upgrade/failure/forward-recovery proof against immutable chart 0.4.19; do not
  use Helm rollback.
- [ ] 6.2 Obtain separate shared-staging authorization and Phase-B JIT destructive
  confirmation before any PVC mutation.

## 7. ExternalSecret precursor correction in chart 0.4.16

- [x] 7.1 Add black-box contracts bbx079-bbx081 for both exact homogeneous
  ExternalSecret sets, twelve drift cases, and rejection of the published but
  unapplied 0.4.15 target before mutation.
- [x] 7.2 Under only the exact `auth-policy-required` store fingerprint, admit
  either fourteen single-condition Ready=True objects or fourteen exact
  Ready=False/SecretSyncedError/provider-message objects; reject mixtures,
  extra/absent conditions, identity/namespace/cardinality drift and do not
  hardcode ExternalSecret UIDs.
- [x] 7.3 Bind package, evidence, confirmation, auth Job provenance, Phase-A and
  forward recovery to immutable 0.4.16; preserve 0.4.15 as published but
  unapplied, 0.4.14 as the partial auth-Job attempt, and r24/0.4.11 as live.
- [x] 7.4 Update release notes, runbooks, proposal, design, migration and the
  deployment-and-operations delta with homogeneous precursor, pre-mutation
  rejection and no-rollback semantics.
- [x] 7.5 Run focal bbx079-bbx081 (17 tests, 17 pass), shell syntax, strict Helm
  lint, upgrade/auth renders, OpenSpec strict validation and diff hygiene.
- [x] 7.6 Complete the checker-owned historical bbx061-bbx078 target migration
  and final rerun against 0.4.16 while preserving the immutable history.
- [x] 7.7 Obtain independent reviewer approval of the 0.4.16 diff before any
  live apply.
- [x] 7.8 Run the checker-owned full black-box suite on the frozen 0.4.16 diff:
  13 files, 295 tests, 295 pass, 0 fail, with no runner-created workspace delta.

## 8. Forced-root recovery correction in chart 0.4.17

- [x] 8.1 Add bbx082-bbx085 for deterministic forced-root auth, routine
  dedicated-only rendering, exact fresh 0.4.17 provenance/evidence, early 0.4.16
  rejection, and exact retained 0.4.14/0.4.16 Job history.
- [x] 8.2 Add schema/default `forceRecoveryRoot=false`, reject force without
  allow, skip dedicated login only in forced mode, keep allowed fallback mode,
  and leave canonical routine reconciliation without recovery mount or policy
  writes.
- [x] 8.3 Set both recovery flags in isolated r24 render and require structural
  force/root-source/recovery-mount/policy-order evidence plus the exact source
  marker and terminal success before any Store/ExternalSecret/Helm mutation.
- [x] 8.4 Require the two retained failed 0.4.14 and 0.4.16 anchor Jobs with
  exact identity/provenance/hook/status metadata; admit additional retries only
  as unique-identity, exact-provenance/current-digest failed 0.4.17 Jobs while
  leaving RV, timestamps, condition order and messages dynamic; never reuse a
  retained Job.
- [x] 8.5 Bump all active package/evidence/confirmation/provenance surfaces to
  0.4.17 and update detailed release notes, runbooks and OpenSpec while retaining
  0.4.16 attempted, 0.4.15 unapplied, 0.4.14 partial and r24/0.4.11 live history.
- [x] 8.6 Run focal bbx082-bbx085 and bbx061-bbx081, shell syntax, strict Helm
  lint/schema, routine/recovery renders, OpenSpec strict and diff hygiene.
- [x] 8.7 Obtain independent reviewer approval of the frozen 0.4.17 diff before
  any live apply.
- [x] 8.8 Run the checker-owned full black-box suite once against the frozen
  0.4.17 diff: 14 files, 329 tests, 329 pass, 0 fail, with no runner-created
  workspace delta.

## 9. Package-bound policy correction in chart 0.4.18

- [x] 9.1 Add bbx086-bbx090 for byte-equal package policy snapshots, poisoned
  live ConfigMap isolation, policy-before-role/canary order, terminal diagnostic
  retention, routine isolation, exact .14/.16/.17 anchors, 0..N exact .18 retry
  history and early .17 target rejection.
- [x] 9.2 Move platform and auth-reconcile HCL into one helper source per policy;
  render canonical ConfigMaps from those helpers and, only in forced recovery,
  embed the exact bytes, write them to private emptyDirs and verify rendered
  SHA-256 values without mounting the live canonical ConfigMaps.
- [x] 9.3 Require the structural guard to validate package snapshot bytes/hashes,
  emptyDir-only policy mounts, forced source, platform→auth policy→roles→canary
  ordering, and `restartPolicy=Never`/`backoffLimit=0` before create.
- [x] 9.4 Preserve routine dedicated-only rendering without recovery or snapshot
  mounts, embedded HCL, policy writes or authorization expansion.
- [x] 9.5 Add the exact failed 0.4.17 Job to the immutable history anchors, admit
  only 0..N fully attested current 0.4.18 failures, target 0.4.18 throughout and
  reject 0.4.17 before mutation.
- [x] 9.6 Add release notes, runbook and OpenSpec coverage for package/live policy
  provenance, retained diagnostic logs, retry, forward-only recovery and the
  unchanged ESO/PVC/Phase gates.
- [x] 9.7 Run focal bbx086-bbx090 plus historical bbx061-bbx085, shell syntax,
  strict Helm lint/schema, routine/forced/full-upgrade renders, package snapshot
  equality/order, OpenSpec strict and diff hygiene. The checker-owned full
  black-box suite passed once on the frozen diff: 15 files, 347 tests, 347 pass,
  0 fail, with no runner-created workspace delta.
- [x] 9.8 Obtain independent reviewer approval of the frozen 0.4.18 diff before
  publication or live apply. The independent reviewer returned APPROVE with no
  blocking or non-blocking findings.

## 10. Exact semantic canary guard correction in chart 0.4.19

- [x] 10.1 Add failing public black-box coverage mapped exactly to `Revision-24
  package guard binds exactly one semantic canary assignment`; package the real
  chart, run the distributed CLI guard over real Helm output containing both the
  dedicated `login_json` and canary branches, and prove exactly one .19 create
  follows all read-only gates.
- [x] 10.2 Replace the generic canary substring/index with one unique semantic
  match binding `canary_json`, `bao write -format=json auth/kubernetes/login`,
  `role="$role"`, and JWT read from `/canary/token`; use only the captured match
  start for order and never generic `str.index` or `str.rindex`.
- [x] 10.3 Add negative black-box cases mapped exactly to `Revision-24 package
  guard rejects canary identity drift before mutation` for assignment target,
  command, role, JWT source, zero/duplicate cardinality, and prove stable render
  drift with no create/store/owner/Helm mutation.
- [x] 10.4 Preserve and test the exact order mapped to `Revision-24 package guard
  enforces the complete forced-recovery order`: snapshots -> root source ->
  platform policy -> auth policy -> roles -> semantic canary -> lookup-self ->
  revoke-self -> terminal, together with every .18 snapshot/hash/volume/mount/
  policy/marker/one-Job-container/`Never`/backoff-zero structural gate.
- [x] 10.5 Map `Revision-24 pre-create failure distinguishes authorization
  consumption from cluster mutation`; record consumed JIT separately, keep
  `mutation_started=false` through render/guard, set it immediately before
  `kubectl create`, and preserve fail-forward reporting for create ambiguity and
  every later failure.
- [x] 10.6 Retarget package, evidence, confirmations, provenance, Phase-A,
  forward recovery, fixtures, release CI and public documentation to immutable
  0.4.19 with a fresh digest and JIT; preserve exact .14/.16/.17 anchors plus
  0..N fully attested current-.19 terminal attempts, and reject every unexpected
  .18 Job. Historical anchors retain six exact annotations; current Failed or
  Kubernetes-v1.36-Successful attempts require seven exact annotations, unique
  name/UID and the exact permitted terminal shape. Every fresh Job must still
  emit exactly `auth_source=recovery_root result=accepted`; retained Successful
  history never relaxes that log gate. Run the history fence for every Store
  state admitted by exact r24 after Store and fourteen-ExternalSecret precursor
  validation, including `Ready`/`complete` after downstream failure; no admitted
  Store state bypasses it before create.
- [x] 10.7 Prove `Chart 0.4.19 preserves fresh-install and routine dedicated-only
  behavior` across clean install and upgrade renders without new values/schema,
  runtime policy, ServiceAccount, image, storage, network, probe or credential
  changes.
- [x] 10.8 Update release notes and the staging repair/storage procedures to the
  14-part documentation standard, including .18 pre-create history, new JIT,
  authorization-versus-mutation evidence, compatibility and no-rollback limits.
- [x] 10.9 Run shell syntax, strict chart lint/schema, clean-install/routine/
  forced renders, exact real packaged public CLI black-box and negative drift
  suites, complete historical black-box regression, package version/digest
  checks, secret-leak checks, `openspec validate
  repair-staging-infrastructure-20260809 --strict`, and `git diff --check`.
  Maker evidence on 2026-08-13: shell/lint/renders/package/OpenSpec/diff passed;
  checker-owned historical fixtures were retargeted; the real-package bbx091-098
  block passed 24/24; the history/retry bbx096 RED advanced from 12/18, then
  exposed a complete-Store history bypass, and finally passed 19/19 after exact
  six-versus-seven annotation and Failed/Successful terminal gates, faithful
  round-trip fixtures, and an unconditional admitted-r24 history read. The one
  authoritative checker-owned full black-box run on the final frozen diff ran
  unfiltered and without retry on 2026-08-13: 16 files, 390 tests, 390 pass,
  0 fail, 0 skipped/cancelled/todo, exit 0. The runner left branch, HEAD and
  the 30-modified-plus-2-untracked path set byte-identical. Shell syntax,
  strict chart lint, OpenSpec strict and diff hygiene also passed.
- [ ] 10.10 Obtain independent system review of the frozen 0.4.19 diff before
  publication; then perform disposable install/upgrade/failure/forward-recovery,
  P7/P12 health, P13 isolation and cleanup proof before requesting a new shared-
  staging JIT. Do not use production or shared staging as the first test.
