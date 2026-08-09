# Deployment and operations delta

## ADDED Requirements

### Requirement: Falcone SHALL preserve externally managed ESO ownership

Falcone SHALL render no namespaced object in the external controller namespace,
SHALL NOT adopt or mutate its owner, and SHALL grant only exact TokenRequest and
TokenReview authority needed for OpenBao Kubernetes authentication.

#### Scenario: External controller is reused

- **WHEN** staging selects externally managed ESO with exact namespace and ServiceAccount
- **THEN** Falcone renders its store, fourteen declarations and auth identity
- **AND** it renders no object into `external-secrets` and no adoption path

### Requirement: OpenBao upgrades SHALL reconcile auth metadata only

OpenBao SHALL use its rotating pod-local Kubernetes reviewer credential. Full
KV/policy bootstrap SHALL be fresh-install-only. Routine reconciliation SHALL be
idempotent and SHALL NOT read/mutate KV payloads or policy documents.

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

The procedure SHALL default to dry-run and SHALL delete no PVC until exact target,
name, immutable UID, Pending/no-volume/no-PV/no-Pod state are rechecked and a human
confirms the displayed name/UID. State change SHALL invalidate confirmation.

#### Scenario: PVC state changes

- **WHEN** the UID, phase, volumeName, PV claimRef or Pod evidence changes
- **THEN** deletion is forbidden and a data migration plan is required

#### Scenario: Apply fails after deletion

- **WHEN** canonical local-path apply fails after the empty claim is deleted
- **THEN** recovery rolls forward with 0.4.3 and SHALL NOT blindly roll back to revision 20
