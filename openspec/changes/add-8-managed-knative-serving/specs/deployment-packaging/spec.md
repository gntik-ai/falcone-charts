# deployment-packaging — spec delta for add-8-managed-knative-serving

## ADDED Requirements

### Requirement: The umbrella chart exposes an explicit three-mode Knative runtime contract

`charts/in-falcone` SHALL accept a schema-validated Knative runtime mode of exactly `managed`,
`external`, or `disabled`, defaulting to `disabled`. The chart SHALL NOT make the managed Knative
bundle an unconditional dependency in any mode. With the default `disabled` value and with the
current `external`-prerequisite configuration, the rendered manifests SHALL remain byte-compatible
with the pre-change chart so existing installations are unaffected. The chart SHALL NOT advertise
managed Knative as available until the coordinated implementation and disposable-cluster acceptance
pass.

#### Scenario: Default disabled render is unchanged

- **WHEN** `charts/in-falcone` is rendered with default values (no Knative runtime mode set)
- **THEN** the mode resolves to `disabled`, no runtime-status mount or Knative lifecycle resource is
  added, and the render is byte-compatible with the pre-change chart

#### Scenario: External mode preserves current prerequisite behaviour

- **WHEN** an operator selects `external` mode with an administrator-supplied Knative installation
- **THEN** the chart adds no Knative lifecycle resource, mutates no external installation, and keeps
  the existing external-prerequisite deployment behaviour

#### Scenario: Managed mode adds no umbrella dependency

- **WHEN** an operator selects `managed` mode in the umbrella values
- **THEN** the umbrella render still declares no managed Knative bundle dependency and creates no CRD,
  cluster RBAC, or admission webhook for the serving layer

#### Scenario: Managed availability is not advertised before acceptance

- **WHEN** the chart, its `NOTES.txt`, or its values documentation are inspected before acceptance
- **THEN** managed Knative is described as proposed/unavailable-by-default and is not claimed as a
  supported live mode

### Requirement: The umbrella chart mounts the projected runtime status owner-safely and fails closed

When the runtime mode is `managed` or `external`, `charts/in-falcone` SHALL set
`KNATIVE_RUNTIME_MODE` on the `controlPlane` and `controlPlaneExecutor` components, preserve the
consuming application's default `KNATIVE_RUNTIME_STATUS_FILE` of
`/var/run/falcone/knative/status.json`, mount the projected `falcone.knative-runtime/v1` ConfigMap as
an optional **source directory volume** (never via `subPath`), and mount a separate `emptyDir` at the
application-visible directory. A chart-supplied guard SHALL run without a service-account token or
Kubernetes API authority, validate the source document and its bounded `validUntil` lease, and
atomically replace the application-visible `status.json`. Missing, malformed, oversized, or expired
source SHALL materialize a valid non-ready document. The projected runtime-status ConfigMap SHALL NOT
be owned or templated by the `in-falcone` Helm release (it is written by the `falcone-knative`
lifecycle/projector), so the umbrella and the managed release never contend for the same object. The
umbrella chart SHALL register its application namespace for owner-checked projection with the Falcone
runtime-projection registration label and owner marker. Registration SHALL run under ephemeral hook
credentials, read both live labels before mutation, be idempotent for the same owner, and refuse
foreign/partial ownership. The ordinary active release SHALL retain only the namespace-local
Role/RoleBinding needed by the owner-derived projector service account. Uninstall, or an explicit
`disabled` transition with `unregister=true`, SHALL remove only the matching owner's registration;
normal/default disabled rendering SHALL remain hook-free.

#### Scenario: Managed mount is a non-subPath directory volume

- **WHEN** the chart renders `controlPlane`/`controlPlaneExecutor` in `managed` mode
- **THEN** each pod mounts the runtime-status ConfigMap as an optional source directory with no
  `subPath`, mounts an `emptyDir` at `/var/run/falcone/knative/`, and its tokenless guard atomically
  materializes only a current lease as the application-visible `status.json`

#### Scenario: Missing projection fails closed

- **WHEN** the runtime-status ConfigMap has not yet been projected into the application namespace
- **THEN** the optional source mount lets the pod start and the guard materializes an `unavailable`
  status document rather than a `ready` document

#### Scenario: Expired projection fails closed without a consumer edit

- **WHEN** a previously ready source projection passes `validUntil` without refresh
- **THEN** the tokenless guard atomically replaces the application-visible file with an unavailable
  v1 document within its bounded interval, without requiring the Falcone process to enforce age

#### Scenario: Application namespace is registered for owner-checked projection

- **WHEN** the chart renders in `managed` or `external` mode
- **THEN** the application namespace carries the Falcone runtime-projection registration label and
  owner marker that the projector requires before it will write the runtime-status ConfigMap

#### Scenario: Registration privilege is ephemeral and revocable

- **WHEN** registration succeeds, fails, the active release is uninstalled, or an operator requests
  the explicit active-to-disabled unregister transition
- **THEN** hook-scoped cluster credentials are deleted, foreign ownership is never overwritten, and
  only the matching release's registration labels are removed during revocation

#### Scenario: Disabled mode adds no mount or env change

- **WHEN** the chart renders in `disabled` mode
- **THEN** no runtime-status volume, mount, or `KNATIVE_RUNTIME_MODE` override beyond the disabled
  default is added to `controlPlane`/`controlPlaneExecutor`

#### Scenario: The projected ConfigMap is not Helm-owned by the umbrella

- **WHEN** the umbrella chart is rendered in `managed`/`external` mode
- **THEN** it templates no `falcone.knative-runtime/v1` ConfigMap object, leaving ownership to the
  `falcone-knative` lifecycle/projector and avoiding a cross-release ownership conflict

### Requirement: Chart and application versions are coordinated and upgrades never silently convert mode

The umbrella chart SHALL carry coordinated chart/application version metadata such that the
runtime-status mount contract matches the consuming Falcone application image that reads
`falcone.knative-runtime/v1`. A chart/application pairing whose contract does not match SHALL fail
closed — the application SHALL treat an unreadable or schema-mismatched status as unavailable rather
than ready. Lease freshness (`observedAt`/`validUntil`) SHALL be enforced by the chart-side tokenless
guard defined in the mount requirement, so no edit to the frozen Falcone consumer is required for
correctness; an additive Falcone-side `falcone.knative-runtime/v1` freshness check MAY be added later
as defense-in-depth but SHALL NOT be a release prerequisite of this change. Upgrading an existing
installation SHALL NOT convert its Knative runtime mode by default; the operator SHALL explicitly
select `external`, `disabled`, or a reviewed migration to `managed`.

#### Scenario: Coordinated versions render a matching contract

- **WHEN** the chart is rendered at a version coordinated with a supporting application image
- **THEN** the mounted status path, schema, and mode env match what the application consumes and the
  runtime can reach `ready`

#### Scenario: Upgrade preserves the selected mode

- **WHEN** an existing installation is upgraded without an explicit new runtime-mode decision
- **THEN** the chart preserves the previously selected mode and performs no default conversion to
  `managed`

#### Scenario: Contract mismatch fails closed honestly

- **WHEN** an incompatible chart/application pairing produces a status document the application cannot
  validate against `falcone.knative-runtime/v1`
- **THEN** the application reports the runtime unavailable with a bounded reason and never reports an
  unverified runtime as ready

#### Scenario: Lease enforcement needs no consumer edit

- **WHEN** `managed`/`external` mode is prepared for coordinated release
- **THEN** the chart-side tokenless guard enforces the `observedAt`/`validUntil` lease so a projector
  outage cannot leave a stale `ready`, and no edit to the frozen Falcone consumer is required for
  correctness
