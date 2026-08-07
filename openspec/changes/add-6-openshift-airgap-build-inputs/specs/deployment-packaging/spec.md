# deployment-packaging — spec delta for add-6-openshift-airgap-build-inputs

## ADDED Requirements

### Requirement: OpenShift source-build inputs are complete, deterministic and private-registry safe

When source-build mode is enabled, the chart SHALL accept a schema-validated
`global.openshiftBuild` contract containing optional per-service `baseImages`, generic `buildArgs`
and generic `env`, and SHALL render the resolved contract into every source-built service
BuildConfig without changing service identity, context, trigger, output ImageStream or tag semantics.

For this requirement, **connected source-build mode** means
`global.openshiftBuild.enabled=true` and `global.privateRegistry.enabled=false`.
**Private source-build mode** means both values are `true`. The effective base image for a service
is its nonempty `baseImages.<service>` value, otherwise the nonempty generic
`buildArgs.NODE_BASE_IMAGE`; a service-specific value has precedence. A private registry prefix is
the configured `global.privateRegistry.registry`, optionally ending in one slash, whose authority
is qualified by a dot or port (or is `localhost`) and which may include repository path segments.
After removing the optional trailing slash, an allowed private image starts with that complete
prefix plus `/`; therefore `registry.example/falcone/...` is allowed while
`registry.example.evil/...` and `registry.example-mirror/...` are not. The other allowed prefix is
exactly `image-registry.openshift-image-registry.svc:5000/`. Accepted image values SHALL be
syntactically valid repository references with an optional tag or `sha256` digest and no whitespace.
Every `buildArgs` and `env` key SHALL match the C-identifier grammar
`^[A-Za-z_][A-Za-z0-9_]*$`; empty, whitespace and punctuation-bearing keys SHALL fail template
validation. `NODE_BASE_IMAGE` is an allowed generic build-argument key, but a nonempty
service-specific base image replaces that one generic entry for that service exactly once. No other
generic key is reserved by this change.

#### Scenario: Falcone service base-image overrides are mapped

- **WHEN** an operator sets `global.openshiftBuild.baseImages.workflow-worker` to a private image reference
- **THEN** the workflow-worker BuildConfig contains `NODE_BASE_IMAGE` with exactly that reference in
  its build arguments, and no other service's value changes

#### Scenario: Unset service image preserves connected Dockerfile defaults

- **WHEN** `global.openshiftBuild.baseImages.<service>` and generic `buildArgs.NODE_BASE_IMAGE` are
  unset while private-registry mode is disabled
- **THEN** the chart emits no `NODE_BASE_IMAGE` argument and the Dockerfile default preserves PR #4
  byte-compatible rendering

#### Scenario: Defaults preserve connected installs

- **WHEN** source-build mode is enabled with no `global.openshiftBuild` overrides
- **THEN** each service uses its catalog Dockerfile default (`node:22-alpine`, or `node:22-slim`
  for workflow-worker), and the PR #4 BuildConfig/ImageStream/triggers remain compatible

#### Scenario: Generic arguments and environment are deterministic

- **WHEN** an operator supplies multiple `global.openshiftBuild.buildArgs` or `env` keys in arbitrary YAML order
- **THEN** every BuildConfig renders the same lexical key order, emits each value exactly once,
  and renders no null or duplicate entries

#### Scenario: Service-specific base image has explicit precedence

- **WHEN** generic `global.openshiftBuild.buildArgs.NODE_BASE_IMAGE` and
  `global.openshiftBuild.baseImages.<service>` are both configured
- **THEN** the service-specific image is emitted exactly once and the generic duplicate is omitted;
  all other generic arguments remain lexically ordered

#### Scenario: Invalid or unsafe input is rejected

- **WHEN** a map contains an unknown service, empty key, invalid image reference or non-string value
- **THEN** schema/template validation fails before resources are submitted to the cluster

#### Scenario: Pull-secret contract is validated

- **WHEN** any supplied `global.privateRegistry.pullSecretNames` entry is not a nonempty DNS-1123
  subdomain of at most 253 characters and 63 characters per label, or private-registry mode has no
  entries
- **THEN** schema validation fails before rendering and no BuildConfig is submitted

#### Scenario: Private registry credentials are referenced, never copied

- **WHEN** private source-build mode has one or more valid `global.privateRegistry.pullSecretNames`
  entries
- **THEN** all six BuildConfigs reference its first entry at
  `spec.strategy.dockerStrategy.pullSecret.name`, while rendered manifests contain neither secret
  data nor a generated Secret; later entries remain validated but are not BuildConfig fallbacks

#### Scenario: Private registry boundary fails closed

- **WHEN** private source-build mode has an empty or unqualified configured registry, a missing
  effective `NODE_BASE_IMAGE`, a public or unqualified image, or an image using a lookalike
  registry hostname
- **THEN** template validation fails before submission; every accepted effective base image starts
  with the exact configured private-registry prefix or the OpenShift internal-registry prefix

#### Scenario: Registry CA prerequisite is truthful

- **WHEN** a private registry uses a custom CA
- **THEN** NOTES/documentation require the administrator to create the named ConfigMap in
  `openshift-config` and reference it from `image.config.openshift.io/cluster.spec.additionalTrustedCA`,
  and the chart renders no per-BuildConfig CA field

#### Scenario: Fully private source build succeeds

- **WHEN** private source-build mode is rendered with `global.airgap.enabled=true`, the tracked
  `values/airgap.yaml` overlay, private base/package/source endpoints and the cluster CA prerequisite
- **THEN** a static render of every `image` field in Pod-spec containers/initContainers and every
  emitted `NODE_BASE_IMAGE` uses the configured private prefix or the exact internal prefix,
  existing PR #4 runtime/deployment wiring remains present, every enabled service BuildConfig
  completes, pushes its output ImageStream, and exposes
  logs sufficient to identify the resolved image and argument names without printing secret values

#### Scenario: Rollback removes overrides safely

- **WHEN** Helm renders an upgrade values revision that keeps private source-build mode enabled but
  removes every effective base-image override
- **THEN** validation rejects that revision before Helm submits any manifest; because the failed
  revision is not applied, the installed BuildConfigs, ImageStreams and Secret references remain
  unchanged. A separately validated revision that disables private or source-build mode MAY omit
  the overrides and restore connected Dockerfile defaults
