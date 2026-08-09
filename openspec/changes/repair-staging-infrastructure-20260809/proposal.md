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
- Select local-path plus fsn1 only in staging and pin the six approved immutable
  application/runtime digests there.
- Add dry-run-first revision-20 preflight, two-phase migration, forward recovery,
  structured short-lived evidence, semantic external-owner protection, detailed
  operations/security/storage documentation, and black-box contracts.

## Impact

Affected source is limited to `charts/in-falcone/**`, related chart tests/docs,
this OpenSpec package, and chart release validation if needed. No Falcone product
API/source changes occur. P18/P3/P4 are primary acceptance lenses; P8/P9/P10/P12/P17
must recover their journeys and P13 remains the adjacent-tenant negative lens.

## Exclusions and gates

No cluster is contacted by implementation. No ESO owner adoption, Secret value
read, PVC deletion, deployment, merge, push, or PR occurs. Disposable clean-install
and revision-20 upgrade proof plus independent review remain later gates. The
shared-staging Phase A needs separate environment authorization; Phase B needs an
immediate exact PVC name/UID confirmation after all state gates pass.
All mutation paths are fail-forward; no automatic or explicit Helm rollback is
part of the repair.
