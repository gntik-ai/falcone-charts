## Why

The default `controlPlaneExecutor` and `workflowWorker` images declare the
non-root user by name, while their rendered container security contexts require
`runAsNonRoot: true` without a numeric identity. Kubernetes cannot prove that a
named image user is non-root and blocks all four default replicas with
`CreateContainerConfigError` before either Node process starts.

## What Changes

- Pin `runAsUser: 1000` and `runAsGroup: 1000` in the vanilla-Kubernetes
  container security-context defaults for only `controlPlaneExecutor` and
  `workflowWorker`, retaining the existing non-root and hardening settings.
- Keep the OpenShift restricted profile compatible with namespace-assigned SCC
  primary UIDs by reusing the existing `openshiftRestricted` normalization that
  removes fixed `runAsUser` and `runAsGroup` fields from both rendered
  workloads; the overlay itself does not require modification. The contract
  does not claim that restricted-v2 assigns a primary GID: `fsGroup` and
  supplemental groups remain governed by their separate SCC strategies.
- Define the supported numeric/null value shape in the chart schema and add
  default, OpenShift, schema, compatibility, and render-only upgrade/downgrade
  regression coverage. Disposable K3s proves the vanilla reproduction, upgrade,
  targeted downgrade, restore, and cleanup. OpenShift live acceptance remains
  blocked/not run because the only authorized context was Kubernetes, not
  OpenShift; no SCC runtime result is claimed.
- Update operator-facing release and security-context guidance with complete
  executable commands. Ship a standalone, fail-closed verifier scoped to exact
  release, namespace, and platform plus targeted historical-downgrade assets.
  The downgrade entrypoint, not the standalone verifier, verifies exactly one
  package obtained by its own exact `helm pull` from
  `oci://ghcr.io/gntik-ai/charts/in-falcone --version <version>` into a private
  temporary directory. It requires exactly one regular `.tgz` with the expected
  filename, metadata and version, verifies its exact byte SHA-256 against the
  mandatory digest input, preserves current release configuration through
  `--reuse-values` plus one small reviewed platform overlay, and passes only
  that verified local package to `helm upgrade`. Digest-from-output, alternate
  remote/package fallbacks and blind history-index-based `helm rollback` are
  forbidden. This is a workload-startup correction, not a chart-version bump,
  Keycloak change, API change, or data migration.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `deployment-and-operations`: Require the two default Node workloads to start
  under numeric non-root identities on vanilla Kubernetes while preserving
  OpenShift namespace-range `runAsUser` control, separate group strategies, and
  standalone live health verification plus an explicit package-bound
  historical-downgrade path.

## Impact

The change is limited to the authoritative chart defaults, a component-specific
umbrella-schema definition, render/schema regression tests, operator guidance,
and this OpenSpec package. It deliberately does not modify the generic
`component-wrapper` schema or the OpenShift values overlay. It changes only the
Pod template security contexts of `controlPlaneExecutor` and `workflowWorker`;
it does not change their images, replica counts, service accounts, network
paths, storage, credentials, tenant boundaries, or public APIs.

Live evidence was bounded to Kubernetes context `default` (K3s v1.36.1) and the
disposable namespace `falcone-node-uid-live-0814`, which was removed after the
test. The minimal fixture contained no PVC, Secret payload, application API, or
tenant resource, and shared staging was not mutated. Therefore it proves the
Node-workload startup and fail-forward lifecycle only; it does not claim
full-stack data, API, tenant-isolation, or OpenShift SCC acceptance.

Code evidence:

- `charts/in-falcone/values.yaml::controlPlaneExecutor.securityContext:3711-3753`
  leaves the pod context empty and enables `runAsNonRoot` without numeric
  `runAsUser`/`runAsGroup` for the container.
- `charts/in-falcone/values.yaml::workflowWorker.securityContext:3984-3994`
  enables `runAsNonRoot` at pod and container scope without a numeric identity.
- `charts/in-falcone/charts/component-wrapper/templates/workload.yaml::security-context-normalization:1-20,395-398`
  copies each component's container security context to the rendered workload
  and already strips fixed identity fields under `openshiftRestricted`.
- `deploy/openshift/values-openshift.yaml::Node-workload-security-contexts:158-166`
  selects OpenShift pod hardening for both affected components; the existing
  global restricted flag drives final identity removal in the wrapper.
- `tests/e2e/values-flows-e2e.yaml::Node-workload-security-context-overrides:55-63,99-108`
  demonstrates that the same Node workloads run with numeric UID 1000 when the
  test profile supplies the missing identity explicitly.
