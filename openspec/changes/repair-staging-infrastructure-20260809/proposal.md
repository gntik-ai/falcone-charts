# Change: Repair revision-20/r24 staging infrastructure with chart 0.4.17

## Why

Staging has independent ESO/OpenBao auth, FerretDB init, pgvector storage, and
Helm image-authority defects. Revision 20 also overlaps an administrator-owned
External Secrets Operator. The live revision-24 recovery with chart 0.4.12
proved that handing the store to `eso-system/eso-openbao-auth` before updating
`eso-role` exposes a 403 authorization gap, and that allowing OpenBao's default
policy makes the official reconciliation canary reject otherwise converged
metadata. Chart 0.4.17 must close both gaps without weakening external ownership,
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
failed without advancing r24/0.4.11. Chart 0.4.17 must force root only in that
bounded pre-handoff Job, bind success to an explicit root-source marker, and
admit only the exact retained 0.4.14 plus 0.4.16 Job chain.

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
  rollout failure, targeting immutable chart 0.4.17 and rejecting evidence drift
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
  homogeneous provider-error state, create a fresh digest-bound 0.4.17 Job, and
  leave the already-desired store unpatched. Reject mixtures, condition drift,
  identity drift and the published 0.4.15 target before mutation.
- Add `forceRecoveryRoot=false` to schema and defaults; reject force without
  explicit `allowRecoveryRoot=true`, keep routine reconciliation dedicated-only,
  and set both flags only in isolated r24 recovery.
- Require exact public metadata/status for the two retained failed anchors and
  every additional current-package retry, reject history drift before mutation,
  force the fresh digest-bound 0.4.17 Job to emit
  a recovery-root marker before policy/auth/canary work, and reject 0.4.16 early.
- Publish the correction as immutable chart 0.4.17, update operator/recovery
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

Affected source is limited to `charts/in-falcone/**`, related chart tests and
operator material, this OpenSpec package, and chart release validation. No
Falcone product API/source changes occur. P18/P3/P4 are primary acceptance
lenses; P8/P9/P10/P12/P17 must recover their journeys and P13 remains the
adjacent-tenant negative lens.

Code evidence:

- `charts/in-falcone/charts/openbao/templates/openbao-auth-reconcile-job.yaml::auth-reconcile-script:52-64,143-252`
  currently requests `token_no_default_policy=false` while requiring the four
  policies exactly in the canary lookup.
- `charts/in-falcone/migrations/revision-20-repair.sh::apply_legacy_clustersecretstore_handoff:1055-1208,1490-1509`
  currently performs the r24 store handoff before the first package Helm pass.
- `charts/in-falcone/migrations/revision-20-repair.sh::phase_a_args-and-waits:874-925,1445-1476`
  establishes the two recovery-root/no-root passes and explicit non-vector wait
  vector that 0.4.17 must preserve.
- `charts/in-falcone/Chart.yaml::version:5` identifies 0.4.17 as the new
  immutable target while 0.4.16 remains the published failed Job attempt,
  0.4.15 remains published but unapplied, 0.4.14 remains the published partial
  auth-Job attempt, and live Helm remains revision 24/chart 0.4.11.

## Exclusions and gates

Packaging and source validation do not mutate a cluster. No ESO owner adoption,
Secret value read, PVC deletion, merge, or automatic rollback is part of the
implementation. A shared-staging rollout is a later, separately gated operation;
Phase B still needs an immediate exact PVC name/UID confirmation after all state
gates pass.
All mutation paths are fail-forward; no automatic or explicit Helm rollback is
part of the repair.
