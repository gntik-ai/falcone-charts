# Design: Revision-20/r24 staging infrastructure repair to 0.4.18

## Context

See `proposal.md` for motivation and the deployment-and-operations delta for the
behavioral contract. The live r24 recovery exposed two ordering/metadata defects
in the 0.4.12 baseline: `revision-20-repair.sh` applies the legacy store handoff
before the package Helm pass that can reconcile `eso-role`, while the rendered
auth Job requests `token_no_default_policy=false` but accepts only the four
application policies in its canary lookup. The 0.4.18 correction must use the
published package as authority and must retain the exact r24 fingerprint, CAS
guards, external ESO custody, storage evidence, and two-pass Phase-A behavior.

Code evidence:

- `charts/in-falcone/charts/openbao/templates/openbao-auth-reconcile-job.yaml::auth-reconcile-script:52-64,97-145,162-252`
- `charts/in-falcone/migrations/revision-20-repair.sh::legacy-store-handoff:1055-1208`
- `charts/in-falcone/migrations/revision-20-repair.sh::phase-a-apply:1490-1509`
- `charts/in-falcone/migrations/revision-20-repair.sh::phase-a-args-and-rollouts:874-925,1445-1476`
- `charts/in-falcone/Chart.yaml::version:5`

## Goals / Non-Goals

**Goals:**

- Make exact r24 recovery converge OpenBao Kubernetes auth from the verified
  0.4.18 package before exposing the new ESO identity through the store.
- Prove the Job, exact terminal metadata result, credential-silent behavior,
  store CAS, fourteen ExternalSecrets, and both Helm passes in fail-closed order.
- Preserve forward-only recovery and the separately gated Phase-B storage
  transition.

**Non-Goals:**

- Owning, reconfiguring, or repairing networking for the administrator-managed
  `external-secrets` namespace or controller.
- Reading Kubernetes Secret objects or payloads, emitting credentials, changing
  OpenBao KV payloads/policy documents, rolling Helm back, or deleting storage in
  Phase A.

## Decisions

1. Falcone consumes the existing ESO controller. `external-secrets` namespace
   ownership never transfers. The external controller and OpenBao canary receive
   `create` only on `eso-system/eso-openbao-auth` TokenRequest; only OpenBao may
   create TokenReviews.
2. `openbao-init` renders only on install. The OpenBao server, bootstrap and
   metadata reconciler use distinct Kubernetes identities: the server has only
   TokenReview, bootstrap owns the exact bootstrap/recovery Secret permissions,
   and the reconciler owns only exact TokenRequest plus its least-privilege
   OpenBao metadata role. `openbao-auth-reconcile` renders on install/upgrade,
   optionally uses the retained recovery credential for the one revision-20
   repair, reads sanitized
   auth/role metadata, clears static reviewer JWT/CA configuration, normalizes the
   exact role, verifies, and runs login/lookup-self/revoke-self. `eso-role` sets
   `token_no_default_policy=true`, and token lookup must return exactly
   `functions,gateway,iam,platform`; `default` or any extra policy is failure.
   Canonical values disable recovery-root use immediately afterward.
3. Routine reconciliation never executes KV, policy-document read/write/delete,
   secrets-engine mutation, export, or migration. Policy existence is checked by
   name. Result codes contain metadata only.
4. FerretDB's pinned engine image/UID is one contract. Kubernetes uses UID 999;
   OpenShift restricted mode removes the fixed UID for SCC assignment. Deployment
   uses maxUnavailable 0, maxSurge 1, 600-second deadline and retained history.
5. Only staging chooses local-path/fsn1. It is one replica, node-local, Delete
   reclaim, non-HA. All other profiles remain unchanged.
6. Six digests built from Falcone main
   `d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc` live in staging values:
   control-plane, executor, web, workflow, function runtime, and MCP runtime.
   Helm, never imperative patches, is authority.
7. Migration is split: Phase A retains the immutable hcloud-volumes value while
   applying non-destructive repairs; Phase B admits only the exact initial
   Pending StatefulSet Pod, scales that StatefulSet to zero, waits boundedly,
   then rechecks exact PVC UID/Pending/no-volume/no-PV/no-Pod/no-data evidence,
   requires JIT confirmation, deletes that PVC only, and immediately applies
   canonical local-path values.
8. Apply requires separate fresh backup and parity attestations bound to exact
   source target, repair chart and published package digest. Phase B additionally
   requires a fresh Phase-A attestation bound to the live revision and final
   no-root health. Target confirmation includes current revision, chart and
   package digest; PVC confirmation remains a separate exact name/UID gate. Real
   apply pulls the 0.4.18 OCI artifact, verifies its registry-reported digest, and
   uses the staging values extracted from that artifact.
