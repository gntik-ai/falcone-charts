# Design: Revision-20/r24 staging infrastructure repair to 0.4.19

## Context

See `proposal.md` for motivation and the deployment-and-operations delta for the
behavioral contract. The analyst proved that `gntik-ai/falcone-charts`, not the
Falcone application repository, is the permanent install/upgrade source of
truth. This design therefore starts from the isolated authoritative worktree on
`fix/staging-exact-canary-guard-0.4.19` and does not invent another repository or
application integration.

The published 0.4.18 package produces a valid exact real Helm Job, but its public
repair CLI rejects that Job before create. In
`run_revision24_pre_handoff_auth_reconcile`, `canary_marker` is only
`bao write -format=json auth/kubernetes/login`, and
`script.index(canary_marker)` resolves the earlier dedicated `login_json` branch
(logical line 85/index 2940), before the platform/auth policy and first role.
The actual forced-recovery canary is the later `canary_json` assignment (logical
line 210/index 10769) whose login uses `role="$role"` and the JWT read from
`/canary/token`. The guard consequently emits
`REVISION24_AUTH_RECONCILE_RENDER_DRIFT` before `kubectl create` even though the
one Job/container, snapshots, hashes, `emptyDir` volumes, recovery mount, policy
content, `Never`/backoff-zero settings and markers are correct.

No 0.4.18 Job or other cluster mutation occurred. Live Helm remains failed
revision 24/chart 0.4.11, exact retained Job anchors remain only .14/.16/.17,
and the consumed 0.4.18 JIT cannot authorize another target. The 0.4.19
correction must use a newly published package and digest, fresh evidence and a
new JIT while retaining the exact r24 fingerprint, CAS guards, external ESO
custody, storage evidence, and two-pass Phase-A behavior.

Code evidence:

- `charts/in-falcone/charts/openbao/templates/openbao-auth-reconcile-job.yaml::auth-reconcile-script:116-284`
- `charts/in-falcone/migrations/revision-20-repair.sh::run_revision24_pre_handoff_auth_reconcile:1305-1490`
- `charts/in-falcone/migrations/revision-20-repair.sh::legacy-store-handoff:1055-1208`
- `charts/in-falcone/migrations/revision-20-repair.sh::phase-a-apply:1490-1509`
- `charts/in-falcone/migrations/revision-20-repair.sh::phase-a-args-and-rollouts:874-925,1445-1476`
- `charts/in-falcone/Chart.yaml::version:5`

## Goals / Non-Goals

**Goals:**

- Make the verified 0.4.19 public package accept exactly its semantic canary and
  make exact r24 recovery converge OpenBao Kubernetes auth before exposing the
  new ESO identity through the store.
- Prove the Job, exact terminal metadata result, credential-silent behavior,
  store CAS, fourteen ExternalSecrets, and both Helm passes in fail-closed order.
- Preserve forward-only recovery and the separately gated Phase-B storage
  transition.
- Preserve unchanged fresh-install and routine dedicated-only behavior; this is
  a packaged recovery guard correction, not a runtime auth-policy redesign.

**Non-Goals:**

- Owning, reconfiguring, or repairing networking for the administrator-managed
  `external-secrets` namespace or controller.
- Reading Kubernetes Secret objects or payloads, emitting credentials, changing
  OpenBao KV payloads/policy documents, rolling Helm back, or deleting storage in
  Phase A.
- Reusing the consumed 0.4.18 JIT, representing the pre-create .18 failure as a
  Job/cluster mutation, or accepting .18 as a rollback target.

## Persona acceptance

