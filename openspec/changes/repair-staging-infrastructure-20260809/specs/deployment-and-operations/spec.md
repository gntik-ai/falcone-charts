# Deployment and operations delta

## ADDED Requirements

### Requirement: Falcone SHALL preserve externally managed ESO ownership

Falcone SHALL render no namespaced object in the external controller namespace,
SHALL NOT adopt or mutate its owner, and SHALL grant only exact TokenRequest and
TokenReview authority needed for OpenBao Kubernetes authentication. Repair
preflight SHALL compare a secret-suppressed semantic diff against the sanitized
metadata-only 21-resource owner inventory, including cluster-scoped objects,
and SHALL compare exact owner metadata before and after every apply pass. It
SHALL NOT read a Helm release manifest or Secret payload.

#### Scenario: External controller is reused

- **WHEN** staging selects externally managed ESO with exact namespace and ServiceAccount
- **THEN** Falcone renders its store, fourteen declarations and auth identity
- **AND** it renders no object into `external-secrets` and no adoption path
- **AND** create, update, removal, or owner-metadata drift of any protected ESO
  resource fails before the next mutation

### Requirement: OpenBao upgrades SHALL reconcile auth metadata only

OpenBao SHALL use its rotating pod-local Kubernetes reviewer credential. Full
KV/policy bootstrap SHALL be fresh-install-only. Routine reconciliation SHALL be
idempotent and SHALL NOT read/mutate KV payloads or policy documents. The server,
bootstrap and routine reconciler SHALL use distinct Kubernetes ServiceAccounts.
The server identity SHALL have only TokenReview authority; bootstrap Secret
authority SHALL be assigned only to the bootstrap identity; and routine metadata
authority SHALL be assigned only to the reconciler identity.

#### Scenario: Kubernetes identities are least-privilege and separate

- **WHEN** a fresh install and a routine upgrade are rendered
- **THEN** the StatefulSet, bootstrap Job and reconciler Job use three distinct
  ServiceAccounts
- **AND** the server cannot read or write platform/recovery Secrets
- **AND** the bootstrap identity is not granted TokenRequest or TokenReview
- **AND** the reconciler cannot access KV, mounts, audit configuration or policy
  documents

#### Scenario: Static reviewer credential is present

- **WHEN** auth metadata reports a persisted reviewer JWT
- **THEN** reconciliation clears static reviewer JWT/CA mode, normalizes the exact role,
  verifies metadata and runs a no-KV login/lookup/revoke canary

#### Scenario: Metadata already matches

- **WHEN** config and role metadata match
- **THEN** it performs no metadata write and reports `result=unchanged`

#### Scenario: Matching role remains denied

- **WHEN** the exact role matches but canary login returns denied
- **THEN** it fails with `ROLE_MATCHES_AUTH_STILL_DENIED` without touching KV/policies

### Requirement: FerretDB SHALL retain availability during the UID repair

The engine gate SHALL run as UID 999 with non-root hardening. The Deployment SHALL
use maxUnavailable 0, maxSurge 1 and retain the old Ready ReplicaSet until a
replacement passes readiness.

#### Scenario: Replacement never becomes Ready

- **WHEN** init/readiness fails
- **THEN** the old Ready endpoint count remains and rollout reaches its deadline

### Requirement: Storage and image repair SHALL be staging-only and immutable

Staging SHALL select local-path plus fsn1 and the six approved digests. Base,
production, HA and OpenShift SHALL NOT inherit this storage choice.

#### Scenario: Staging render

- **WHEN** `values/staging.yaml` is rendered
- **THEN** pgvector selects local-path/fsn1 and all six images are digest-pinned

### Requirement: The revision-20 empty PVC transition SHALL be JIT-gated

The procedure SHALL default to dry-run. Apply SHALL require separate fresh
backup/parity attestations bound to exact source target, repair chart, and
package digest. Phase B SHALL additionally require a fresh Phase-A attestation
whose result matches the live revision/chart/package and proves recovery-root
disabled plus final health. Target confirmation SHALL contain current revision,
chart, and package digest. PVC confirmation SHALL remain a separate exact
name/UID confirmation.

The procedure SHALL delete no PVC until exact target, name, immutable UID,
Pending/no-volume/no-PV state are rechecked. It MAY admit the exact initial
Pending vector StatefulSet Pod reference, but SHALL scale only that StatefulSet
to zero, wait boundedly for termination, and then reread PVC, PV, Pod, and data
evidence after the confirmation boundary. State change SHALL invalidate
confirmation.

#### Scenario: PVC state changes

- **WHEN** the UID, phase, volumeName, PV claimRef or Pod evidence changes
- **THEN** deletion is forbidden and a data migration plan is required

#### Scenario: Evidence is opaque, stale, or targets another package

- **WHEN** backup, parity, or Phase-A evidence is missing, expired, malformed,
  reused, differently targeted, or does not match the live revision/chart/package
- **THEN** the tool emits a stable evidence error and performs no mutation

#### Scenario: Initial Pending vector Pod exists

- **WHEN** the exact vector StatefulSet controls its expected ordinal-zero Pod,
  the Pod is Pending, and the unbound claim has no PV or data evidence
- **THEN** the tool scales that exact StatefulSet to zero, waits boundedly, and
  performs the final evidence reread before the exact claim deletion

#### Scenario: Apply fails after deletion

- **WHEN** canonical local-path apply fails after the empty claim is deleted
- **THEN** the tool reports `FORWARD_RECOVERY_REQUIRED`, recovery reapplies 0.4.6,
  and neither path uses atomic upgrade or rollback to revision 20

### Requirement: Phase-A completion SHALL prove final no-root health

Phase A SHALL run the owner, six-image, store, exact fourteen-secret, auth,
FerretDB replica, and Ready-endpoint gates after the recovery-root allowance is
removed. Final OpenBao reconciliation SHALL report unchanged and canary passed.

#### Scenario: Final pass regresses a dependency

- **WHEN** any owner, image, store, ExternalSecret, auth, FerretDB, or endpoint
  gate regresses after the no-root pass
- **THEN** Phase A fails with `FINAL_HEALTH_GATE_FAILED` and requires forward
  recovery rather than reporting a successful attestation point