9. Revision-20 Phase A prevalidates the exact fourteen Falcone-owned
   `ExternalSecret` declarations before apply. It accepts only the all-absent
   Helm owner tuple or the exact release tuple from an idempotent retry, compares
   canonical specs after ESO CRD defaults, and adopts absent tuples with atomic
   metadata-only UID/resourceVersion-guarded patches. It never reads generated
   Secrets, uses broad `--take-ownership`, or adopts an external ESO object.
10. A secret-suppressed semantic diff protects the sanitized 21-resource external
   ESO inventory, including cluster-scoped objects. Exact owner metadata is
   captured before and compared after each repaired-chart pass. No release
   manifest or Secret payload is read.
11. Revision 22 is admitted only as the exact failed chart-0.4.8 immutable-field
    incident. The repair validates four bound standalone PVCs, two SeaweedFS
    claim-template contracts and their historical bound child PVCs from public
    Kubernetes metadata, then passes their exact non-secret storage values to
    every Helm operation. It does not use `--reuse-values`, patch storage objects,
    read volume contents, or fabricate a successful Phase-A attestation.
12. Vanilla Kubernetes assigns the verified numeric image identities to the two
    containers whose images declare named users: APISIX UID/GID 636 and
    Prometheus UID/GID 65534. Both retain `runAsNonRoot`. The OpenShift
    restricted wrapper strips both fields, preserving SCC-assigned arbitrary
    identities without weakening its non-root policy.
13. Revision 23 is admitted only as the exact failed chart-0.4.9 canceled upgrade
    whose public Deployment/Pod state proves two stalled named-user rollouts and
    preserved prior availability. The gate binds labels, ReplicaSet ownership,
    images, generations, replica counts and full kubelet error signatures without
    reading logs, Secrets or Helm manifests. Forward recovery delegates to the
    existing two-pass Phase-A path and requires fresh 0.4.18/package-bound backup
    and parity evidence, but no fabricated Phase-A attestation.
14. Chart 0.4.10 remains an immutable published but unapplied artifact. A later
    `kubectl-patch` left APISIX 3/3 Ready with pod UID 636 and the existing
    standalone ConfigMap mounted, while Prometheus retained the sole named-user
    failure. Chart 0.4.11 admits only that exact second precursor, including
    the Deployment UID/generation → ReplicaSet UID/revision → Pod UID owner
    chain, runtime UID/GID, mount, ConfigMap SHA-256 and global error
    cardinality. Its staging profile makes the mount and numeric pod identity
    declarative but neither creates nor adopts the external ConfigMap. The
    rendered target is checked before mutation and both APISIX and Prometheus
    numeric identities are checked live after each upgrade pass.
15. Revision 24 is admitted only as the exact failed chart-0.4.11 global-wait
    attempt. Phase A leaves the proven-empty vector workload Pending for the JIT
    Phase B. Each of its two Helm upgrades therefore omits global wait, retains
    the script's 20-minute Helm timeout, and is followed by an explicit
    `rollout status --timeout=10m` for each managed non-vector workload and
    OpenBao. Each following health gate also waits at most ten minutes for
    FerretDB `Available` and the store `Ready`. Phase B keeps global wait after
    claim recreation.
16. Exact r24 recovery inserts an auth-first gate before the existing store,
    ExternalSecret-owner, and Helm mutation sequence. It renders the official
    auth-reconcile Job from the digest-verified 0.4.18 package with
    `allowRecoveryRoot=true` and `activeDeadlineSeconds=300`, then validates the
    package-bound object before creating an attempt. The attempt is a copy whose
    only changes are Job metadata: remove `metadata.name`, set
    `metadata.generateName` to
    `openbao-auth-reconcile-r24-<digest12>-` where `<digest12>` is the first
    twelve lowercase hex characters after `sha256:`, and add
    `in-falcone.io/recovery-package-digest=<full digest>`,
    `in-falcone.io/recovery-target-chart=in-falcone-0.4.18`, and
    `in-falcone.io/recovery-source-revision=24`. Spec, pod template, labels,
    namespace, hook annotations and all other fields remain identical to the
    validated official Job.

    The CLI uses `kubectl create -f <attempt> -o name`, requires exactly one fresh
    `job.batch/openbao-auth-reconcile-r24-<digest12>-<dns-suffix>` ref, and uses
    that exact ref for both `wait --for=condition=Complete --timeout=5m` and
    `logs`. It then accepts exactly one terminal pair:
    `changed`/`AUTH_METADATA_CONVERGED` or
    `unchanged`/`AUTH_METADATA_MATCHED`, both with `canary=passed`. Job or log
    drift stops all subsequent mutation. Every failed attempt remains in place as
    evidence; the successful attempt remains at least through completion of r24
    recovery. Retry reruns all live/package gates and creates a new generated
    identity from the verified Job. It never deletes, reuses, patches or reapplies
    a prior attempt, and stale Jobs never satisfy completion or log evidence.
    Fixed-name `kubectl apply` was rejected because an immutable retained Job
    cannot represent a fresh execution. The CLI does not read Secret resources or
    payloads, and neither layer emits credentials.