| Persona | 0.4.19 acceptance lens |
|---|---|
| P18 installer/release engineer | Publishes and verifies one immutable OCI 0.4.19 package, uses a fresh digest-bound JIT, and sees pre-create proof failures distinguished from cluster mutation. |
| P3 operator/SRE | Can diagnose semantic render drift from a stable code, preserve .14/.16/.17 evidence, and resume only by fail-forwarding with a fresh .19 attempt. |
| P4 security/compliance | Sees no Secret payload read, credential output, policy broadening, owner transfer, or false mutation claim; the recovery-root path remains one-use and auditable. |
| P7 workspace capability owner | Receives the unchanged document/vector capability recovery sequence with no premature healthy claim. |
| P12 service workload | Receives the same exact four-policy, no-default credential and bounded TokenRequest behavior. |
| P13 adjacent tenant/workload | Cannot influence package/history identity or gain cross-tenant metadata, Secret, policy, store, or workload access; every drift fails closed. |
| P17 documentation-only newcomer | Can identify package, evidence, JIT, pre-create failure, retry, forward recovery, and rollback boundaries from published material alone. |

## Permanent source of truth and compatibility boundary

One repository is authoritative and will receive one bounded branch/PR:
`gntik-ai/falcone-charts`, rooted here at `charts/in-falcone`. The implementation
surface is the packaged repair CLI and its public contract tests, plus the chart
version/release/docs surfaces required to publish 0.4.19. `Chart.yaml`, the OCI
release workflow, staging values/schema, templates, migration scripts, package
fixtures, release notes and runbook are evaluated explicitly; only files proven
necessary by the implementation may change. No external repository, clone, or
Falcone application PR is planned.

There is no public API, SDK, gateway, adapter, datastore schema, code generation,
credential format, or application protocol change. The existing embedded Python
structural guard inside the public repair CLI remains the compatibility
abstraction. It must identify the semantic canary without changing the rendered
OpenBao Job or hiding the difference between the earlier dedicated login and the
later canary login. Values and schema retain `forceRecoveryRoot=false` and
`allowRecoveryRoot=false` defaults; no new feature flag is warranted.

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
   apply pulls the 0.4.19 OCI artifact, verifies its registry-reported digest, and
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
    existing two-pass Phase-A path and requires fresh 0.4.19/package-bound backup
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
    auth-reconcile Job from the digest-verified 0.4.19 package with
    `allowRecoveryRoot=true` and `activeDeadlineSeconds=300`, then validates the
    package-bound object before creating an attempt. The attempt is a copy whose
    only changes are Job metadata: remove `metadata.name`, set
    `metadata.generateName` to
    `openbao-auth-reconcile-r24-<digest12>-` where `<digest12>` is the first
    twelve lowercase hex characters after `sha256:`, and add
    `in-falcone.io/recovery-package-digest=<full digest>`,
    `in-falcone.io/recovery-target-chart=in-falcone-0.4.19`, and
    `in-falcone.io/recovery-source-revision=24`. Spec, pod template, labels,
    namespace, hook annotations and all other fields remain identical to the
    validated official Job.

    The CLI uses `kubectl create -f <attempt> -o name`, requires exactly one fresh
    `job.batch/openbao-auth-reconcile-r24-<digest12>-<dns-suffix>` ref, and uses
    that exact ref for both `wait --for=condition=Complete --timeout=5m` and
    `logs`. That fresh log must contain exactly one
    `auth_source=recovery_root result=accepted` marker on every attempt; retained
    history, including a Successful current-package Job, never relaxes or
    substitutes the marker. It then accepts exactly one terminal pair:
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
    skipped the root-only platform policy write, and failed. Chart 0.4.17 then
    forced root but consumed the live 0.4.11 policy ConfigMaps. Chart 0.4.18
    corrected policy provenance but its generic canary position check rejected
    the valid exact render before create. It remains immutable, published, and
    neither a Job nor rollback anchor. The correction is a new immutable chart
    0.4.19; evidence, confirmations, release material, recovery paths, and
    operator procedures all bind 0.4.19 rather than rewriting historical
    packages.
20. The public forward-recovery wrapper invokes its package-local repair
    delegate as `bash <delegate>` so correctness does not depend on executable
    mode retained by the Helm archive. The r24 auth-only `helm template` includes
    `--is-upgrade`, matching the subsequent upgrade and satisfying the chart's
    upgrade-only validation without weakening that validation.
