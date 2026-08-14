## Context

The umbrella chart sends each component's `securityContext` through the shared
`component-wrapper`. The wrapper renders that map on the main container and,
when `global.podSecurity.openshiftRestricted` is true, removes fixed
`runAsUser`, `runAsGroup`, and `fsGroup` fields before rendering. The two
affected default images are Node images whose declared `USER node` cannot be
validated by kubelet as non-root without a numeric security-context identity.
The e2e values already prove the compatible Node identity is UID 1000. Under
OpenShift restricted-v2, the SCC `runAsUser` strategy and namespace UID range
control the primary UID. It does not assign a primary `runAsGroup`; `fsGroup`
and supplemental groups are governed by distinct SCC strategies.

Relevant code evidence:

- `charts/in-falcone/values.yaml::controlPlaneExecutor.securityContext:3711-3753`
- `charts/in-falcone/values.yaml::workflowWorker.securityContext:3984-3994`
- `charts/in-falcone/charts/component-wrapper/templates/workload.yaml::security-context-normalization:1-20,395-398`
- `charts/in-falcone/values.schema.json::component-security-context:2523-2528`
- `deploy/openshift/values-openshift.yaml::Node-workload-security-contexts:158-166`
- `tests/e2e/values-flows-e2e.yaml::Node-workload-security-context-overrides:55-63,99-108`

## Goals / Non-Goals

**Goals:**

- Make the unmodified vanilla-Kubernetes render start both default Node
  workloads under the images' verified numeric non-root identity.
- Preserve OpenShift restricted-v2 compatibility by leaving primary UID
  admission/assignment to the SCC and namespace UID range, without asserting an
  SCC-assigned primary GID.
- Make invalid root, named-user, and malformed UID/GID overrides fail schema
  validation before mutation.
- Provide deterministic render/schema compatibility plus render-only simulated
  upgrade and downgrade coverage plus bounded disposable vanilla-Kubernetes
  convergence, while keeping OpenShift live convergence explicitly blocked and
  unclaimed until an authorized OpenShift target exists.

**Non-Goals:**

- Changing any image, image build, tag, digest, replica count, application code,
  Keycloak setting, service account, authorization, isolation, storage, or API.
- Pinning numeric identities for unrelated workloads.
- Bumping or publishing the chart as part of this isolated implementation.
- Mutating a shared cluster or requiring a persistent-data migration.

## Decisions

### Pin UID and GID 1000 at container scope in the two component defaults

Set both numeric fields beside the existing container
`runAsNonRoot: true`. UID/GID 1000 matches the shipped Node images and the
existing e2e override, while container scope fixes kubelet's named-user check
without widening pod-level identity to init containers.

Alternative considered: set only `runAsUser`. That is sufficient for kubelet's
immediate error but leaves group identity implicit and makes the runtime
contract less deterministic. Setting the verified UID/GID pair is explicit and
testable.

Alternative considered: disable `runAsNonRoot`. This would mask the validation
error by weakening the security boundary and is rejected.

### Reuse the wrapper's existing OpenShift stripping without editing the overlay

Keep `global.podSecurity.openshiftRestricted` as the final render authority: it
strips fixed UID/GID values from both pod and container contexts. The existing
OpenShift overlay already selects that behavior, so neither the overlay nor the
wrapper template needs modification. A focused OpenShift render test proves the
final manifests omit the new defaults and retain platform-neutral hardening.
Live acceptance may assert that the effective primary UID belongs to the
namespace range. It must not assert an SCC-assigned primary GID; `fsGroup` and
supplemental groups, when present, are checked independently against their own
admission strategies.

Alternative considered: hard-code a high OpenShift UID. Namespace UID ranges
vary and restricted-v2 SCC, not the chart, controls `runAsUser`, so a fixed
value is not portable.

### Add component-specific schema constraints without tightening unrelated components

The umbrella schema will constrain the two top-level component
`securityContext.runAsUser` and `runAsGroup` fields to positive integers or
null through a definition applied exclusively to `controlPlaneExecutor` and
`workflowWorker`. The vendored `component-wrapper` schema remains unchanged:
tightening that generic contract would affect unrelated direct consumers and
would exceed this finding's scope.

Alternative considered: tighten the shared component definition globally.
Other components have distinct image identities and platform overlays, so a
global constraint would expand scope and compatibility risk.

### Prove behavior at rendered-manifest and schema boundaries

