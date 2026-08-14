# Node workload security identity

`controlPlaneExecutor` and `workflowWorker` use Falcone's Node images. Their
default container security context is explicit:

```yaml
runAsUser: 1000
runAsGroup: 1000
runAsNonRoot: true
```

The numeric pair is required on vanilla Kubernetes because kubelet cannot
prove that a named image user is non-root from `runAsNonRoot` alone. Keep the
existing hardening fields (`allowPrivilegeEscalation: false`,
`readOnlyRootFilesystem: true`, and dropping all capabilities).

For a custom image with a different verified non-root identity, override both
`securityContext.runAsUser` and `securityContext.runAsGroup` with positive
integers. The chart schema rejects zero, negative, fractional, string, and
named-user values for these two components.

For OpenShift restricted-v2, apply `values/platform-openshift.yaml`. With
`global.podSecurity.openshiftRestricted=true`, the component wrapper removes
fixed UID/GID values from the rendered Pod and container security contexts so
the namespace SCC assigns the allowed `runAsUser` range. `fsGroup` and
supplemental groups are separate SCC-controlled fields; this chart does not
promise a primary GID. Do not hard-code an OpenShift UID or GID.

## Upgrade and rollback verification

After upgrading, verify both Deployments have two available replicas and no
affected Pod reports `CreateContainerConfigError`. On vanilla Kubernetes,
confirm the rendered Pod templates contain `runAsUser: 1000` and
`runAsGroup: 1000`:

```bash
kubectl -n "$NAMESPACE" get deploy "$RELEASE-control-plane-executor" \
  "$RELEASE-workflow-worker"
kubectl -n "$NAMESPACE" get pods -o wide
kubectl -n "$NAMESPACE" get events --field-selector reason=Failed
```

A rollback is accepted only with explicit positive numeric UID/GID overrides
for both Node workloads and the same availability/error gates. On OpenShift,
retain the restricted overlay and confirm rendered contexts omit fixed UID/GID
values; SCC assignment is the source of truth. If either Deployment is
unavailable or an affected Pod has `CreateContainerConfigError`, stop and fail
closed.

The fail-forward downgrade helpers are `tools/downgrade-node-workloads-vanilla.sh`
(`--version 0.4.18 --digest "$PACKAGE_DIGEST"`) and `tools/downgrade-node-workloads-openshift.sh`
(`--version 0.4.18 --digest "$PACKAGE_DIGEST"`); both use the immutable 0.4.18 OCI artifact with platform values and invoke
`tools/verify-node-workloads.sh`. They use fail-forward `helm upgrade` only;
the verifier rejects unavailable replicas, unexpected
containers, fixed OpenShift identities, or `CreateContainerConfigError`.

Live verification examples:

`$PACKAGE_DIGEST` is the SHA-256 digest of the downloaded chart package file
(`.tgz` bytes), not an OCI registry manifest digest.

```bash
set -euo pipefail
NAMESPACE="<namespace>"
RELEASE="<helm-release>"
PACKAGE_TGZ=$(mktemp -d)/in-falcone-0.4.18.tgz
helm pull oci://ghcr.io/gntik-ai/charts/in-falcone --version 0.4.18 --destination "$(dirname "$PACKAGE_TGZ")"
PACKAGE_TGZ="$(dirname "$PACKAGE_TGZ")/in-falcone-0.4.18.tgz"
PACKAGE_DIGEST="sha256:$(sha256sum "$PACKAGE_TGZ" | awk '{print $1}')"
tools/downgrade-node-workloads-vanilla.sh --namespace "$NAMESPACE" --release "$RELEASE" --version 0.4.18 --digest "$PACKAGE_DIGEST"
tools/downgrade-node-workloads-openshift.sh --namespace "$NAMESPACE" --release "$RELEASE" --version 0.4.18 --digest "$PACKAGE_DIGEST"
```

```bash
tools/verify-node-workloads.sh --namespace "$NAMESPACE" --release "$RELEASE" --platform vanilla
tools/verify-node-workloads.sh --namespace "$NAMESPACE" --release "$RELEASE" --platform openshift
```