21. The platform policy gains only `auth/token/lookup-self` read and
    `auth/token/revoke-self` update. Fresh init already writes the projected
    platform policy before `eso-role`. Forced recovery-root reconciliation
    materializes the byte-equal package snapshot in `emptyDir`, verifies its
    package-rendered hash, and writes it before role mutation/validation and
    canary login without mounting the live canonical ConfigMap;
    `PLATFORM_POLICY_BOOTSTRAP_FAILED` stops the sequence. The dedicated
    reconciler gains no policy-write, mount, Secret, or KV authority.
22. The additional r24 precursor is one exact 0.4.14 partial state: desired store
    spec, exact labels/Helm owner/UID, no hooks, exact reconcile-request, single
    lookup-self 403 `ValidationFailed` condition, and fourteen canonical unique
    ExternalSecrets. Under that store state the ES set must be homogeneous: all
    objects have exactly one Ready=True condition, or all have exactly one
    Ready=False/SecretSyncedError/`could not get secret data from provider`
    condition. Mixed states, extra or absent conditions, identity/cardinality/
    namespace drift, and reason/message drift fail before mutation; ES UIDs are
    not hardcoded. ResourceVersion is captured dynamically. Apply does not patch
    that desired store; it creates a fresh 0.4.19 digest-bound Job before
    readiness waits. The retained 0.4.14 Job is never reused or deleted.
23. The early Phase-A confirmation gate binds the exact current revision/chart
    to immutable target 0.4.19 and a digest-shaped suffix before attestations are
    loaded. A 0.4.18 or older confirmation therefore fails with
    `JIT_TARGET_CONFIRMATION_REQUIRED` before any mutation rather than being
    misclassified as evidence drift.
24. `forceRecoveryRoot` defaults to false and is valid only with
    `allowRecoveryRoot=true`. Routine rendering remains dedicated-only, without
    recovery Secret mount or policy-write commands. The package-bound r24 render
    sets both flags; it skips dedicated login deterministically, loads the root
    token without printing it, emits the exact root-source marker, writes the
    platform policy, and only then reconciles roles and runs the canary. The
    structural package guard and log evidence gate both require that contract.
25. For the exact stable provider-error precursor, a public list requires three
    exact retained r24 auth anchors. The 0.4.14, 0.4.16 and 0.4.17 objects must
    match their exact names, UIDs and exactly six package/target/source plus Helm
    hook annotations, `failed=1`, `succeeded` absent or zero, and exactly two
    uniquely typed `FailureTarget` and `Failed` conditions, both
    `True/BackoffLimitExceeded`, in either order. Resource versions and
    timestamps remain dynamic. Extra prefix Jobs are allowed only as fully
    attested terminal attempts for the current 0.4.19 digest/target: exact
    generated-name prefix and valid suffix, unique UUID UID, and exactly seven
    annotations—the anchor six plus attested chart version 0.4.19. The only
    terminal states are exact Failed (`failed=1`, succeeded default zero,
    `Failed`+`FailureTarget` `True/BackoffLimitExceeded`) or exact Kubernetes
    v1.36 Successful (`succeeded=1`, failed default zero,
    `Complete`+`SuccessCriteriaMet` `True/CompletionsReached`). Names and UIDs are
    globally unique. Drift fails before the fresh 0.4.19 create; no retained
    object is reused, logged or mutated. This fence runs after Store and all
    fourteen ExternalSecret precursor validation for every Store state admitted
    by exact r24 recovery, including `Ready`/`complete` after a Successful Job
    and downstream failure; Store state never bypasses it.
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
28. The r24 history fence keeps exact failed .14/.16/.17 objects as the only
    immutable anchors. Zero or more additional objects are admitted only as
    exact current-digest/current-target 0.4.19 Failed or Successful terminals
    with unique generated names and UUID UIDs; annotations and terminal status
    fail closed on any drift. No .18 Job exists; any prefix-matching .18 target
    or provenance is unexpected drift and fails closed. This preserves
    fail-forward retries without treating .17 or .18 as a current package or
    rollback target. The fence is unconditional within every admitted exact-r24
    Store state and always precedes fresh create.
