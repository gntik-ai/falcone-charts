# Falcone Charts

This repository contains the Helm deployment packaging for Falcone. Application
source code and container image publishing remain in
[gntik-ai/falcone](https://github.com/gntik-ai/falcone).

The umbrella chart is `charts/in-falcone`. Clone this repository as a sibling
of the application repository when using Falcone's development and validation
tooling:

```bash
git clone https://github.com/gntik-ai/falcone-charts.git ../falcone-charts
helm install falcone ../falcone-charts/charts/in-falcone \
  --namespace falcone --create-namespace
```

Fresh installation does not require a pre-existing database backup. Every
subsequent `helm upgrade` runs the applying webhook database authority Job,
including an action-none/no-op `0.3.1` replay, and therefore must set
`global.webhookDatabase.migration.backupVerified=true`,
`parityVerified=true`, and a non-secret `backupReference`. The chart rejects
the upgrade before emitting a manifest when any gate is absent.

The chart-release workflow validates and packages the independent
`charts/in-falcone` and `charts/falcone-knative` charts and publishes them as
OCI artifacts at `oci://ghcr.io/gntik-ai/charts/in-falcone` and
`oci://ghcr.io/gntik-ai/charts/falcone-knative`. Releases must use a new
`version` in each changed chart's `Chart.yaml`. The managed-runtime chart must
never be added as an umbrella dependency.

## External Secrets ownership modes

The umbrella supports two explicit External Secrets topologies:

| Mode | Values | Ownership boundary |
|---|---|---|
| Managed (default) | `eso.external-secrets.enabled=true` | Falcone installs and owns the ESO controller, webhook, cert-controller, and CRDs. |
| Externally managed | `eso.external-secrets.enabled=false` plus the exact `global.externalSecrets.operatorNamespace` and `operatorServiceAccount` | An administrator-owned ESO installation keeps its controller, webhook, and CRDs. Falcone renders only its own OpenBao-backed `ClusterSecretStore`, `ExternalSecret` objects, authentication ServiceAccount, and exact TokenRequest RBAC. No adoption occurs. |

Use externally managed ESO mode when the cluster already has a compatible External Secrets
release. The external controller namespace and Falcone's authentication
namespace must remain distinct. Leave `eso.eso.namespace` and
`openbao.eso.namespace` at their matching Falcone-owned default (`eso-system`)
unless the Falcone authentication namespace itself must be renamed; do not
point either value at the administrator-owned controller namespace.

```yaml
global:
  externalSecrets:
    operatorNamespace: external-secrets
    operatorServiceAccount: external-secrets

eso:
  external-secrets:
    enabled: false
```

Equivalent command-line overrides are:

```bash
helm upgrade --install falcone charts/in-falcone \
  --namespace falcone --create-namespace \
  --set eso.external-secrets.enabled=false \
  --set-string global.externalSecrets.operatorNamespace=external-secrets \
  --set-string global.externalSecrets.operatorServiceAccount=external-secrets
```

Before applying the Falcone custom resources, the preflight verifies that the
configured namespace contains an available ESO controller using the configured
ServiceAccount, that the identity exists, and that the `ClusterSecretStore` and
`ExternalSecret` APIs are registered. Externally managed mode
does not render a `Namespace`, controller workload, CRD, webhook-wait resource,
or blanket egress `NetworkPolicy` into the external namespace. The OpenBao
policy grants ingress from that namespace without taking ownership of anything
inside it.

Falcone still owns the cluster-scoped `ClusterSecretStore/openbao-backend`.
If an object with that name already belongs to another release, the existing
ownership preflight fails closed; there is no adoption flag that may bypass a
separate store-ownership conflict. The chart grants the exact external controller
identity `create` only on the `eso-system/eso-openbao-auth`
`serviceaccounts/token` subresource. The identity-only ServiceAccount receives no
Secret mutation or TokenReview permission. OpenBao's ServiceAccount receives only
`create` on `tokenreviews`. Keep `eso.eso.clusterOwnership.adoptExisting=false`;
`true` is rejected.

For chart 0.4.3 staging repair details—rotating OpenBao reviewer credentials,
FerretDB rollout safety, local-path limitations, six approved image digests, and
the revision-20 two-phase procedure—use the
[staging infrastructure repair runbook](charts/in-falcone/docs/staging-infrastructure-repair.md).

## Managed Knative Serving and Kourier (proposed)

> **Managed mode is proposed and unavailable.** The separate raw-upstream
> Knative Serving/Kourier lifecycle has not passed the required disposable
> remote OpenShift 4.21 acceptance. A chart render, offline test, package, or
> publication is not evidence that managed mode is supported.

The umbrella exposes one explicit, schema-validated choice at
`global.knativeRuntime.mode`:

| Mode | Use |
|---|---|
| `disabled` | Safe default. Function and hosted-MCP runtime gates remain closed; the umbrella installs no serving layer. |
| `external` | Use an administrator-owned compatible Knative/Kourier installation. Falcone discovers and invokes only an existing administrator-supplied canary and never adopts the runtime. |
| `managed` | Future separate cluster-admin lifecycle through `bin/falcone-knative` and the `falcone-knative` release. It remains unavailable until the published acceptance blockers close. |

The proposed fixed matrix is Knative Serving/Kourier 1.22.1 on Kubernetes 1.34
and OpenShift 4.21 under `restricted-v2`, without a custom SCC. Every other
combination fails closed before mutation. This is a Falcone-supported patched
upstream bundle boundary; it is **not** the Red Hat-supported OpenShift
Serverless product path. Organizations requiring that product boundary should
operate OpenShift Serverless themselves and select `external`.

Read the [proposed support and installation guide](docs/managed-knative-support.md)
for the mode/authority/Harbor decision, fixed matrix, status contract, and live
blockers. The [lifecycle runbook](docs/managed-knative-runbook.md) covers staged
readiness, one-minor upgrades and storage migration, compatibility-bounded
rollback/forward repair, retain uninstall, separately confirmed purge,
single-owner handoff, outage/recovery, secret-safe evidence, and cleanup.

## Webhook signing-key reference

Chart `0.3.1` requires a C-25-compatible control-plane image at version `0.3.1`
or later and owns the
platform webhook master-key reference at `global.webhookSigningKey`. The chart
never accepts key material in values or `controlPlane.env`. A fresh managed
installation uses these defaults and creates an immutable retained Secret from
inside the credential hook:

```yaml
global:
  webhookSigningKey:
    create: true
    secretName: in-falcone-webhook-signing-key
    secretKey: key
    adoption: { mode: none, requestId: "" }
    rotation:
      action: none
      requestId: ""
      sourceSecretName: ""
      sourceSecretKey: ""
      rotationId: ""
      recoveryWindowSeconds: 604800
```

For externally managed custody, set `create: false` and provision the named
Secret/key through the external manager before installation. The hook validates
it with exact-name read-only RBAC. Managed mode uses the same exact-name `get`
rule plus a separate namespace-scoped `create` rule; neither mode grants Secret
list/watch/update/patch/delete. Never place the value in a values file, `--set`,
rendered YAML, shell arguments, or evidence.

The base, kind, OpenShift, and local install profiles all select the compatible
`0.3.1` control-plane image for the runtime and both hook Jobs. The published
artifact is pinned in `values.yaml` to
`sha256:a6f90cd0c3e6e5ee5e783bba1d9fbce3c03be10590c85753cde3339fbcd4ad1d`
(published as `ghcr.io/gntik-ai/in-falcone-control-plane:0.3.1-c25-pr909-r2`
from the Falcone PR #909 release candidate); registry rewriting preserves that
digest. Every Helm revision also changes the non-secret control-plane pod-template annotation
`in-falcone.io/release-revision`, forcing new pods to re-run the database
sentinel/state check even when an external Secret reference is unchanged. The
marker is not derived from Secret bytes. If an external manager mutates bytes in
place, new pods fail readiness/startup while existing pods that already resolved
the matching context remain safe; use a new Secret identity for supported
rotation.

Existing pre-0.3.1 ciphertext must first use an upgrade-only explicit
`adoption.mode: legacy` request with the exact historical value supplied through
an external Secret. Canonical `rotate`, forward `recover`, and `finalize` are
separate pre-upgrade maintenance actions with unique request/rotation IDs and a
distinct source/target Secret identity. They require a tested database backup,
matching retained key custody, and a maintenance window. Do not use Helm rollback
across a key transition; use the fixed chart's forward recovery lifecycle. The
detailed [operator runbook](https://github.com/gntik-ai/falcone/blob/main/docs-site/operations/webhook-signing-key-lifecycle.md)
defines the complete field/cross-field contract, preflight, backup/key-custody
coupling, maintenance drain, status and secret-safe evidence, retry/recovery,
restore, finalization/deletion boundaries, and fail-closed incident response.
Its image/chart publication and live rehearsal requirements are release gates
outside this code-adjacent configuration reference.

## Webhook PostgreSQL principals

C-25 preserves the global control-plane `DB_URL`/`PG*` contract while adding
four Secret-backed webhook-only DSNs for schema, runtime, encrypted writes, and
lifecycle work. A dedicated credential hook creates or read-only validates the
immutable retained credential Secret; a PostgreSQL 16 authority bootstrap
establishes the exact role graph and bounded ownership handoff before
application DDL/listen. The PostgreSQL administrator Secret is referenced only
by that bootstrap path, never by the control-plane or lifecycle Job.
Before that bootstrap can mutate any role, membership, schema ACL, or owner, it
authenticates every pre-existing bounded LOGIN through its retained credential
and rejects a mismatch without changing database authority.

The credential hook's ServiceAccount, Role, RoleBinding, support ConfigMap, and
Job are removed after the complete hook succeeds. With Helm 4.1.4, a later
credential Job failure also applies `hook-succeeded` cleanup to the preceding
successful support hooks: the ServiceAccount, Role, RoleBinding, and ConfigMap
are removed, while the failed Job and its owned Pod remain as bounded evidence.
On retry, `before-hook-creation` clears any same-name remnants and Helm
recreates the support hooks before the Job. Ordinary upgrades render no
collection-wide Secret or ConfigMap create permission.

Legacy managed upgrades explicitly set
`global.webhookDatabase.migration.firstHandoff=true` with the backup/parity
evidence gates. A retained non-secret initialization marker permits that
bootstrap once and prevents a missing credential Secret from being regenerated
when old values are replayed.

The same three evidence gates are mandatory for every later applying upgrade,
even when `firstHandoff=false`, the signing-key lifecycle action is `none`, and
the database graph is expected to be unchanged:

```bash
helm upgrade falcone charts/in-falcone \
  --namespace falcone \
  --set deployment.upgrade.currentVersion=0.3.1 \
  --set global.webhookDatabase.migration.firstHandoff=false \
  --set global.webhookDatabase.migration.backupVerified=true \
  --set global.webhookDatabase.migration.parityVerified=true \
  --set global.webhookDatabase.migration.backupReference=BACKUP-EVIDENCE-ID
```

See
[WEBHOOK-DATABASE-AUTHORITY.md](charts/in-falcone/WEBHOOK-DATABASE-AUTHORITY.md)
for managed/external custody, fresh install, the required backup/parity gate,
legacy ownership handoff, TLS verification, secret-safe posture checks,
failure codes, forward recovery, and restore-only rollback limitations.

> **Upgrade compatibility:** chart `0.3.1` accepts truthful source versions `0.2.0`,
> `0.3.0`, and `0.3.1` in `deployment.upgrade.supportedPreviousVersions`. This
> permits the initial transition and later `0.3.1` rotation, recovery,
> finalization, and action-none cleanup upgrades. Unsupported sources and
> downgrades remain rejected. Do not falsify `deployment.upgrade.currentVersion`
> or disable validation to bypass this gate.

## History

Chart and deployment-value history was extracted from
[gntik-ai/falcone](https://github.com/gntik-ai/falcone) with `git filter-repo`.
The retained commits preserve the evolution of the moved paths while excluding
application source files from this repository.

## Fully disconnected OpenShift source builds (chart 0.4.1)

This section is for an OpenShift platform operator building the six Falcone
application images from a local GitLab mirror while the cluster has no public
network route. It applies to chart `0.4.1` and later. The chart creates
OpenShift `BuildConfig`/`ImageStream` pairs; it does not install GitLab,
Harbor, a registry, or a cluster-wide CA. Those services and their credentials
must already exist, or be operated separately.

### Prerequisites and source preparation

Prepare all of the following before enabling builds:

* An OpenShift project and a GitLab repository reachable from the build pods.
  Mirror the Falcone source repository, including the Dockerfiles under
  `apps/`, and expose a stable branch or tag through `global.openshiftBuild.git.ref`.
* A private registry reachable from the OpenShift image-builder network path,
  or an approved internal mirror. Mirror every runtime image referenced by the
  selected values profile, plus the Node base images used by the six
  Dockerfiles. The chart's `values/airgap.yaml` is a starting-point list for
  runtime repositories; replace its example registry and repository names with
  your own inventory.
* A source Secret, if GitLab requires authentication. The Secret named by
  `global.openshiftBuild.git.sourceSecret` must be usable by the OpenShift
  builder for the configured Git URI.
* A registry pull Secret in the release namespace. Put the preferred Secret
  first in `global.privateRegistry.pullSecretNames`; the chart attaches only
  element zero to each Docker build. Additional names are retained for other
  chart consumers but are not fallback credentials for BuildConfigs.
* A GitLab webhook Secret in the release namespace. Create it with key
  `WebHookSecretKey` and reference the Secret name with
  `global.openshiftBuild.webhookSecret`. Do not put its value in values files,
  `--set` arguments, rendered manifests, logs, or support bundles.

For an air-gapped package mirror, publish the Node package proxy inside the
network and pass its URL as a build environment variable, for example
`NPM_CONFIG_REGISTRY=https://npm.mirror.example/repository/npm/`. This is an
OpenShift build environment variable; it is not a chart runtime environment
variable and it does not make the package mirror public.

### Base-image, argument, and environment contract

The global block is deliberately shared by all six BuildConfigs:

```yaml
global:
  privateRegistry:
    enabled: true
    registry: registry.example.internal
    pullSecretNames: [in-falcone-registry]
  openshiftBuild:
    enabled: true
    git:
      uri: https://gitlab.example.internal/platform/falcone.git
      ref: release-0.4.1
      sourceSecret: falcone-gitlab-source
    webhookSecret: falcone-build-webhook
    tag: 0.4.1-airgap
    baseImages:
      control-plane: registry.example.internal/library/node:22-alpine
      control-plane-executor: registry.example.internal/library/node:22-alpine
      web-console: registry.example.internal/library/node:22-alpine
      workflow-worker: registry.example.internal/library/node:22-slim
      mcp-runtime: registry.example.internal/library/node:22-alpine
      fn-runtime: registry.example.internal/library/node:22-alpine
    buildArgs:
      HTTP_PROXY: http://proxy.example.internal:8080
    env:
      NPM_CONFIG_REGISTRY: https://npm.mirror.example/repository/npm/
```

`baseImages` is service-specific and has precedence over the generic
`buildArgs.NODE_BASE_IMAGE`. If a service entry is non-empty, the chart writes
that value as the service BuildConfig's `NODE_BASE_IMAGE` argument. If it is
empty, no service override is added and the generic build-argument map is used
unchanged. If neither supplies `NODE_BASE_IMAGE`, each Dockerfile's connected
default remains authoritative (`node:22-alpine`, except
`workflow-worker`, which defaults to `node:22-slim`). Do not use a service key
outside the six names above in `baseImages`; schema validation rejects it.

That fallback applies only to connected source builds. When
`global.privateRegistry.enabled=true`, the chart fails closed unless every
service resolves an effective `NODE_BASE_IMAGE` from its service override or
the generic build argument. Each effective reference must begin with the exact
configured `global.privateRegistry.registry` prefix or the OpenShift internal
registry prefix; public, unqualified, and lookalike-host references are
rejected before any BuildConfig reaches the API server.

Use a qualified registry authority containing a dot or port, or `localhost`;
an optional repository/project path and one trailing slash are supported. For
example, `registry.example.internal/falcone` is valid, while `library` is not a
registry authority and cannot establish a disconnected boundary.

`buildArgs` and `env` are string maps applied to every BuildConfig. Keys must
be valid C identifiers. Keep proxy credentials out of these maps; use a
Secret-backed mechanism supported by your build policy instead. Values are
visible to OpenShift build metadata and should therefore be treated as
non-secret configuration.

Every entry in `global.privateRegistry.pullSecretNames` must be a non-empty
DNS-1123 Kubernetes Secret name: at most 253 characters overall and 63 per
dot-separated label. The first entry is the BuildConfig pull Secret; later
entries are not BuildConfig fallbacks.

The chart renders six ImageStreams (`in-falcone-control-plane`,
`in-falcone-control-plane-executor`, `in-falcone-web-console`,
`in-falcone-workflow-worker`, `in-falcone-mcp-runtime`, and
`in-falcone-fn-runtime`) and six serial BuildConfigs with matching names.
Each uses Docker strategy, the corresponding `apps/*/Dockerfile`, the GitLab
trigger Secret, and the configured output tag. The runtime deployment consumes
these ImageStreams through the source-build image identity behavior inherited
from Falcone charts PR #4. See [Falcone PR #930](https://github.com/gntik-ai/falcone/pull/930)
for the application-side Dockerfile and catalog contract, and
[falcone-charts issue #6](https://github.com/gntik-ai/falcone-charts/issues/6)
for the chart-side delivery history.

### Custom CA: cluster prerequisite, not a chart value

For a private registry signed by an internal CA, create the CA ConfigMap in
the `openshift-config` namespace and reference it from the cluster image
configuration. This requires cluster-admin authority and is intentionally not
rendered by this chart:

```bash
oc -n openshift-config create configmap in-falcone-registry-ca \
  --from-file=registry-ca.crt=./registry-ca.crt
oc patch image.config.openshift.io/cluster --type=merge \
  -p '{"spec":{"additionalTrustedCA":{"name":"in-falcone-registry-ca"}}}'
oc get image.config.openshift.io/cluster \
  -o jsonpath='{.spec.additionalTrustedCA.name}{"\\n"}'
```

The ConfigMap name may instead be set as
`global.privateRegistry.caBundleConfigMap`; when private-registry mode is
enabled, the chart's validation notes require that same-named ConfigMap to
exist in `openshift-config` and be referenced by
`image.config.openshift.io/cluster.spec.additionalTrustedCA`. A ConfigMap in
the release namespace is not a substitute. Follow your platform's documented
image-config rollout and verify node/build readiness before starting builds.

### Install, render, and verify without exposing secrets

Create the release namespace and credentials out of band, then render once
before installing:

```bash
oc new-project falcone-airgap
helm template falcone charts/in-falcone \
  --namespace falcone-airgap \
  -f charts/in-falcone/values/airgap.yaml \
  -f values-openshift-airgap.yaml \
  --set global.openshiftBuild.enabled=true \
  > /tmp/falcone-airgap.yaml
rg -n 'kind: (BuildConfig|ImageStream)|NODE_BASE_IMAGE|NPM_CONFIG_REGISTRY' \
  /tmp/falcone-airgap.yaml
helm upgrade --install falcone charts/in-falcone \
  --namespace falcone-airgap --create-namespace \
  -f charts/in-falcone/values/airgap.yaml \
  -f values-openshift-airgap.yaml
```

Do not grep, print, or archive Secret data. Verify object state and build
completion with metadata-only commands:

```bash
oc -n falcone-airgap get buildconfig,imageStream
oc -n falcone-airgap start-build in-falcone-control-plane --follow
oc -n falcone-airgap get builds -o custom-columns=NAME:.metadata.name,PHASE:.status.phase
oc -n falcone-airgap describe buildconfig in-falcone-workflow-worker
oc -n falcone-airgap get imagestreamtag in-falcone-fn-runtime:0.4.1-airgap
helm -n falcone-airgap status falcone
```

Use the webhook URLs printed by `helm status`/the chart NOTES only with your
GitLab administrator. Retrieve the webhook value only in a protected shell
when configuring GitLab; never include it in a command transcript.

### Failure modes and recovery

* **`git.uri is required` or a source clone fails:** set a reachable URI and
  ref, confirm the source Secret grants the builder access, and retry the
  failed BuildConfig after correcting the mirror.
* **`ImagePullBackOff`, x509 errors, or registry authentication failures:**
  confirm `pullSecretNames[0]` exists in the release namespace, the registry
  hostname matches the image references, and the cluster
  `additionalTrustedCA` configuration is rolled out. The chart cannot repair
  cluster CA configuration.
* **Node base-image pull fails:** mirror the exact architecture-compatible
  image, use a fully qualified reference in `baseImages`, and confirm the
  builder can pull it with the first registry Secret. A private override does
  not alter Dockerfile package-manager behavior.
* **A package install attempts the public internet:** set the internal
  `NPM_CONFIG_REGISTRY` (or your organization’s supported package-mirror
  variable) under `global.openshiftBuild.env`, then start a fresh build.
* **Webhook does not trigger:** verify the Secret key is exactly
  `WebHookSecretKey`, the GitLab endpoint targets the correct BuildConfig, and
  the project can reach the OpenShift API. A manual `oc start-build` is a safe
  diagnostic.
* **The web console build needs a different memory limit:** use
  `global.openshiftBuild.serviceResources.web-console`; it is merged over the
  global build resources for that service only. The current schema exposes no
  other service-specific resource key, so size all other builds with the shared
  `global.openshiftBuild.resources` values.

### Disable, rollback, and cleanup

Setting `global.openshiftBuild.enabled=false` stops rendering the six
BuildConfigs and ImageStreams on the next Helm revision; it does not delete
already-pushed image content or undo deployments that already reference an
ImageStreamTag. Retain or remove those objects according to your image-retention
policy, then deploy immutable application images before disabling source builds.

To change a base image, Git ref, tag, or mirror, update the values and run a
new Helm upgrade; BuildConfigs remain `SerialLatestOnly`, so an in-flight build
finishes before the latest one starts. Do not use Helm rollback to recover a
partially completed image migration. Restore the prior values, rebuild the
known-good tag, and verify each ImageStreamTag and deployment rollout. Delete
disposable build evidence only after collecting metadata and logs that contain
no credentials.

Removing all base-image overrides while private source-build mode remains
enabled is intentionally rejected, because it would restore the public
Dockerfile defaults. To return to connected defaults, disable private-registry
mode or source-build mode in the same validated values revision.