17. After auth convergence, the revision-20 store hook is handed off only from
    one exact legacy form. The desired store is parsed from the same verified
    package render; apply uses UID and resourceVersion tests, removes only the
    two hook annotations, replaces only the public provider spec, and waits for
    the store plus the exact canonical fourteen ExternalSecrets, using an
    individual ten-minute Ready wait for the store and each declaration. Exact
    desired-state retry remains idempotent. Only then may ExternalSecret owner
    metadata and the first of two non-global-wait Helm passes mutate. The second
    pass explicitly renders recovery-root disabled.
18. Network/egress that lets the administrator-owned ESO controller reach
    OpenBao is an external operational prerequisite. Store or fourteen-secret
    readiness failure stops before ExternalSecret adoption and Helm. The repair
    neither creates nor adopts `external-secrets`, changes its network policy, nor
    expands Falcone's ownership boundary.
19. Chart 0.4.12 remains an immutable failed-recovery artifact; chart 0.4.13
    remains an immutable published-but-unapplied artifact because its packaged
    delegate was not executable and its auth-only preflight lacked Helm upgrade
    context. Chart 0.4.14 fixed those package execution defects and remains the
    immutable published partial recovery attempt whose Job ran while live Helm
    stayed failed revision 24/chart 0.4.11. Chart 0.4.15 added the least-privilege
    platform self-token repair but was published without being applied because
    its ExternalSecret precursor gate was incomplete. Chart 0.4.16 fixed that
    gate but its attempted Job kept a successful dedicated credential effective,
    skipped the root-only platform policy write, and failed. The correction is a
    new immutable chart 0.4.18; evidence, confirmations, release material,
    recovery paths, and operator procedures all bind 0.4.18 rather than
    rewriting historical packages.
20. The public forward-recovery wrapper invokes its package-local repair
    delegate as `bash <delegate>` so correctness does not depend on executable
    mode retained by the Helm archive. The r24 auth-only `helm template` includes
    `--is-upgrade`, matching the subsequent upgrade and satisfying the chart's
    upgrade-only validation without weakening that validation.
21. The platform policy gains only `auth/token/lookup-self` read and
    `auth/token/revoke-self` update. Fresh init already writes the projected
    platform policy before `eso-role`. Recovery-root auth reconciliation mounts
    that ConfigMap read-only and writes it before role mutation/validation and
    canary login; `PLATFORM_POLICY_BOOTSTRAP_FAILED` stops the sequence. The
    dedicated reconciler gains no policy-write, mount, Secret, or KV authority.
22. The additional r24 precursor is one exact 0.4.14 partial state: desired store
    spec, exact labels/Helm owner/UID, no hooks, exact reconcile-request, single
    lookup-self 403 `ValidationFailed` condition, and fourteen canonical unique
    ExternalSecrets. Under that store state the ES set must be homogeneous: all
    objects have exactly one Ready=True condition, or all have exactly one
    Ready=False/SecretSyncedError/`could not get secret data from provider`
    condition. Mixed states, extra or absent conditions, identity/cardinality/
    namespace drift, and reason/message drift fail before mutation; ES UIDs are
    not hardcoded. ResourceVersion is captured dynamically. Apply does not patch
    that desired store; it creates a fresh 0.4.18 digest-bound Job before
    readiness waits. The retained 0.4.14 Job is never reused or deleted.
23. The early Phase-A confirmation gate binds the exact current revision/chart
    to immutable target 0.4.18 and a digest-shaped suffix before attestations are
    loaded. A 0.4.17 confirmation therefore fails with
    `JIT_TARGET_CONFIRMATION_REQUIRED` before any mutation rather than being
    misclassified as evidence drift.
24. `forceRecoveryRoot` defaults to false and is valid only with
    `allowRecoveryRoot=true`. Routine rendering remains dedicated-only, without
    recovery Secret mount or policy-write commands. The package-bound r24 render
    sets both flags; it skips dedicated login deterministically, loads the root
    token without printing it, emits the exact root-source marker, writes the
    platform policy, and only then reconciles roles and runs the canary. The
    structural package guard and log evidence gate both require that contract.
25. For the exact stable provider-error precursor, a public list requires two
    exact retained r24 auth anchors. The 0.4.14, 0.4.16 and 0.4.17 objects must match
    their exact names, UIDs, package/target/source and hook annotations,
    `failed=1`, and exactly two uniquely typed `FailureTarget` and `Failed`
    conditions, both `True/BackoffLimitExceeded`, in either order.
    Resource versions and timestamps remain dynamic. Extra prefix Jobs are
    allowed only as fully attested failed attempts for the current 0.4.18
    digest/target: exact generated-name prefix and valid suffix, unique UUID UID,
    exact provenance/hooks, and the same exact failed state. Names and UIDs are
    globally unique. Drift fails before the fresh 0.4.18 create; no retained
    object is reused, logged or mutated.