29. The structural guard replaces `canary_marker` with one semantic match over
    the rendered shell assignment. The match must bind all four facts within the
    same command substitution: assignment target `canary_json`, executable/token
    sequence `bao write -format=json auth/kubernetes/login`, exact
    `role="$role"`, and JWT obtained by `cat /canary/token`. It may normalize only
    the rendered line-continuation whitespace needed to recognize those exact
    shell tokens. Missing, duplicate, differently assigned, differently roled,
    differently sourced, or partially matching commands fail
    `REVISION24_AUTH_RECONCILE_RENDER_DRIFT`. The guard uses the sole match
    object's captured `start()` position. It never uses `str.index`, `str.rindex`,
    or a bare login substring to choose the canary.
30. The guard captures exact unique anchors and proves the complete sequence:
    both package snapshot materializations and hash evidence, forced recovery-root
    accepted source, platform policy write, auth-reconcile policy write, every
    bootstrap/reconciler/ESO role mutation or reconciliation boundary, semantic
    canary, `auth/token/lookup-self`, `auth/token/revoke-self`, and the terminal
    success. In compact form the invariant is
    `snapshots -> root source -> platform policy -> auth policy -> roles ->
    semantic canary -> lookup-self -> revoke-self -> terminal`. The .18
    snapshot/hash, `emptyDir`, no-ConfigMap, recovery mount, policy-content,
    one-Job/container, marker, `Never`, and backoff-zero gates remain mandatory;
    .19 weakens none of them.
31. Public black-box proof executes the distributed 0.4.19 CLI against an exact
    real chart archive and real `helm template` output, with only external
    Kubernetes/registry effects substituted. The rendered script must retain the
    earlier dedicated `login_json` branch and later semantic `canary_json` branch
    so the regression cannot be hidden by the reduced fixture. Positive proof
    reaches exactly one .19 `kubectl create` after the guard. Negative cases
    independently change assignment identity, role identity, JWT source,
    semantic-canary cardinality, and each order boundary, plus representative
    snapshot/hash/volume/policy/restart/backoff drift; every case stops before
    create, store/owner mutation, or Helm.
32. Authorization consumption and cluster mutation are separate state facts.
    Acceptance of the new digest-bound one-use JIT records
    `authorization_consumed=true`. Read-only package render and structural guard
    keep `mutation_started=false`. Immediately before `kubectl create` the CLI
    sets `mutation_started=true`, because a client-side create error can be
    ambiguous about server-side persistence. Thus any pre-create .19 render or
    guard failure reports consumed authorization but not cluster mutation; create
    ambiguity and every later error retain `mutation_started=true` and
    `FORWARD_RECOVERY_REQUIRED`. Setting the marker after create was rejected
    because it could falsely report no mutation when the API server accepted the
    Job but the response was lost.
33. Fresh install and routine upgrade use the same 0.4.19 templates, defaults,
    schema, images, ServiceAccounts, probes, policy helpers, network boundaries
    and dedicated-only auth behavior as 0.4.18. Fresh install runs full bootstrap
    before the role/canary; routine upgrade renders no recovery Secret, package
    snapshots, forced root, or policy writes. Release CI must lint/schema-check,
    package, digest, render and publish 0.4.19 immutably, and must reject a
    top-level/dependency version mismatch or mutable replacement.
34. Operational evidence remains metadata-only and secret-silent. The Job's
    existing deadline, retry, terminal log, probes and policy scopes remain
    unchanged; the CLI adds no capacity, storage, HA, network, RBAC or Service
    requirement. P3 observes pre-create guard failure separately from an actual
    attempt, P4 can audit authorization consumption and mutation independently,
    and P12/P13 retain the exact credential/isolation boundary.

## Alternatives considered

- Keeping the generic `str.index` was rejected because the exact real package
  already proves it selects the wrong dedicated-login branch.
- Changing to `str.rindex` was rejected because position is not identity: a
  duplicate or unrelated later login could be selected and pass order checks.
- Deleting or reordering the dedicated runtime login was rejected because that
  would change routine authentication semantics to accommodate a verifier bug.
- Adding a general shell AST dependency was rejected for this bounded package
  guard: it enlarges the release/runtime dependency surface and still requires
  semantic assertions. The exact unique assignment matcher is smaller, testable,
  and fails closed on syntax drift.
