# Managed Knative Serving and Kourier: proposed support and installation guide

> **Status: PROPOSED AND UNAVAILABLE.** This guide describes the contract proposed by
> [falcone-charts issue 8](https://github.com/gntik-ai/falcone-charts/issues/8). It is grounded in
> static implementation and OpenSpec evidence (E1/E2), not a supported live installation. Do not
> select `managed` for a production or shared cluster. Managed support remains unavailable until a
> disposable remote OpenShift 4.21 cluster with Kubernetes 1.34 and real cluster-admin authority has
> passed clean-install, disconnected-Harbor, `restricted-v2`, upgrade, recovery, isolation, Falcone
> issue 933, and cleanup acceptance. A merged chart or a successful offline test is not that proof.

Last static verification: 2026-08-07. Live verification: **not performed; blocked as described in
[Live acceptance blockers](#cleanup-and-live-acceptance-blockers).** The repository's initial
proposed `falcone-knative` chart and lifecycle executable are version `0.1.0`; publication of that
artifact does not change the support status. At this verification point, the executable SHA-256 is
`d5516166302c9d418ac4509b4d4e9bafc270334acd5b34fc261e5ae5c5363377`; verify it from the packaged
provenance rather than treating this page as the checksum authority.

In command examples, every `<angle-bracketed>` token is a required placeholder. Replace it with an
approved non-secret value before execution; do not paste the brackets into a shell.

## Audience and outcome

This guide is for:

- **P18 platform installers/release engineers**, who choose a runtime mode, verify the supply chain,
  and prepare the separate cluster-scoped lifecycle phase;
- **P3 platform operators/SREs**, who need an observable readiness and recovery boundary;
- **P4 security/compliance auditors**, who verify provenance, ownership, authority, isolation, and
  secret-safe evidence;
- **P17 documentation-only newcomers**, who must be able to make a safe mode decision without source
  archaeology; and
- **P8 workspace developers, P7 workspace/MCP owners, P12 service workloads, P10 read-only viewers,
  and P13 adjacent-tenant actors**, whose Function and hosted-MCP behavior depends on the selected
  runtime but who never receive cluster-scoped lifecycle authority.

The outcome is an explicit choice among `managed`, `external`, and `disabled`, with one owner and an
honest runtime status. This guide does not grant permission to install the proposed managed bundle.

## Choose exactly one mode

`charts/in-falcone` exposes `global.knativeRuntime.mode`. Its only valid values are `managed`, `external`,
and `disabled`; the safe default is `disabled`. An upgrade must preserve the installation's existing
choice unless the operator records an explicit new decision. It must never silently convert an
existing external runtime to managed ownership.

| Mode | Choose it when | Serving-layer mutations | Authority and ownership | Application result |
|---|---|---|---|---|
| `disabled` | Functions and hosted MCP are intentionally unavailable, or managed/external readiness is not proven. This is the default. | None. No lifecycle release, runtime-status mount, CRD, cluster RBAC, or admission object is created by the umbrella chart. | Namespace release authority only. It does not remove an already installed runtime. | Falcone reports the dependency disabled and fails Function/hosted-MCP operations closed. |
| `external` | An administrator already operates compatible Knative Serving and Kourier, including an OpenShift Serverless Operator installation. | Falcone performs discovery plus read/invoke of one administrator-supplied, pre-existing canary only. It must not create, patch, adopt, or delete external resources. | The external administrator remains the sole owner. An absent, unreadable, incompatible, or uninvokable canary is `unverified`, never `ready`. | Gates open only after the existing canary and version are verified. |
| `managed` | In the future, only for a clean, accepted matrix cluster that has no Knative/OLM/Operator/raw/unknown owner and is assigned exclusively to Falcone's separate lifecycle. | The client-side `falcone-knative` executable performs a separately authorized cluster-scoped, staged lifecycle. The umbrella remains namespace-scoped and never embeds the bundle. | Real cluster-admin authority is required. Exactly one Falcone owner is acquired after zero-mutation preflight. No implicit adoption. | Gates open only after CRDs, admission, Serving, Kourier, and an isolated smoke `ksvc` pass. **Currently unavailable.** |

Use the owner value consistently across the lifecycle release and the application namespace. The
umbrella's `global.knativeRuntime.owner` defaults to the Helm release name; set it explicitly when the
lifecycle owner is different. The projected status ConfigMap name is fixed as
`falcone-knative-runtime`, with data key `status.json`. The fixed name is part of the
namespace-scoped RBAC boundary and cannot be overridden.

The umbrella mode selection is explicit:

```bash
# Namespace-scoped application selection only. These commands do not install Knative.
helm upgrade --install <falcone-release> charts/in-falcone \
  --namespace <falcone-namespace> \
  --set-string global.knativeRuntime.mode=disabled

helm upgrade --install <falcone-release> charts/in-falcone \
  --namespace <falcone-namespace> \
  --set-string global.knativeRuntime.mode=external \
  --set-string global.knativeRuntime.owner=<external-lifecycle-owner>
```

The equivalent `managed` value is intentionally not presented as an executable production install
command while the mode is unavailable. Rendering it offline is permitted for review:

```bash
helm template <falcone-release> charts/in-falcone \
  --namespace <falcone-namespace> \
  --set-string global.knativeRuntime.mode=managed \
  --set-string global.knativeRuntime.owner=<proposed-lifecycle-owner> > /tmp/falcone-managed-review.yaml
```

Offline rendering must show only application wiring and namespace registration for this capability.
It must not add a Knative/Kourier CRD, `KnativeServing`, OLM `Subscription`, Knative/Kourier
cluster RBAC, or Knative admission webhook from the umbrella chart. The umbrella may still contain
unrelated CRDs, RBAC, and webhooks belonging to Falcone's existing dependencies.

## Fixed compatibility and support matrix

The first proposed managed bundle fails closed unless every matrix cell matches exactly:

| Layer | Only proposed combination | Behavior outside the matrix |
|---|---|---|
| Knative Serving | `1.22.1` | Preflight rejects before mutation. |
| Kourier | the reviewed Kourier bundle coordinated with `1.22.1` | Preflight rejects before mutation. |
| Kubernetes | `1.34` | Preflight reports detected and supported versions, then rejects before mutation. |
| OpenShift | `4.21` | Any other OpenShift version is unvalidated and rejected before mutation. |
| OpenShift admission | default `restricted-v2` | A custom SCC, privileged service account, fixed UID/GID exemption, or alternative policy is unsupported. |
| Architecture/topology | only those recorded by the future disposable acceptance evidence | Absence from the evidence is not implied support. |

The OpenShift render removes Kourier's upstream fixed `runAsUser: 65534` and
`runAsGroup: 65534`. It computes no replacement UID or GID, allowing OpenShift to assign an identity
from the namespace range. Every container must retain `runAsNonRoot: true`,
`allowPrivilegeEscalation: false`, `seccompProfile.type: RuntimeDefault`, and
`capabilities.drop: [ALL]`. No custom SCC is part of this path.

### Falcone support is not Red Hat Serverless support

The proposed managed release is a Falcone-patched bundle of raw upstream Knative Serving and
Kourier manifests. It uses no OLM object and installs no OpenShift Serverless Operator. If accepted,
Falcone would support that exact bundle only on the published matrix. It must not be represented as
the Red Hat-supported OpenShift Serverless product path.

If an organization requires the Red Hat product/support boundary, its administrator should operate
OpenShift Serverless as the sole owner and Falcone should use `external`. Never point `managed` at
an Operator-owned installation, and never run both reconcilers.

## Authority and scope boundary

Managed lifecycle work is a distinct deployment phase because it owns cluster-scoped CRDs, cluster
RBAC, admission webhooks, Knative namespaces, controllers, and the Kourier data plane.

- Run the client-side executable under the human installer's current, verified cluster identity. It
  does not grant privileges and does not install a long-lived Falcone lifecycle Operator.
- A namespace editor, Falcone `superadmin`, tenant owner, workspace owner, or service account is not
  thereby a Kubernetes/OpenShift cluster administrator.
- `preflight` must check every required verb and resource before mutation. A missing cluster-scoped
  permission fails the operation and names the missing authority.
- The pinned bundle fixes its lifecycle namespace to `knative-serving`; supplying any other
  `--status-namespace` is rejected before discovery or mutation because the staged object identities
  and namespace-scoped health RBAC are not relocatable.
- P3 may operate the lifecycle only under separately granted platform authority. P4 and P10 receive
  bounded read-only status/evidence, not a mutation path.
- P8, P7, and P12 interact with authorized Function/MCP interfaces. They do not receive Knative
  credentials or serving-layer metadata.
- P13 requests fail closed without revealing whether another tenant's Knative service, revision, or
  dependency state exists.

## Prerequisites for a future managed acceptance or install

Do not continue unless all items are true and evidenced:

1. The target is disposable, is not shared/staging/production, and is positively identified by API
   URL, cluster UID, OpenShift infrastructure name, and infrastructure ID.
2. The target reports Kubernetes 1.34 and OpenShift 4.21 and enforces `restricted-v2` without a
   custom SCC.
3. The caller has real cluster-admin authority for every required CRD, namespace, cluster RBAC,
   admission, Service, Deployment, ConfigMap, and discovery operation.
4. Read-only discovery finds no OLM/OpenShift Serverless, raw-manifest, other-Falcone, unknown,
   partial, or ambiguous owner. Any existing serving resource requires `external`, `disabled`, or a
   reviewed quiesced handoff/migration; it must not be adopted.
5. The `falcone-knative` chart and executable versions are coordinated with the `in-falcone` chart
   and the Falcone application image that consumes `falcone.knative-runtime/v1` at
   `/var/run/falcone/knative/status.json`.
6. The release package contains the upstream revisions, original and patched manifest SHA-256s,
   complete image lock, licenses, SBOMs, and executable SHA-256. Every workload image, including
   Envoy, is pinned by `@sha256:` and contains no retained mutable tag.
7. For disconnected operation, every locked image is already mirrored to Harbor by digest, registry
   trust/pull credentials are installed through an approved secret channel, and the cluster has no
   public-registry fallback route.
8. Backups and restore procedures cover the Knative CRDs, stored custom resources, configuration,
   image lock, and Falcone workload state. Backup identifiers are non-secret and restorable.
9. Maintenance, outage, rollback/forward-repair, retain-uninstall, and cleanup owners are named.
10. The live acceptance blockers at the end of this guide have been closed by independently reviewed
    evidence. Until then, stop after offline validation.

## Verify the proposed release offline

These checks read repository/package files and render locally. They do not prove a cluster install.

```bash
helm lint --strict charts/falcone-knative
helm lint --strict charts/in-falcone

helm template falcone-knative charts/falcone-knative \
  --namespace knative-serving \
  --kube-version 1.34.0 > /tmp/falcone-knative.yaml
helm template falcone charts/in-falcone \
  --namespace falcone-review > /tmp/in-falcone.yaml

bin/falcone-knative --version
bin/falcone-knative --help
python3 charts/falcone-knative/tools/validate_bundle.py
bash tests/blackbox/run.sh
```

The black-box suite is offline: it uses a non-routable kubeconfig and process-isolated fake
`kubectl`, `helm`, and `curl` clients. It validates the public package and command behavior but is not
E3-E6 live evidence.

Inspect the packaged chart rather than trusting only the working tree:

```bash
mkdir -p /tmp/falcone-chart-review
helm package charts/falcone-knative --destination /tmp/falcone-chart-review
helm package charts/in-falcone --destination /tmp/falcone-chart-review
(
  cd /tmp/falcone-chart-review
  sha256sum ./*.tgz > SHA256SUMS
  sha256sum --check SHA256SUMS
)
tar -tzf /tmp/falcone-chart-review/falcone-knative-<chart-version>.tgz
```

The archive inventory must contain a provenance lock, image lock, license inventory, SBOMs, and the
versioned lifecycle executable identity. Match the executable SHA-256 to the value in the lock and,
after a future successful smoke stage, to `lifecycleExecutable.sha256` in the Helm-owned lifecycle
status. A checksum proves integrity against the supplied checksum; it is not by itself publisher
identity or live compatibility evidence.

## Harbor and disconnected preparation

Disconnected mode is an explicit supply-chain workflow, not merely a registry prefix.

1. Extract the complete image lock from the exact packaged `falcone-knative` chart. Reject the
   package if any image lacks `@sha256:<64-hex-digits>` or if a repository includes a tag before the
   digest.
2. Mirror each source manifest to the approved Harbor project without changing its digest. Record a
   source repository/digest to Harbor repository/digest mapping; do not record credentials.
3. Mirror the chart and lifecycle executable through the approved offline transfer path. Verify
   their recorded SHA-256 values on both sides of the boundary.
4. Configure Harbor trust and image-pull credentials outside values files. Values and evidence may
   name a Secret but must never contain its data, a pull token, `.dockerconfigjson`, or kubeconfig.
5. Render with the chart's disconnected/private-registry values from the shipped chart version.
   Compare the rendered image set with the lock: every repository must be below the Harbor prefix,
   every digest must be unchanged, and no public hostname may remain.
6. During future disposable acceptance, deny public egress and retain registry/audit evidence proving
   that render and install attempted no public-registry request. A successful pull from Harbor alone
   is insufficient if fallback egress was still possible.

Never use `sed` or an ad-hoc template post-processor to rewrite images; that bypasses the provenance
and digest-preservation contract. Never put Harbor credentials on a command line or in captured
rendered YAML.

The proposed chart's exact offline review values are `supplyChain.registry` and
`supplyChain.disconnected`; OpenShift rendering uses `platform.type=openshift`. The registry value is
a hostname/project prefix, not a credential:

```bash
helm template falcone-knative charts/falcone-knative \
  --namespace knative-serving \
  --kube-version 1.34.0 \
  --set-string platform.type=openshift \
  --set-string platform.openshiftVersion=4.21 \
  --set-string supplyChain.registry=harbor.example.internal/falcone \
  --set supplyChain.disconnected=true > /tmp/falcone-knative-harbor.yaml
```

This is an offline render, not an installation. Review `/tmp/falcone-knative-harbor.yaml` without
publishing it if it contains environment identifiers. Every `image:` repository must start below
`harbor.example.internal/falcone/`, preserve its source digest exactly, and contain no public
registry hostname or mutable tag. Disconnected rendering with an empty mirror prefix must fail.

## Zero-mutation preflight

`preflight` is the mandatory first cluster-aware operation. On the future accepted executable, the
managed invocation is:

```bash
bin/falcone-knative preflight \
  --mode managed \
  --owner <exclusive-safe-owner-name> \
  --bundle-version 1.22.1 \
  --output json
```

It must inspect, without writing:

- Kubernetes/OpenShift versions and `restricted-v2` availability;
- exact cluster-scoped permissions;
- admission reachability;
- namespaces, Knative CRDs and their stored versions;
- cluster roles/bindings and admission webhook configurations;
- every exact staged identity, including ConfigMaps, Secrets, ServiceAccounts, namespaced Roles and
  RoleBindings, HPAs, PodDisruptionBudgets, internal Certificates/Images, workloads, Services, CRDs,
  cluster RBAC, and admission registrations; and
- OLM, Serverless Operator, raw installation, Falcone, unknown, partial, and ambiguous ownership
  markers.

The exclusive marker is valid only when `data.owner` equals `falcone.io/knative-owner`,
`data.release` equals `app.kubernetes.io/instance`, and both `data.state` and the
`falcone.io/ownership-state` annotation are `exclusive`. Missing or contradictory representations
are not legacy-compatible and stop every mutating command before its first write.

A passing result names the detected/supported matrix, owner, target bundle, stage, result, and a
correlation ID. It authorizes a reviewed staged install; it is not itself install success. A failure
must have zero `create`, `apply`, `patch`, `delete`, Helm install/upgrade, label, or annotation calls.

For `external`, supply only a canary that the external administrator already created:

```bash
bin/falcone-knative preflight \
  --mode external \
  --owner <external-lifecycle-owner> \
  --external-canary <namespace>/<knative-service-name> \
  --output json
```

This may discover, read, and invoke the named canary. It must not create a validation service. If the
canary is missing, unreadable, incompatible, or cannot be invoked, status remains `unverified` and
the Function/MCP dependency gates remain closed.

After that read-only decision, an explicit external publication repeats the canary validation and
writes only leased runtime-status ConfigMaps in already registered, same-owner Falcone namespaces:

```bash
bin/falcone-knative install \
  --mode external \
  --owner <external-lifecycle-owner> \
  --external-canary <namespace>/<knative-service-name> \
  --output json
```

It never creates, patches, adopts, scales, or deletes the external Serving/Kourier installation or
the canary. External publication is an explicit refresh operation: run it through an approved
credential/context mechanism more often than the four-minute CLI lease (a two-minute cadence is the
recommended ceiling). A failed refresh writes no fabricated `ready`; the existing lease expires and
the application guard fails closed. The managed projector is not installed into an
administrator-owned external runtime.

## Future managed install stages and expected status

> **Do not execute this section until managed support is explicitly published.** It documents the
> ordered acceptance contract so installers and auditors can evaluate a future release.

After a clean supported preflight, the future lifecycle command surface is:

```bash
bin/falcone-knative install \
  --mode managed \
  --owner <exclusive-safe-owner-name> \
  --release falcone-knative \
  --bundle-version 1.22.1 \
  --status-namespace knative-serving \
  --status-configmap falcone-knative-status \
  --run-id <unique-non-secret-run-id> \
  --output json
```

For a future disconnected install, the same command additionally requires
`--registry-mirror harbor.example.internal/falcone --disconnected`. A non-clean cluster also requires
an approved migration record supplied as `--reviewed-migration <non-secret-review-id>`; that flag is
an explicit decision reference, not permission to adopt foreign/ambiguous ownership.

The executable must stop at each boundary until its readiness condition is true:

1. Apply Serving CRDs and wait for every required CRD to be `Established`.
2. Apply namespaces, service accounts, cluster RBAC, configuration, and Services.
3. Start the Knative webhook Deployment **without** any `AdmissionRegistration` object.
4. Wait for the webhook Service endpoint and generated serving certificate.
5. Apply the three admission configurations; require non-empty CA bundles and a successful admission
   probe before any dependent custom-resource write.
6. Start and verify the remaining Knative Serving controllers.
7. Start and verify the Kourier controller and gateway.
8. Create an isolated smoke Knative Service, wait for Ready, invoke it cluster-internally through
   Kourier, and delete it.
9. Only then set lifecycle status to `compatible` and projected runtime readiness to `ready`.

A failed resource or deadline leaves a bounded non-ready `stage` and `reason`, preserves diagnostic
state, and never publishes `ready`/`compatible`. Do not proceed to the Falcone umbrella's `managed`
selection until the separate lifecycle is compatible.

## Status and evidence contracts

The lifecycle release owns one ConfigMap (default `falcone-knative-status`) in the fixed
`knative-serving` namespace. Its
`lifecycle.json` data key uses `schemaVersion: falcone.knative-lifecycle/v1` and exactly these
top-level fields:

```json
{
  "schemaVersion": "falcone.knative-lifecycle/v1",
  "release": "falcone-knative",
  "version": "<coordinated-chart-version>",
  "status": "installing",
  "runId": "<non-secret-run-id>",
  "clusterIdentity": {
    "apiUrl": "https://api.<cluster>:6443",
    "infrastructureName": "<name>",
    "infrastructureId": "<id>",
    "clusterUid": "<uid>"
  },
  "lifecycleExecutable": {
    "name": "falcone-knative",
    "version": "<version>",
    "sha256": "<64-hex-digits>"
  }
}
```

The lifecycle executable and, for managed mode, the long-lived projector write a separate
`schemaVersion: falcone.knative-runtime/v1` document only into registered Falcone namespaces whose
owner marker matches. It includes `mode`, `owner`, `version`, `compatibility`, bounded
`readiness.state/stage/reason/lastTransitionAt`, and a lease in `observedAt`/`validUntil`; external
mode also records `externalCanary.state`. The umbrella release does not own this ConfigMap.

Active application registration first inspects the exact runtime ConfigMap. It refuses foreign or
unowned state; when the object is absent, an ephemeral namespace-local hook creates one already
expired `unavailable` placeholder before registering the namespace. Registration and revocation use
a Namespace `resourceVersion` precondition. The projector rechecks the same Namespace owner,
registration and `resourceVersion` immediately before its ConfigMap PUT, which also carries the
observed ConfigMap `resourceVersion`. Its ClusterRole can only discover Namespaces; controller,
gateway and webhook health reads are exact-name `get` permissions in ordinary Roles in
`knative-serving` and `kourier-system`.

The application mounts the source as an optional read-only directory, never `subPath`. A tokenless
guard validates size/schema/lease and atomically materializes `/var/run/falcone/knative/status.json`
in an `emptyDir`. Missing, malformed, oversized, or expired input becomes a valid non-ready document.
The guard receives no Kubernetes API token. This means a stopped managed projector, or a missed
external CLI refresh, expires to unavailable instead of leaving stale `ready` state.

P4/P10 may collect the bounded status and lifecycle output. It must contain no token, kubeconfig,
credential, pull-secret value, tenant name, workload name, Function/MCP identity, or unbounded
resource body. See the [lifecycle runbook](managed-knative-runbook.md) for read-only commands and
redaction.

## Downstream behavior and isolation

- P8 Function developers and P7 hosted-MCP owners receive dependency-unavailable behavior while the
  mode is disabled, unverified, degraded, unavailable, incompatible, or has an expired lease.
- P12 invocations remain authenticated, authorized, tenant/workspace-scoped, quota-bound, and
  audited. Runtime readiness never bypasses those checks.
- P10 sees mode/version/compatibility/readiness appropriate to their scope, with no mutation control.
- P13 must not learn foreign tenant/workspace resource existence from status, errors, logs, metrics,
  a replacement-conflict path, or cleanup. Authorization and ownership checks precede dependency
  disclosure.
- A cluster-wide outage may affect multiple tenants, but projected documents and evidence remain
  owner-checked and omit tenant workload identity.

## Limits, retries, and idempotency

- Compatibility is exact, not a minimum version range.
- A ready managed projection lease is 120 seconds and the managed projector refresh interval is 30
  seconds. An explicit external CLI publication uses a four-minute lease. The tokenless guard
  rejects any lease longer than five minutes; every expiry fails closed.
- The runtime document is bounded to 16 KiB.
- Preflight is read-only and repeatable. Do not turn a failure into an install by bypassing a check.
- A failed staged install may be retried only after the named stage and ownership state are reviewed.
- Never submit two lifecycle commands concurrently for one owner/release.
- Upgrades advance at most one Knative minor version and never move backward by patch version;
  downgrade uses the compatibility-gated rollback path. Storage migrations and post-upgrade actions
  are readiness-gated.
- Rollback is allowed only when the target bundle supports the currently stored CRD versions.
- Uninstall retains CRDs and tenant workload state by default. Purge is a distinct destructive
  operation and requires a separate confirmation.
- A confirmed purge additionally requires an exact, reviewed backup ConfigMap in the status
  namespace. Its name equals `--backup-evidence`; it is same-owner, labelled
  `falcone.io/backup-verified=true`, and records schema `falcone.knative-recovery/v1`, state
  `verified`, and a `sha256:<64 lowercase hex>` inventory digest. The command inventories every
  installed managed CRD's custom resources cluster-wide and refuses before mutation if any is
  unowned or foreign-owned. It also refuses an owner-labelled non-bundle CRD, deletes custom
  resources and bundle CRDs only by their individually verified names, and uses UID/resourceVersion
  deletion preconditions when the API supplies them; it never uses an owner selector for deletion.
  After that initial safe inventory it creates one temporary fail-closed
  `ValidatingAdmissionPolicy` plus binding that deny `CREATE` and `UPDATE` across exactly
  `serving.knative.dev`, `networking.internal.knative.dev`,
  `autoscaling.internal.knative.dev`, and `caching.internal.knative.dev`. It re-inventories every
  pinned resource under the active fence, deletes only that second inventory, and removes the exact
  binding and policy after the last destructive deletion. Kubernetes admission classifies HTTP
  PUT/PATCH mutations as `UPDATE`; `PATCH` is not a valid `RuleWithOperations.operations` value.
- A Falcone-to-Operator handoff verifies the exact seven writers (webhook, activator, autoscaler,
  Serving controller, Kourier controller, Kourier gateway and status projector), scales each exact
  Deployment, then re-reads zero Deployment replicas and zero matching Pods before a
  resourceVersion-fenced owner-marker release. Operator-to-Falcone handoff starts from exactly one
  active exclusive Operator marker rather than a historical Falcone marker. A post-mutation failure
  remains quiesced and must not auto-start the previous owner.
- The disposable `replacement-conflict` acceptance hook deletes only the previously owner-verified
  Knative Service through Kubernetes `DeleteOptions` carrying its observed UID and resourceVersion;
  a same-name race is reported as a precondition conflict and never publishes ready.

## Cleanup and live acceptance blockers

The issue-8 implementation work must not execute destructive purge. Disposable live acceptance must
inventory every namespace, cluster-scoped object, canary/smoke service, chart release, projected
ConfigMap, test identity, and external evidence object it creates. Cleanup must use retain-uninstall
and approved disposable-target teardown, then prove the inventory is absent or explicitly retained.
Secrets must never enter that inventory.

Managed mode remains **proposed/unavailable** until all of the following are true:

- a short-lived remote OpenShift 4.21 / Kubernetes 1.34 target is attested as disposable and the API
  URL, cluster UID, infrastructure name, and infrastructure ID match the approved target;
- the installer has real cluster-admin authority and preflight proves a clean, unowned cluster;
- clean staged install and smoke pass with no OLM/OpenShift Serverless Operator;
- every pod is admitted by `restricted-v2` with an OpenShift-assigned arbitrary UID/GID, all required
  security controls, and no custom SCC;
- public registry egress is denied and all chart/runtime images resolve from Harbor at unchanged
  digests;
- ownership collisions fail before mutation; external and disabled modes remain non-owning;
- the coordinated Falcone issue 933 real-stack Function and hosted-MCP journeys pass for P8/P7/P12,
  including outage/recovery, read-only, authorization, isolation, and secret-safe observability;
- one-minor upgrade, required storage migration, compatible rollback, incompatible rollback refusal,
  forward repair/restore, retain uninstall, purge refusal without distinct confirmation, and both
  successful and failed quiesced handoff are independently verified;
- every disposable resource is removed and cleanup evidence is independently reviewed; and
- coordinated chart/application versions are published and an independent system/docs review
  approves the exact commands and expected results.

The current shared/read-only or pre-owned clusters are discovery evidence only. They cannot close a
clean-install acceptance requirement. Until every blocker is closed, use `external` with an
administrator-owned compatible runtime or keep the default `disabled`.

## Related references

- [Managed Knative lifecycle runbook](managed-knative-runbook.md)
- [falcone-charts issue 8](https://github.com/gntik-ai/falcone-charts/issues/8)
- [Coordinated Falcone runtime issue 933](https://github.com/gntik-ai/falcone/issues/933)
- `openspec/changes/add-8-managed-knative-serving/` in this repository (active, strict OpenSpec)
- `charts/falcone-knative/` (separate proposed lifecycle release)
- `charts/in-falcone/` (application umbrella; never owns the managed serving bundle)