26. The failed 0.4.17 Job proves that rendering a new Job does not make a named
    ConfigMap mount package-bound: Kubernetes resolves the mount from the live
    0.4.11 object. Platform and auth-reconcile HCL therefore have one helper
    source. Canonical ConfigMaps include those helpers, while only forced r24
    recovery embeds the same bytes into its script, writes them to `emptyDir`,
    verifies package-rendered SHA-256 values, and mounts no canonical policy
    ConfigMap. An init ConfigMap or a differently named transient Kubernetes
    object was rejected because it would introduce another mutation/ownership
    surface before the guarded Job.
27. Forced recovery uses `restartPolicy: Never` and `backoffLimit: 0` so a
    terminal credential-silent container log remains attached to one failed Pod.
    Routine reconciliation retains `OnFailure`/backoff two and remains
    dedicated-only. Recovery retries are explicit, rerun all gates, and create a
    new digest-bound identity; Kubernetes automatic retry cannot replace the
    diagnostic attempt.
28. The r24 history fence adds the exact failed 0.4.17 object as the third
    immutable anchor. Zero or more additional objects are admitted only as
    exact current-digest/current-target 0.4.18 failures with unique generated
    names and UUID UIDs. This preserves fail-forward retries without treating
    0.4.17 as a current package or rollback target.

## Failure and rollback

For exact r24, auth Job render, metadata transformation, create, returned-ref,
completion, log, metadata, or canary failure stops before the store handoff,
ExternalSecret owner mutation, and Helm. A create command failure emits
`REVISION24_AUTH_RECONCILE_CREATE_FAILED`; empty, duplicate or invalid create
output emits `REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT`. Neither failure path
deletes an attempt. Other auth mismatches stop before ESO CR refresh and never
fall back to payload operations. A matching role plus denial reports
`ROLE_MATCHES_AUTH_STILL_DENIED`. Ferret failure leaves old Ready endpoints.
Unexpected PVC binding/data invalidates Phase B. Before Phase A, revision 20 is
untouched. Once any mutation starts, every failure emits a forward-recovery
instruction; neither apply tool uses atomic upgrade or rollback, and none of
0.4.11 through 0.4.16 is a rollback target. After PVC
deletion, revision-20 restoration is storage-incompatible. Data-bearing storage
changes require a separate backup/restore and isolation-parity design.

## Migration Plan

1. Publish immutable 0.4.18 and bind fresh backup/parity evidence plus the exact
   r24→0.4.18 confirmation to its registry digest.
2. Revalidate the exact r20/r22/r23/r24 history, storage, workload, identity,
   owner, and external ESO evidence without reading Secrets.
3. From the validated package-derived recovery-root Job, create a new
   digest-prefixed/annotated generated identity with a 300-second active deadline.
   Accept only the exact fresh resource ref returned by `kubectl create -o name`
   and use it for the five-minute wait and log. On failure retain the attempt,
   emit its stable `REVISION24_AUTH_RECONCILE_*` code plus
   `FORWARD_RECOVERY_REQUIRED`, and stop before store, ExternalSecret-owner, or
   Helm mutation. Retry repeats preflight and creates another identity; no prior
   attempt is deleted, reused, reapplied or accepted as evidence.
4. CAS-handoff the exact store, wait at most ten minutes separately for it and
   each canonical ExternalSecret, and fail forward before Helm if external ESO
   egress does not permit convergence.
5. Perform both 20-minute non-atomic Phase-A upgrades without global wait, use a
   ten-minute timeout per resource in the explicit non-vector rollout vector,
   apply the ten-minute FerretDB/store health waits, and run the second pass with
   recovery-root disabled. Stop with `PHASE_A_HEALTH_GATE_FAILED` or
   `FINAL_HEALTH_GATE_FAILED` plus `FORWARD_RECOVERY_REQUIRED`; never roll back.
6. Keep Phase B separately JIT-gated. Any failure after mutation is recovered by
   forward-applying 0.4.18; no Helm rollback is allowed.

## Verification

Strict lint/schema, managed/external ESO renders, upgrade render, black-box
contracts mapped to the exact Scenario headers, non-staging storage
non-regression, six digest assertions, shell syntax, OpenSpec strict validation,
and 0.4.18 package checksum validation run on the source commit. Operator and
release material must state the auth-first order, external egress prerequisite,
credential-silent checks, and forward-only rollback boundary. Independent
disposable live verification occurs after maker handoff.