- Reusing 0.4.18, its digest, evidence, or consumed JIT was rejected because OCI
  artifacts are immutable and one-use authorization cannot be widened after the
  fact. Publishing 0.4.19 preserves provenance and audit clarity.
- Marking mutation at Phase-A entry was rejected because pre-create validation is
  read-only; marking it after create was rejected because create response loss is
  ambiguous. Separate authorization state plus a pre-create mutation marker is
  the safe boundary.

## Failure and rollback

For exact r24, auth Job render, semantic canary/order proof, metadata
transformation, create, returned-ref, completion, log, metadata, or canary
failure stops before the store handoff, ExternalSecret owner mutation, and Helm.
A pre-create render/guard failure reports `authorization_consumed=true` and
`mutation_started=false`; it is safe to stop, but a new JIT is still required
for another target or attempt. A create command failure emits
`REVISION24_AUTH_RECONCILE_CREATE_FAILED`; empty, duplicate or invalid create
output emits `REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT`. Neither failure path
deletes an attempt. Other auth mismatches stop before ESO CR refresh and never
fall back to payload operations. A matching role plus denial reports
`ROLE_MATCHES_AUTH_STILL_DENIED`. Ferret failure leaves old Ready endpoints.
Unexpected PVC binding/data invalidates Phase B. Before `kubectl create`, live
revision 24/chart 0.4.11 remains untouched. The maximum safe stop/rollback point
is therefore immediately before create: there is nothing to restore, and .18 is
not a rollback point because it created no Job or release revision. Immediately
before create, the procedure crosses the fail-forward boundary. Once any
mutation may have started, every failure emits a forward-recovery instruction;
neither apply tool uses atomic upgrade or Helm rollback, and none of 0.4.11
through 0.4.18 is a rollback target. After PVC deletion, restoration to revision
20 is storage-incompatible and rollback is impossible under this change. The
separate Phase-B JIT, post-scale evidence reread and exact PVC confirmation gate
that irreversible decision. Data-bearing storage changes require a distinct
backup/restore and P13 isolation-parity design.

## Migration Plan

1. Publish immutable 0.4.19 and bind fresh backup/parity evidence plus the exact
   r24→0.4.19 confirmation to its registry digest. Never reuse the consumed .18
   JIT or represent .18 as a Job/rollback anchor.
2. Revalidate the exact r20/r22/r23/r24 history, storage, workload, identity,
   owner, external ESO and .14/.16/.17 Job evidence without reading Secrets.
   Require zero or more exact Failed/Successful current-.19 attempts, six
   annotations on anchors and seven on current attempts, and reject every .18
   Job identity or provenance.
3. Run the exact real packaged render through the semantic guard. Require one
   `canary_json` assignment bound to the canary role/JWT and the complete
   snapshots-to-terminal order. A pre-create failure records authorization
   consumption but no cluster mutation.
4. From the validated package-derived recovery-root Job, create a new
   digest-prefixed/annotated generated identity with a 300-second active deadline.
   Set `mutation_started=true` immediately before create.
   Accept only the exact fresh resource ref returned by `kubectl create -o name`
   and use it for the five-minute wait and log. Require its own exact recovery-
   root source marker even when an earlier current attempt succeeded. On failure retain the attempt,
   emit its stable `REVISION24_AUTH_RECONCILE_*` code plus
   `FORWARD_RECOVERY_REQUIRED`, and stop before store, ExternalSecret-owner, or
   Helm mutation. Retry repeats preflight and creates another identity; no prior
   attempt is deleted, reused, reapplied or accepted as evidence.
5. CAS-handoff the exact store, wait at most ten minutes separately for it and
   each canonical ExternalSecret, and fail forward before Helm if external ESO
   egress does not permit convergence.
6. Perform both 20-minute non-atomic Phase-A upgrades without global wait, use a
   ten-minute timeout per resource in the explicit non-vector rollout vector,
   apply the ten-minute FerretDB/store health waits, and run the second pass with
   recovery-root disabled. Stop with `PHASE_A_HEALTH_GATE_FAILED` or
   `FINAL_HEALTH_GATE_FAILED` plus `FORWARD_RECOVERY_REQUIRED`; never roll back.
