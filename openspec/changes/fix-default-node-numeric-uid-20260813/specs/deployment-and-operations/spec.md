## ADDED Requirements

### Requirement: Default Node workloads SHALL use platform-compatible non-root identities

The Falcone chart SHALL render the `controlPlaneExecutor` and
`workflowWorker` containers with numeric `runAsUser: 1000` and
`runAsGroup: 1000` defaults on vanilla Kubernetes. Both workloads SHALL retain
`runAsNonRoot: true`, `allowPrivilegeEscalation: false`, a read-only root
filesystem, and all Linux capabilities dropped. The chart values schema SHALL
admit only non-zero numeric Kubernetes UID/GID overrides for these fields and
SHALL admit null for explicit legacy-render compatibility. No other workload
identity, image, replica count, service account, network, storage, credential,
or public API contract SHALL change.

When the OpenShift restricted profile is selected, the rendered pod and
container security contexts for both workloads SHALL omit `runAsUser` and
`runAsGroup`, so the active SCC and namespace UID range remain authoritative
for `runAsUser` admission and assignment. This contract SHALL NOT claim that
restricted-v2 assigns a primary GID. `fsGroup` and supplemental groups SHALL
remain subject to their distinct SCC strategies and SHALL be evaluated
separately from `runAsUser`.
The existing OpenShift overlay and wrapper normalization SHALL accomplish this
without requiring a workload-specific overlay value. The OpenShift render SHALL
retain all platform-neutral non-root hardening.

#### Scenario: Vanilla Kubernetes starts Node images that declare named users

- **WHEN** the chart is rendered with default values for vanilla Kubernetes
- **THEN** the `controlPlaneExecutor` and `workflowWorker` container security
  contexts each contain numeric `runAsUser: 1000` and `runAsGroup: 1000`
- **AND** both retain `runAsNonRoot: true`, no privilege escalation, a read-only
  root filesystem, and all capabilities dropped
- **AND** the default two replicas of each workload can pass kubelet non-root
  identity validation instead of entering `CreateContainerConfigError`

#### Scenario: OpenShift retains arbitrary UID assignment for Node workloads

- **WHEN** the chart is rendered with the OpenShift restricted overlay
- **THEN** the `controlPlaneExecutor` and `workflowWorker` pod and container
  security contexts omit fixed `runAsUser` and `runAsGroup` values
- **AND** both retain `runAsNonRoot: true`, no privilege escalation, a read-only
  root filesystem, all capabilities dropped, and RuntimeDefault seccomp where
  the existing profile supplies it
- **AND** live verification checks that every admitted target pod's effective
  primary UID is in the namespace range without requiring or reporting an
  SCC-assigned primary GID
- **AND** any `fsGroup` or supplemental-group evidence is evaluated separately
  against its applicable SCC strategy

#### Scenario: Invalid identity override is rejected

- **WHEN** an operator supplies zero, a negative value, a string, or a
  non-integer for either affected workload's `securityContext.runAsUser` or
  `securityContext.runAsGroup`
- **THEN** chart schema validation fails before workload rendering or mutation
- **AND** no root-capable relaxation is accepted

#### Scenario: Compatible custom Node image uses an explicit non-root identity

- **WHEN** an operator replaces either affected image with a compatible image
  whose runtime user has a different numeric non-root UID/GID
- **THEN** the operator can set matching positive integer `runAsUser` and
  `runAsGroup` values for that workload
- **AND** all other non-root hardening remains enforced by the rendered values

#### Scenario: Existing release upgrades without persistent-data migration

- **WHEN** an existing vanilla-Kubernetes release without the numeric defaults
  upgrades to the corrected chart values
- **THEN** Helm changes only the affected Pod templates and Kubernetes performs
  their normal Deployment rolling replacement
- **AND** no PVC, Secret payload, database schema, tenant data, service account,
  image reference, or public API is migrated or rewritten by this change

#### Scenario: Vanilla Kubernetes historical downgrade preserves startup compatibility

- **WHEN** an operator must downgrade a vanilla-Kubernetes release to an exact
  historical chart package whose defaults omit the numeric identities
- **THEN** the executable downgrade asset accepts exact namespace, release,
  historical version and mandatory package-byte digest and repeats an exact
  `helm pull oci://ghcr.io/gntik-ai/charts/in-falcone --version <version>` into a
  private temporary directory
- **AND** it requires exactly one regular `in-falcone-<version>.tgz`, verifies
  exact filename, chart metadata and version plus SHA-256 over its local file
  bytes, and invokes `helm upgrade --reuse-values` with only that verified local
  file plus the reviewed small vanilla-specific values asset, never a blind
  history-index `helm rollback`
- **AND** it performs no output-derived digest fallback, alternate remote pull,
  filesystem package discovery, OCI substitution during upgrade, or other
  package fallback
- **AND** that values asset supplies explicit positive numeric
  `securityContext.runAsUser` and `securityContext.runAsGroup` values for both
  affected workloads before accepting rollout health
- **AND** the verifier rejects the downgrade if either Deployment lacks exactly
  two desired, updated, ready, and available replicas, either container lacks
  the expected numeric identities, or any affected pod reports
  `CreateContainerConfigError`

#### Scenario: OpenShift historical downgrade preserves SCC authority

- **WHEN** an operator downgrades an OpenShift restricted release to an exact
  historical chart package
