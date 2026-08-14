# Change: Repair revision-20/r24 staging infrastructure with chart 0.4.19

## Why

Staging has independent ESO/OpenBao auth, FerretDB init, pgvector storage, and
Helm image-authority defects. Revision 20 also overlaps an administrator-owned
External Secrets Operator. The live revision-24 recovery with chart 0.4.12
proved that handing the store to `eso-system/eso-openbao-auth` before updating
`eso-role` exposes a 403 authorization gap, and that allowing OpenBao's default
policy makes the official reconciliation canary reject otherwise converged
metadata. Chart 0.4.19 must retain the corrections for those gaps and the
package/live policy-source mismatch without weakening external ownership,
credential secrecy, storage gates, or the fail-forward boundary.

The immutable 0.4.13 package was published but not applied. Package-level
verification found that Helm extracts the delegated repair CLI without executable
mode while the forward wrapper invokes it directly, and that the r24 auth-only
render omits Helm upgrade context and trips the upgrade-only validation gate.
Chart 0.4.14 corrects only those packaged recovery defects.

The 0.4.14 package was then published and its recovery-root Job partially ran,
but Helm remained failed revision 24/chart 0.4.11. The desired store failed its
OpenBao self-token validation with an exact `lookup-self` 403 because the
`platform` policy lacked the two token self-service capabilities used by ESO.
Chart 0.4.15 installed only those least-privilege capabilities and admitted the
exact metadata-visible partial precursor.

Chart 0.4.15 was published but was not applied. Its pre-mutation gate admitted
the transient all-Ready ExternalSecret window but rejected the observed stable
state where all fourteen canonical ExternalSecrets expose the same exact
`SecretSyncedError`. Chart 0.4.16 admitted only either complete homogeneous
set under the already exact self-token-policy store fingerprint.

Chart 0.4.16 was published and attempted, but the isolated Job used a successful
dedicated login and therefore skipped the recovery-root-only platform write. It
failed without advancing r24/0.4.11. Chart 0.4.17 forced root, but mounted the
old canonical ConfigMaps from live 0.4.11, so its policy writes could not install
the package self-service paths and lookup-self remained 403. Chart 0.4.18 used
package-bound snapshots only in that bounded pre-handoff Job, bound success to
an explicit root-source marker, and preserved the exact retained 0.4.14,
0.4.16, and 0.4.17 Job chain.

Chart 0.4.18 was published, but its exact real packaged Helm render failed the
public CLI's structural guard before `kubectl create`. The rendered Job itself
is valid: it has one Job and reconciler container, byte- and hash-bound HCL
snapshots in `emptyDir`, no canonical ConfigMap mount, recovery-root input,
complete policy content, `restartPolicy: Never`, `backoffLimit: 0`, and every
required marker. The guard nevertheless assigns its canary position from the
generic text `bao write -format=json auth/kubernetes/login`; the earlier
dedicated `login_json` branch matches first, before platform/auth policy and role
writes. The actual canary assignment is the later `canary_json` command bound to
`role="$role"` and the JWT read from `/canary/token`. It therefore fails
`REVISION24_AUTH_RECONCILE_RENDER_DRIFT` before create. No 0.4.18 Job or other
cluster mutation occurred, Helm remains r24/in-falcone-0.4.11, and the consumed
0.4.18 JIT authorization cannot authorize 0.4.19. The new immutable package must
fix only that guard/proof boundary and carry fresh evidence plus a fresh JIT.

## What Changes

- Preserve externally managed ESO mode and render/mutate nothing owned by its
  Helm release; grant exact TokenRequest/TokenReview authority only.
- Make OpenBao full bootstrap fresh-install-only and routine upgrade reconciliation
  idempotent, auth-metadata-only, local-reviewer based, and no-KV.
- Make `eso-role` issue ESO and canary tokens without the OpenBao `default`
  policy and with exactly `functions,gateway,iam,platform`.
- Run FerretDB's engine gate as UID 999 and use zero-unavailable rolling update
  with retained old Ready ReplicaSets.
- Select local-path plus fsn1 only in staging and pin the six immutable
  application/runtime digests built from Falcone main `d9cd0f6b` there.