7. Keep Phase B separately JIT-gated. Any failure after mutation is recovered by
   forward-applying 0.4.19; no Helm rollback is allowed.

## Verification

Strict lint/schema, managed/external ESO renders, fresh-install and routine
upgrade renders, black-box contracts mapped to the exact Scenario headers,
non-staging storage non-regression, six digest assertions, shell syntax, OpenSpec
strict validation, and 0.4.19 package checksum validation run on the source
commit. The decisive regression test packages the real chart and runs the public
CLI guard against real Helm output containing both login branches; reduced fake
render coverage is supplementary only.

Disposable verification must cover: clean-namespace install; supported
revision-20/r22/r23/r24 upgrade anchors; exact .18 pre-create regression;
positive .19 semantic guard; negative identity/cardinality/order/structural
drift; failed create and lost-response ambiguity; deadline/log evidence;
external ESO non-convergence; both Phase-A passes; no-root final health; Phase-B
failure injection; restore/forward recovery; P7/P12 capability health; P13
negative isolation; and uninstall/cleanup proof. Shared staging is not the first
test and production is never a test target.

## Operations, release, and documentation handoff

The operator health gates, ten-minute rollout/readiness bounds, 300-second Job
deadline, five-minute completion wait, metadata-only log evidence, external ESO
egress prerequisite, storage semantics, backup/parity attestations and owner
boundaries are unchanged. Metrics/log/audit evidence must distinguish package
render failure, authorization consumption, Job creation ambiguity, Job terminal
failure, store/ExternalSecret convergence, Helm passes and Phase-B mutation.
Existing one-replica local-path staging remains explicitly non-HA and is not a
production durability claim. Disaster recovery remains package/evidence replay
before mutation and fail-forward repair after mutation.

One PR on `fix/staging-exact-canary-guard-0.4.19` updates the authoritative chart
repository. It contains the OpenSpec delta first, then the minimal CLI guard,
public black-box/package fixtures, chart/release metadata and documentation. No
other repository or PR is required. The system-implementer must preserve other
agents' unrelated work, must not rewrite 0.4.18, and must not combine a live
cluster apply with the source PR. Independent system review precedes publication;
fresh package evidence and a separately authorized deployment follow.

Documentation updates must satisfy all fourteen standard parts: (1) P18/P3/P4/
P7/P12/P13/P17 audience and outcome; (2) staging-only maturity and prerequisites;
(3) r24/package/history/JIT concepts and scope; (4) least privilege, Secret and
tenant boundaries; (5) exact .19 package/digest/evidence/configuration contract;
(6) end-to-end preflight/apply procedure and expected markers; (7) packaged CLI
and Helm inspection variants; (8) copyable confirmation examples using
placeholders; (9) timeouts, retry, idempotency and 0..N attempt rules; (10)
logs/audit evidence including authorization-versus-mutation state; (11) semantic
guard, history, ESO and Helm failure troubleshooting; (12) cleanup, fail-forward,
Phase-B migration and rollback limits; (13) .14/.16/.17/.18/.19 compatibility and
deprecation history; and (14) verification date, source commit and OCI digest
provenance.

## Major risks

1. Future legitimate shell formatting may fail the exact matcher; fail-closed
   behavior and a real-package contract make that visible before mutation.
2. A reduced fixture may diverge again; real packaged Helm output is mandatory.
3. Package, evidence or JIT may bind different digests; all three remain exact
   and one-use.
4. An unexpected .18 Job would contradict proven history; the fence stops rather
   than inferring what happened.
5. Recovery-root handling could expose excessive privilege; no new mount/RBAC,
   secret read or log path is added and the forced window remains bounded.
6. External ESO egress/readiness may still block recovery after the Job; the
   existing per-resource gates stop before Helm and preserve ownership.
7. Rollback is unavailable after the first possible mutation and impossible
   after Phase-B PVC deletion; the new JIT, backups, parity and exact state gates
   remain mandatory.