- **THEN** the executable downgrade asset accepts exact namespace, release,
  historical version and mandatory package-byte digest and repeats an exact
  `helm pull oci://ghcr.io/gntik-ai/charts/in-falcone --version <version>` into a
  private temporary directory
- **AND** it requires exactly one regular `in-falcone-<version>.tgz`, verifies
  exact filename, chart metadata and version plus SHA-256 over its local file
  bytes, and invokes `helm upgrade --reuse-values` with only that verified local
  file plus the reviewed small OpenShift-specific values asset, never a blind
  history-index `helm rollback`
- **AND** it performs no output-derived digest fallback, alternate remote pull,
  filesystem package discovery, OCI substitution during upgrade, or other
  package fallback
- **AND** the rendered pod and container security contexts continue to omit
  fixed `runAsUser` and `runAsGroup` values
- **AND** the verifier requires exactly two desired, updated, ready, and
  available replicas for each Deployment, verifies every admitted target pod's
  effective primary UID against the namespace range, and makes no assertion
  that the SCC assigned a primary GID
- **AND** the verifier rejects any affected pod with
  `CreateContainerConfigError`

### Requirement: Node workload operational assets SHALL verify provenance and health fail closed

The chart package SHALL ship executable verification and historical-downgrade
assets for the two affected Node workloads. The standalone verifier SHALL accept
exact release, namespace, and platform only; SHALL verify bounded live identity,
full container hardening, replicas, pods, and health; SHALL read no Secret
payload; and SHALL reject missing, ambiguous, stale, or mismatched live evidence
with stable non-secret `NODE_VERIFY_*` result codes. It SHALL derive
target Deployment names with the same `trunc 63` then `trimSuffix "-"` behavior
as Helm or SHALL reject input that cannot resolve both names uniquely. It SHALL
NOT accept or claim artifact, version, or digest provenance.

Each downgrade asset SHALL accept exact namespace, release, historical version,
and mandatory expected package-byte digest and SHALL enforce provenance before
mutation. It SHALL perform the exact OCI/version `helm pull` into a private
temporary directory; require exactly one regular expected-name `.tgz`; verify
exact filename, package metadata, version, and SHA-256 over those newly pulled
local bytes; and have no digest-from-output, alternate-remote,
package-discovery, OCI-upgrade, or other fallback. It SHALL pass only that
verified local `.tgz` to `helm upgrade --reuse-values` with exactly one reviewed
small platform overlay, then SHALL invoke the standalone verifier. Neither asset
SHALL use or recommend blind history-index-based `helm rollback`. Operator
documentation SHALL provide complete executable commands containing every
required argument and SHALL define every placeholder. Its documented pre-pull
SHALL serve only to calculate the operator's digest input; the helper SHALL
repeat the pull and verify its own bytes. Pre-mutation package failures SHALL
emit stable non-secret `NODE_DOWNGRADE_*` result codes and SHALL NOT print
package contents, release values, resource JSON, credentials, or arbitrary
command output.

#### Scenario: Vanilla live verification succeeds

- **WHEN** the standalone verifier targets an exact vanilla-Kubernetes release
  and namespace with `platform=vanilla`
- **THEN** it reports success only when each affected Deployment has exactly two
  desired, updated, ready, and available replicas
- **AND** both target container specs contain exact `runAsUser: 1000` and
  `runAsGroup: 1000`, `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and
  `capabilities.drop: [ALL]`
- **AND** each workload has exactly two Running and Ready target pods whose sole
  target container is Running and Ready
- **AND** no affected pod is waiting or has failed with
  `CreateContainerConfigError`

#### Scenario: OpenShift live verification succeeds without a primary GID claim

- **WHEN** the standalone verifier targets an exact OpenShift restricted release
  and namespace with `platform=openshift`
- **THEN** it reports success only when each affected Deployment has exactly two
  desired, updated, ready, and available replicas and its live
  Deployment-template pod and container security contexts both omit fixed
  `runAsUser` and `runAsGroup`
- **AND** both target container specs retain `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, and
  `capabilities.drop: [ALL]`
- **AND** each workload has exactly two Running and Ready target pods whose sole
  target container is Running and Ready
- **AND** it verifies every admitted target pod's effective primary UID against
  the namespace range
- **AND** it makes no assertion that restricted-v2 assigned a primary GID and
  evaluates `fsGroup` and supplemental groups only under their separate
  strategies
- **AND** no affected pod is waiting or has failed with
  `CreateContainerConfigError`

#### Scenario: Verification evidence is incomplete or unhealthy

- **WHEN** either Deployment has any replica count other than exactly two
  desired, updated, ready, and available replicas, a
  required identity or hardening field is wrong or present when it must be
  omitted, target naming is ambiguous, pod cardinality/readiness differs, or an
  affected pod has `CreateContainerConfigError`
- **THEN** the standalone verifier exits non-zero with a stable non-secret
  `NODE_VERIFY_*` diagnostic
- **AND** it SHALL NOT report the release, upgrade, or downgrade as healthy

#### Scenario: Historical package provenance is invalid before downgrade

- **WHEN** the exact OCI/version pull fails, produces anything other than one
  regular expected-name `.tgz`, has mismatched chart metadata/version, has a
  byte hash different from the mandatory expected SHA-256, or requires any
  fallback
- **THEN** the downgrade entrypoint exits non-zero before Helm with a stable
  non-secret `NODE_DOWNGRADE_*` diagnostic
- **AND** after the failed exact pull/proof it invokes no alternate pull,
  `helm upgrade`, `helm rollback`, or standalone verifier