- Assign verified numeric UID/GID values to the APISIX and Prometheus named-user
  images on vanilla Kubernetes while preserving OpenShift arbitrary-UID behavior.
- Add dry-run-first revision-20 preflight, two-phase migration, forward recovery,
  structured short-lived evidence, semantic external-owner protection, detailed
  operations/security/storage documentation, and black-box contracts.
- Extend fail-forward recovery to the exact revision-23 chart-0.4.9 named-user
  rollout failure, targeting immutable chart 0.4.19 and rejecting evidence drift
  before mutation.
- Admit the one exact observed partial manual recovery in which APISIX is 3/3
  Ready through an exact Deployment→ReplicaSet→Pod UID/revision owner chain as
  runtime UID/GID 636 with the existing standalone ConfigMap mounted, while
  observability retains the sole named-user failure; make that mount and numeric
  identity declarative in staging without adopting the ConfigMap, and prove
  both APISIX and Prometheus numeric convergence after each upgrade pass.
- Resume only the exact revision-24/chart-0.4.11 timeout by running the official,
  package-bound auth-reconcile Job with recovery-root allowed and proving its
  `activeDeadlineSeconds=300`, waiting at most five minutes for `Complete`, and
  proving its exact successful terminal log before any ClusterSecretStore,
  ExternalSecret, or Helm mutation. Each attempt creates a new Job identity from
  `openbao-auth-reconcile-r24-<digest12>-`, annotated with the full package
  digest, target chart and source revision; only the exact resource ref returned
  by that create may be waited or logged. Retain failed attempts as evidence and
  ignore every stale Job; retry repeats package/live preflight and creates a new
  identity rather than deleting, reusing or reapplying a prior Job. Then preserve
  the exact CAS store handoff, the named fourteen-Ready gate, two 20-minute
  non-global-wait Phase-A upgrades, ten-minute-per-resource rollout/readiness
  gates, and recovery-root-disabled second pass while retaining Phase-B JIT and
  global wait.
- Treat network/egress from the administrator-owned ESO controller to OpenBao as
  an external prerequisite: fail closed before Helm when the store and fourteen
  ExternalSecrets cannot converge, without taking ownership of `external-secrets`.
- Invoke the packaged repair delegate through Bash and render the r24 auth-only
  preflight with Helm's explicit upgrade context before any mutation.
- Add only `auth/token/lookup-self` read and `auth/token/revoke-self` update to
  the platform policy; install it on fresh bootstrap and only from the explicitly
  recovery-root auth branch before the no-default role/canary validation.
- Admit only the exact desired-store/lookup-self-403 precursor with either all
  fourteen ExternalSecrets each exactly Ready or all fourteen each in the exact
  homogeneous provider-error state, create a fresh digest-bound 0.4.19 Job, and
  leave the already-desired store unpatched. Reject mixtures, condition drift,
  identity drift and the published 0.4.15 target before mutation.
- Add `forceRecoveryRoot=false` to schema and defaults; reject force without
  explicit `allowRecoveryRoot=true`, keep routine reconciliation dedicated-only,
  and set both flags only in isolated r24 recovery.
- Require exact public metadata/status for the three retained failed anchors
  with six exact annotations and every additional current-package retry with
  seven exact annotations. Admit a current retry only in its exact Failed or
  Kubernetes v1.36 Successful terminal, reject identity/provenance/status drift
  before mutation, and force every fresh digest-bound 0.4.19 Job to emit exactly
  `auth_source=recovery_root result=accepted` before policy/auth/canary work; no
  retained Successful attempt may relax that fresh proof.
- Render canonical platform/auth-reconcile ConfigMaps and forced snapshots from
  one HCL helper source; use writable package snapshots only for forced recovery,
  forbid canonical ConfigMap mounts there, and retain one terminal diagnostic
  attempt with `Never`/backoff zero.
- Replace the generic login substring/order check with exactly one semantic
  canary assignment that binds `canary_json`,
  `bao write -format=json auth/kubernetes/login`, `role="$role"`, and a JWT read
  from `/canary/token`; use that match object's captured start index for order
  proof and never `str.index`/`str.rindex` on a generic login substring.
- Preserve and prove the complete order
  snapshots -> recovery-root source -> platform policy -> auth-reconcile policy
  -> all role reconciliation -> semantic canary -> lookup-self -> revoke-self
  -> terminal result. Identity, duplicate, omission, or order drift fails before
  `kubectl create`.
