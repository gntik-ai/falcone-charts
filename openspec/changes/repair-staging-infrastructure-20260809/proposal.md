# Change: Repair revision-20 staging infrastructure

## Why

Staging has independent ESO/OpenBao auth, FerretDB init, pgvector storage, and
Helm image-authority defects. Revision 20 also overlaps an administrator-owned
External Secrets Operator. Repair must preserve external ownership and data,
avoid expiring reviewer credentials, retain document availability, and gate the
only destructive empty-PVC transition.

## What Changes

- Preserve externally managed ESO mode and render/mutate nothing owned by its
  Helm release; grant exact TokenRequest/TokenReview authority only.
- Make OpenBao full bootstrap fresh-install-only and routine upgrade reconciliation
  idempotent, auth-metadata-only, local-reviewer based, and no-KV.
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
  rollout failure, targeting immutable chart 0.4.11 and rejecting evidence drift
  before mutation.
- Admit the one exact observed partial manual recovery in which APISIX is 3/3
  Ready through an exact Deployment→ReplicaSet→Pod UID/revision owner chain as
  runtime UID/GID 636 with the existing standalone ConfigMap mounted, while
  observability retains the sole named-user failure; make that mount and numeric
  identity declarative in staging without adopting the ConfigMap, and prove
  both APISIX and Prometheus numeric convergence after each upgrade pass.

## Impact

Affected source is limited to `charts/in-falcone/**`, related chart tests/docs,
this OpenSpec package, and chart release validation if needed. No Falcone product
API/source changes occur. P18/P3/P4 are primary acceptance lenses; P8/P9/P10/P12/P17
must recover their journeys and P13 remains the adjacent-tenant negative lens.

## Exclusions and gates

Packaging and source validation do not mutate a cluster. No ESO owner adoption,
Secret value read, PVC deletion, merge, or automatic rollback is part of the
implementation. A shared-staging rollout is a later, separately gated operation;
Phase B still needs an immediate exact PVC name/UID confirmation after all state
gates pass.
All mutation paths are fail-forward; no automatic or explicit Helm rollback is
part of the repair.