Regression tests will render default Kubernetes and OpenShift profiles, select
the two Deployment/container documents, and assert exact identity and retained
hardening. Schema tests cover positive overrides, explicit legacy/null
compatibility, and invalid zero/negative/string/fractional inputs. OpenShift
omission is covered separately through the unchanged restricted wrapper path.
Render-only upgrade and downgrade simulations assert that only Pod-template
identity changes occur and that the documented downgrade values preserve the
platform-specific manifest contract; they do not claim live rollout, runtime
UID, Availability, or event evidence.

Alternative considered: rely only on a live-cluster test. The live reproduction
is valuable acceptance evidence, but deterministic render and schema tests are
required to localize regressions and run without cluster mutation.

### Ship executable fail-closed verification and targeted historical downgrade

The chart package will include two executable operational boundaries rather
than documentation-only command fragments:

1. A standalone verifier accepts only exact release, namespace, and platform.
   Provenance is deliberately outside this read-only live-health boundary. It
   resolves each Deployment name with Helm's exact
   `printf("%s-%s") | trunc 63 | trimSuffix "-"` rule or rejects an input that
   cannot be resolved uniquely. It requires exactly two desired, updated,
   ready, and available replicas plus exactly two Running/Ready pods for each
   workload. Both platforms must retain full container hardening:
   `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
   `readOnlyRootFilesystem: true`, and `capabilities.drop: [ALL]`. Vanilla
   requires container `runAsUser: 1000` and `runAsGroup: 1000`. OpenShift
   requires both pod and container contexts to omit fixed `runAsUser` and
   `runAsGroup`, and every admitted pod's primary UID must be in the namespace
   range. Any mismatch, ambiguity, missing evidence, or
   `CreateContainerConfigError` exits non-zero with a stable non-secret code;
   the verifier reads no Secret payload.
2. Each platform-specific historical-downgrade entrypoint accepts namespace,
   release, an explicit allowed historical version, and the expected
   `sha256:<64 lowercase hex>` of the chart-package bytes. It creates a private
   temporary directory and executes exactly `helm pull
   oci://ghcr.io/gntik-ai/charts/in-falcone --version <version> --destination
   <temporary-directory>`. It requires exactly one regular file named
   `in-falcone-<version>.tgz`, requires its chart metadata to declare that same
   name/version, calculates SHA-256 over those local bytes, and stops before
   mutation on any mismatch. It never derives the digest from Helm/registry
   output, searches for another package, uses another remote source, or falls
   back to an OCI reference during upgrade. It passes only the verified pulled
   `.tgz` to `helm upgrade --reuse-values` with one small reviewed platform
   overlay, so current release configuration is preserved and only the Node
   identity compatibility values are overlaid. It never invokes blind
   history-index-based `helm rollback` and always invokes the standalone
   verifier after Helm. The vanilla overlay retains explicit positive UID/GID
   pins; the OpenShift overlay selects restricted identity omission and makes no
   primary-GID assignment claim.

The operator guide must show complete, copyable commands for both standalone
platform verifications and both downgrade entrypoints. Examples include every
required namespace, release, platform where applicable, historical version, and
byte-digest argument; placeholders are defined. The documented operator
pre-pull exists only to calculate the package-byte digest input. Each downgrade
helper independently repeats the exact OCI pull and verifies its newly pulled
bytes before mutation; it never consumes the operator's pre-pulled file.

Alternative considered: document `helm rollback <revision>`. A Helm history
index does not bind the operator to an inspected artifact, digest, or exact
values and can silently reintroduce the original named-user failure, so that
path is rejected.

### Bound live evidence to the topology actually exercised

The authorized live target was Kubernetes context `default`, K3s v1.36.1, in
the disposable namespace `falcone-node-uid-live-0814`. The exact shipped
`:0.3.0` images were first installed with historical container contexts that
retained `runAsNonRoot` but omitted numeric UID/GID. Both two-replica
Deployments remained 0/2 and exactly four of four pods reached
`CreateContainerConfigError` with kubelet's non-numeric `node`-user diagnostic.

A fail-forward upgrade of the same release to numeric 1000:1000 converged both
Deployments to exactly two desired, updated, ready, and available replicas and
four Running/Ready pods, with zero restarts and zero configuration errors. The
vanilla historical-downgrade exercise used an attested local fixture package
whose Chart metadata declared version 0.4.18 and whose `.tgz` byte SHA-256 was
verified. `helm upgrade --reuse-values` plus the small numeric overlay retained
the same healthy vector. The release was then restored to 0.4.19, uninstalled,
and its namespace deleted successfully.

That fixture deliberately contained no PVC, Secret payload, application API, or
tenant resource, so the run proves neither persistent-data nor application/API
migration. It proves only that the targeted Node Pod-template lifecycle does not
introduce such resources in the fixture. Shared staging was not mutated.
OpenShift was not available in the only authorized context, so no live SCC,
namespace UID-range, `fsGroup`, supplemental-group, or OpenShift downgrade claim
is made. The deterministic OpenShift render remains useful source evidence but
is not a substitute for an authorized live OpenShift acceptance run.

The authoritative complete source regression was exactly one invocation of
`bash tests/blackbox/run.sh`: 18 files, 407 tests, 407 passed, with zero failed,
skipped, cancelled, or todo cases, process exit 0, and TAP duration
1640525.277415 ms. Git status was byte-for-byte identical before and after the
runner, so the validation created no tracked or untracked repository artifact.

## Risks / Trade-offs

- [A custom replacement image does not use UID/GID 1000] → Document and test the
  supported positive numeric per-component override; never infer identity from a
  named image user.
- [A null compatibility override survives merge and renders as YAML null] →
  Assert legacy/null render simulations and separately prove the unchanged
  OpenShift wrapper path omits both keys at pod and container scope.
- [A shared-schema edit affects unrelated components] → Scope constraints to the
  two top-level component properties and run the full default/OpenShift render
  regression suite.
- [Downgrade silently reintroduces the kubelet error or discards current values]
  → Require the exact OCI/version pull into a private temporary directory,
  exactly one expected regular `.tgz`, exact metadata/version and byte hash, no
  output/remote/package fallback, `--reuse-values` plus a minimal reviewed
  overlay, and fail-closed live verification after `helm upgrade`.
- [Long Helm release names select the wrong resources] → Derive both Deployment
  names with the chart's exact truncation/trim rule and reject collisions or
  unresolved names before reporting health.
- [Diagnostics expose dynamic workload data] → Emit stable non-secret result
  codes and never print Secret payloads, full resource JSON, environment values,
  or command output that is not required for the bounded diagnosis.
- [OpenShift verification overstates SCC group behavior] → Verify fixed
  `runAsUser`/`runAsGroup` omission and namespace-range primary UID only;
  evaluate `fsGroup` and supplemental groups separately and never claim the SCC
  assigned a primary GID.
- [Disposable vanilla evidence is mistaken for full-stack or OpenShift proof] →
  Record the exact K3s fixture boundary, absent resource classes, successful
  cleanup, and non-mutation of shared staging; leave OpenShift live explicitly
  blocked/not run.

## Migration Plan

1. Validate the corrected default and OpenShift renders, schema-negative cases,
   and render-only legacy/downgrade simulations without cluster mutation.
2. Completed on disposable K3s: reproduce exactly four named-user configuration
   failures, fail-forward upgrade the same release to numeric 1000:1000, and
   verify both Deployments at 2/2 with four Running/Ready pods and no restart or
   configuration error.
3. Completed on disposable K3s: exercise vanilla historical downgrade with an
   attested version-0.4.18 fixture `.tgz`, byte SHA-256, `helm upgrade
   --reuse-values`, and the numeric overlay; restore 0.4.19 and prove uninstall
   plus namespace cleanup.
4. Blocked/not run: on an authorized disposable OpenShift target, confirm fixed
   identity omission, the effective primary UID within the namespace range, and
   the targeted downgrade. Do not assert an SCC-assigned primary GID. The
   current K3s context cannot satisfy this gate.
5. The complete black-box suite has passed; only after independent review,
   promote through the normal immutable chart release process. This isolated
   change does not select the release version.

Historical downgrade on vanilla Kubernetes receives namespace, release,
historical version and package-byte digest, performs its own exact OCI/version
pull, and uses `helm upgrade --reuse-values` only after exactly one expected
regular `.tgz` passes filename, package metadata, version and byte-SHA checks.
It adds the small vanilla overlay containing positive numeric UID/GID overrides.
OpenShift repeats the same independent pull/proof and adds the small restricted
overlay with fixed `runAsUser`/`runAsGroup` omitted. The operator may pre-pull
only to calculate the digest input; the helper must pull again. Never derive a
digest from command output, discover or substitute another package or remote,
pass an OCI reference to upgrade, or use blind `helm rollback` by history index.
After Helm, the standalone verifier accepts release/namespace/platform only and
accepts neither path until each Deployment has exactly two desired, updated,
ready, and available replicas, both pod cardinalities and full hardening match,
the platform-specific identity contract matches, and no affected pod reports
`CreateContainerConfigError`. No data restore, PVC operation, Secret rewrite,
or database migration is required.