- Add a public black-box execution of the exact real packaged render through the
  distributed CLI guard, including the earlier dedicated-login branch, plus
  negative semantic-canary identity/order and existing structural drift cases;
  a reduced synthetic fixture alone is insufficient evidence.
- Record JIT authorization consumption separately from cluster mutation and set
  `mutation_started=true` immediately before `kubectl create`; render or guard
  failure before create must not claim cluster mutation, while create ambiguity
  and every later failure remain fail-forward.
- Preserve only exact retained .14/.16/.17 Job anchors plus zero or more fully
  attested terminal attempts for the current 0.4.19 digest. Current attempts may
  be only exact Failed (`Failed`+`FailureTarget`) or exact Kubernetes v1.36
  Successful (`Complete`+`SuccessCriteriaMet`) objects, with unique names/UIDs.
  Run that fence after Store and fourteen-ExternalSecret validation for every
  Store state admitted by exact r24 recovery, including `Ready`/`complete` after
  a Successful Job and downstream failure; no admitted Store state may bypass
  it before create.
  Because no .18 Job was created, any unexpected .18 Job fails closed and .18 is
  neither a Job anchor nor a rollback target.
- Publish the correction as immutable chart 0.4.19, update operator/recovery
  documentation, and keep recovery forward-only with no Helm rollback.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deployment-and-operations`: Extends the existing deployment and operations
  capability with the staging repair, external ESO custody, OpenBao auth
  convergence, bounded fail-closed sequencing, and forward-only migration
  contract. The delta uses ADDED requirements because these requirement names
  have no archived baseline to replace.

## Impact

Affected source is limited to the authoritative `gntik-ai/falcone-charts`
repository at `charts/in-falcone/**`, related public black-box tests, operator
material, this OpenSpec package, and chart release validation. No Falcone
product API/source changes occur. P18/P3/P4 are primary acceptance lenses; P7
owns the recovered workspace capability, P12 is the adjacent workload identity,
P13 remains the cross-tenant negative lens, and P17 must be able to execute the
package-only procedure without source archaeology.

Code evidence:

- `charts/in-falcone/charts/openbao/templates/openbao-auth-reconcile-job.yaml::auth-reconcile-script:116-284`
  contains the earlier dedicated login plus the later exact canary assignment,
  package policy/role order, lookup-self, revoke-self, and terminal result that
  the 0.4.19 guard must identify without changing runtime behavior.
- `charts/in-falcone/migrations/revision-20-repair.sh::run_revision24_pre_handoff_auth_reconcile`
  currently sets `canary_marker` to the generic login command and orders with
  `script.index(canary_marker)`. In the exact public render the dedicated login
  is logical line 85/index 2940, while the semantic `canary_json` assignment is
  logical line 210/index 10769.
- `charts/in-falcone/migrations/revision-20-repair.sh::apply_legacy_clustersecretstore_handoff:1055-1208,1490-1509`
  currently performs the r24 store handoff before the first package Helm pass.
- `charts/in-falcone/migrations/revision-20-repair.sh::phase_a_args-and-waits:874-925,1445-1476`
  establishes the two recovery-root/no-root passes and explicit non-vector wait
  vector that 0.4.19 must preserve.
- `charts/in-falcone/Chart.yaml::version:5` currently identifies published
  0.4.18. Implementation must publish a new immutable 0.4.19 rather than mutate
  it; 0.4.16 and 0.4.17 remain failed Job attempts, 0.4.14 remains the published
  partial auth-Job attempt, and live Helm remains revision 24/chart 0.4.11.

## Exclusions and gates

Packaging and source validation do not mutate a cluster. No ESO owner adoption,
Secret value read, PVC deletion, merge, or automatic rollback is part of the
implementation. A shared-staging rollout is a later, separately gated operation;
Phase B still needs an immediate exact PVC name/UID confirmation after all state
gates pass.
All mutation paths are fail-forward; no automatic or explicit Helm rollback is
part of the repair.
The published 0.4.18 package and its consumed JIT are historical evidence only:
they authorize no 0.4.19 action and must not be represented as a retained Job or
cluster-mutation anchor.
