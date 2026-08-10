# Design: Revision-20 staging infrastructure repair

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
   exact role, verifies, and runs login/lookup-self/revoke-self. Canonical values
   disable recovery-root use immediately afterward.
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
   apply pulls the 0.4.10 OCI artifact, verifies its registry-reported digest, and
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
    existing two-pass Phase-A path and requires fresh 0.4.10/package-bound backup
    and parity evidence, but no fabricated Phase-A attestation.

## Failure and rollback

Auth mismatch or canary failure stops before ESO CR refresh and never falls back
to payload operations. A matching role plus denial reports
`ROLE_MATCHES_AUTH_STILL_DENIED`. Ferret failure leaves old Ready endpoints.
Unexpected PVC binding/data invalidates Phase B. Before Phase A, revision 20 is
untouched. Once any mutation starts, every failure emits a forward-recovery
instruction; neither apply tool uses atomic upgrade or rollback. After PVC
deletion, revision-20 restoration is storage-incompatible. Data-bearing storage
changes require a separate backup/restore and isolation-parity design.

## Verification

Strict lint/schema, managed/external ESO renders, upgrade render, black-box
contracts, non-staging storage non-regression, six digest assertions, shell syntax,
OpenSpec strict validation, and package checksum validation run on the source
commit. Independent disposable live verification occurs after maker handoff.
