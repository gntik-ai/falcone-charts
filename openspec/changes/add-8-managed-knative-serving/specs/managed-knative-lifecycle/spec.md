# managed-knative-lifecycle — spec delta for add-8-managed-knative-serving

## ADDED Requirements

### Requirement: Managed Knative is a separate release operated by a versioned client-side executable

`managed` mode SHALL be delivered as a separate `falcone-knative` Helm release plus a versioned,
client-side lifecycle executable whose basename is exactly `falcone-knative`, invoked under the
cluster administrator's own authority. The managed serving bundle SHALL NOT be a dependency of
`charts/in-falcone`, and the lifecycle SHALL install no OLM object and no long-lived Falcone Knative
Operator or reconciling controller. The executable's SHA-256 SHALL be recorded so it can be verified
against the installed binary and the published lifecycle status.

#### Scenario: Managed lifecycle uses no Operator

- **WHEN** a cluster administrator installs, upgrades, rolls back, or uninstalls managed Knative
- **THEN** the versioned `falcone-knative` executable operates the separate `falcone-knative` release
  and no OLM object or long-lived Falcone Knative Operator/controller is created

#### Scenario: Managed bundle is never an umbrella dependency

- **WHEN** `charts/in-falcone` is rendered or packaged with any supported values
- **THEN** its dependency set contains no managed Knative Serving/Kourier bundle and the umbrella
  release creates no CRD, cluster RBAC, or admission webhook for the serving layer

#### Scenario: Lifecycle executable identity is verifiable

- **WHEN** a release engineer inspects a published managed bundle
- **THEN** the `falcone-knative` executable version and SHA-256 resolve to one binary and match the
  value recorded in the Helm-owned lifecycle status contract

### Requirement: The supported compatibility matrix is fixed and fails closed

The managed lifecycle SHALL accept only Knative Serving/Kourier 1.22.1 on Kubernetes 1.34 and
OpenShift 4.21 under `restricted-v2`. Every other Knative, Kourier, Kubernetes, or OpenShift
combination SHALL fail closed before any mutation and SHALL name the detected and supported versions.
Support metadata SHALL identify this patched upstream bundle as Falcone-supported on the published
matrix and SHALL NOT describe it as the Red Hat-supported OpenShift Serverless product path.

#### Scenario: Initial matrix is accepted

- **WHEN** preflight detects Knative Serving/Kourier 1.22.1, Kubernetes 1.34, and OpenShift 4.21 with
  `restricted-v2`
- **THEN** the compatibility gate accepts that combination subject to authority and ownership checks

#### Scenario: Unvalidated platform combination fails closed

- **WHEN** preflight detects any Knative, Kourier, Kubernetes, or OpenShift version absent from the
  published matrix
- **THEN** the lifecycle stops before any mutation and reports the detected and supported versions

#### Scenario: Support status is represented accurately

- **WHEN** an operator or P17 documentation-only user inspects managed support metadata
- **THEN** it identifies Falcone's bundle support and does not label the raw-manifest path as the Red
  Hat-supported OpenShift Serverless product

### Requirement: The managed bundle is provenance-locked and reproducible offline

Every managed bundle SHALL lock the upstream Knative and Kourier release versions and source
revisions, the original and patched manifest SHA-256 checksums, a license inventory, SBOMs, and a
complete image inventory. Every image reference SHALL be an immutable digest — including the Envoy
gateway image that upstream references by the mutable tag `envoy:v1.37-latest` — and SHALL support
deterministic rewrite to a configured private/Harbor registry **without changing the digest**.
Rendering and installation in disconnected mode SHALL resolve every image only from the configured
mirror and SHALL make no public-registry request. Bundle validation SHALL reject any tag-only image.

#### Scenario: Mutable image is rejected

- **WHEN** a managed bundle contains any image referenced by a mutable tag such as
  `envoy:v1.37-latest`
- **THEN** bundle validation fails before installation and identifies the unpinned image

#### Scenario: Provenance lock is complete and reproducible

- **WHEN** a release engineer validates a managed bundle
- **THEN** the locked upstream revisions, original and patched manifest checksums, licenses, SBOMs,
  and every image digest resolve to one reproducible bundle

#### Scenario: Harbor rewrite preserves the digest

- **WHEN** the bundle is rewritten to a configured Harbor registry
- **THEN** every image path is deterministically re-hosted under that registry while its `sha256`
  digest is unchanged, and no rewritten reference introduces a tag

#### Scenario: Disconnected installation uses only the mirror

- **WHEN** a P18 installer selects disconnected managed mode with a Harbor mirror
- **THEN** every Knative and Kourier workload resolves its digest-pinned image from that mirror and
  neither render nor install contacts a public registry

### Requirement: Managed mode fails closed on authority and ownership before any mutation

Before any managed-mode mutation, the lifecycle SHALL verify, without mutating the cluster, the
cluster-scoped permissions, Kubernetes/OpenShift compatibility, admission reachability, existing
namespaces, CRDs and their stored versions, cluster RBAC, admission webhook configurations, the
complete bundle resource inventory, and ownership markers. A clean installation SHALL acquire exactly
one exclusive Falcone ownership identity. Any resource controlled by OLM, the OpenShift Serverless
Operator, another raw-manifest installation, a different Falcone owner, or an unknown owner — and any
partial or ambiguous ownership — SHALL stop the installation before mutation. An existing
installation SHALL require an explicit `external`, `disabled`, or reviewed `managed` migration
decision and SHALL never be adopted implicitly.
Every command that can mutate an existing managed runtime (`install`, `upgrade`, `rollback`,
`uninstall`, confirmed `purge`, `handoff`, and acceptance transitions) SHALL read the exact ownership
ConfigMap first and require the requested owner, release, and both data/annotation ownership states
to be exclusive. A missing, foreign, released, or partial marker SHALL fail before any mutation.
The complete inventory SHALL cover every exact identity that staged apply or final Helm adoption can
overwrite, including namespaced ConfigMaps, Secrets, ServiceAccounts, Roles, RoleBindings, HPAs,
PodDisruptionBudgets and Knative internal Certificate/Image objects. Owner validation SHALL be
conjunctive: data and metadata owner identities SHALL both exist and agree, data and Helm-instance
release identities SHALL both exist and agree, and both state representations SHALL be exclusive.

#### Scenario: Clean cluster passes preflight and records one owner

- **WHEN** a P18 installer with cluster-admin authority selects `managed` on a compatible cluster
  whose Knative resources are absent
- **THEN** preflight succeeds, records one exclusive Falcone owner identity, and authorizes the staged
  install, having mutated nothing during preflight

#### Scenario: Namespace-only installer is denied before mutation

- **WHEN** an installer lacks permission to manage any required cluster-scoped resource
- **THEN** preflight fails naming the missing permission and no Knative resource is mutated

#### Scenario: Existing Operator or foreign ownership is not adopted

- **WHEN** preflight detects Knative resources owned by OLM, the OpenShift Serverless Operator,
  another raw installer, a different Falcone owner, or an unknown/partial owner
- **THEN** the managed install is rejected before mutation and directs the installer to `external`,
  `disabled`, or an explicit reviewed handoff/migration

#### Scenario: Existing installation requires an explicit decision

- **WHEN** managed mode is requested where any bundle resource already exists and no reviewed
  migration decision has been recorded
- **THEN** the lifecycle stops before changing Knative and requires an explicit
  `external`/`disabled`/reviewed-`managed` selection

#### Scenario: Existing managed mutation requires the live exclusive marker

- **WHEN** any mutating lifecycle command targets resources that appear Falcone-managed but the
  exact ownership ConfigMap is missing, foreign, released, or partial
- **THEN** it refuses before a recovery record, projection, scale, Helm, or Kubernetes write

### Requirement: Managed Knative is compatible with OpenShift restricted-v2 without a custom SCC

The managed OpenShift rendering SHALL remove Kourier's fixed `runAsUser: 65534` and
`runAsGroup: 65534` so the platform assigns the namespace's arbitrary UID/GID, and SHALL compute no
substitute fixed UID/GID. Every container in the Falcone-managed Knative control-plane and Kourier
data-plane bundle SHALL retain `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
`seccompProfile.type: RuntimeDefault`, and all Linux capabilities dropped, and SHALL require no custom
SCC and no privileged service account.

#### Scenario: Kourier accepts the OpenShift-assigned UID

- **WHEN** Kourier is admitted under the namespace's OpenShift `restricted-v2` UID range
- **THEN** its pods start with the assigned non-root identity and no manifest requests
  `runAsUser: 65534` or `runAsGroup: 65534`

#### Scenario: Security controls remain enforced

- **WHEN** the managed manifests are rendered for OpenShift
- **THEN** every workload remains non-root, disallows privilege escalation, uses `RuntimeDefault`
  seccomp, drops all capabilities, and requests no custom SCC or privileged service account

### Requirement: Managed installation is staged and readiness-gated with a smoke gate

The lifecycle SHALL install and verify the managed runtime in ordered stages: (1) CRDs and wait for
every required CRD to be `Established`; (2) namespaces, service accounts, cluster RBAC, configuration,
and Services; (3) the Knative webhook Deployment **without** any `AdmissionRegistration` object; (4)
the webhook Service endpoint and its generated serving certificate; (5) the three
`AdmissionRegistration` configurations, non-empty CA bundles, and a successful admission probe; (6)
the remaining Knative Serving controllers; (7) the Kourier controller and gateway; (8) an isolated
create/invoke/delete smoke `ksvc`; and only then (9) publish runtime `ready`. No dependent controller,
Knative custom-resource write, or downstream readiness SHALL proceed before its prerequisites are
healthy. A failed stage SHALL name the failed resource, preserve diagnostic state, and never report
availability.

#### Scenario: CRDs establish before dependent controllers start

- **WHEN** a managed installation begins
- **THEN** the lifecycle waits for every required CRD to become `Established` before applying any
  resource whose controller or webhook depends on those CRDs

#### Scenario: Failure-policy webhooks are enabled only after their backend is ready

- **WHEN** the lifecycle bootstraps Knative admission
- **THEN** it starts the webhook backend without `AdmissionRegistration` objects, waits for the
  Service endpoint and certificate, applies the configurations, and waits for non-empty CA bundles
  plus a successful admission probe before any dependent write

#### Scenario: Admission and data plane are proven by a smoke ksvc before readiness

- **WHEN** the Serving and Kourier workloads appear available
- **THEN** the lifecycle creates an isolated smoke Knative Service, verifies Ready and
  cluster-internal invocation through Kourier, deletes it, and only then publishes runtime `ready`

#### Scenario: A failed stage is not a successful install

- **WHEN** a webhook, controller, gateway, or smoke `ksvc` fails its readiness deadline
- **THEN** the runtime is left in a non-ready state naming the failed stage, downstream readiness
  stays false, and no projection reports `ready`

### Requirement: The Helm-owned lifecycle status contract is published and secret-safe

The `falcone-knative` release SHALL render a Helm-owned ConfigMap (name from `--status-configmap`,
default `falcone-knative-status`) in the fixed, non-relocatable `knative-serving` status namespace
(`--status-namespace` SHALL reject any other value) whose `metadata.labels` include
`app.kubernetes.io/managed-by: Helm`,
`app.kubernetes.io/instance: <release>`, and `app.kubernetes.io/version: <chart version>`, and whose
`metadata.annotations` include `meta.helm.sh/release-name: <release>` and
`meta.helm.sh/release-namespace: <status namespace>`. Its data key SHALL contain a JSON document with
`schemaVersion: "falcone.knative-lifecycle/v1"`, `release`, `version`, `status`, `runId`,
`clusterIdentity` (`apiUrl`, `infrastructureName`, `infrastructureId`, `clusterUid`), and
`lifecycleExecutable` (`name: "falcone-knative"`, `version`, `sha256`). `status` SHALL advance to
`compatible` only after the smoke `ksvc` stage passes. The document SHALL contain no token, kubeconfig,
credential, pull secret, tenant name, or unbounded payload.
After smoke succeeds, the final Helm publication SHALL explicitly adopt every safe staged non-CRD,
non-Namespace object into the release so rollback and retain-uninstall have a complete ownership
inventory. CRDs and Namespaces SHALL remain outside Helm deletion custody.

#### Scenario: Lifecycle status is published Helm-owned after smoke

- **WHEN** a managed install completes its smoke `ksvc` stage
- **THEN** the status namespace holds a Helm-owned `falcone.knative-lifecycle/v1` ConfigMap with the
  Helm labels/annotations, the coordinated release/version, `status: compatible`, the run ID, the
  live cluster identity, and the executable name/version/SHA-256

#### Scenario: Final release adopts safe staged objects but not durable boundaries

- **WHEN** smoke succeeds after the client-side staged install
- **THEN** the final Helm release takes ownership of every staged object except CRDs and Namespaces,
  publishes compatible status, and leaves CRDs/Namespaces under explicit lifecycle custody

#### Scenario: Status is not compatible until the runtime is proven

- **WHEN** any pre-smoke stage is incomplete or failed
- **THEN** the lifecycle status `status` value is not `compatible` and downstream consumers treat the
  runtime as not ready

#### Scenario: Lifecycle evidence is secret-safe

- **WHEN** the lifecycle status ConfigMap or lifecycle audit output is read
- **THEN** it contains no token, kubeconfig, credential, pull secret, tenant name, or unbounded
  resource payload

### Requirement: The runtime status is projected owner-safely into every registered Falcone namespace

Because Kubernetes cannot mount a ConfigMap across namespaces, the lifecycle executable and, in
managed mode, a least-privilege status projector SHALL derive a **leased**
`falcone.knative-runtime/v1` document —
`schemaVersion`, `mode`, `owner`, `version`, `compatibility`,
`readiness` (`state`, `stage`, `reason`, `lastTransitionAt`), an `observedAt` stamp, a bounded
`validUntil` lease deadline, and, in `external` mode, `externalCanary.state` — and write it as a
ConfigMap into every Falcone application namespace that carries the Falcone runtime-projection
registration and a matching owner marker. `observedAt` and `validUntil` SHALL be additive fields.
The `in-falcone` chart's tokenless guard SHALL enforce the lease before atomically materializing the
application-visible v1 file, so an expired projection becomes unavailable without a Falcone consumer
edit. The projector SHALL refuse to write into any namespace lacking that
registration or bearing a different owner (no silent adoption), and SHALL mutate no Knative, CRD,
admission-webhook, namespace, or RBAC resource — its only write verb SHALL be on the single named
runtime-status ConfigMap in registered namespaces. Kubernetes API enforcement SHALL use a distinct
owner-derived projector service account and an ordinary Role/RoleBinding in each registered
namespace; no ClusterRole SHALL grant ConfigMap writes. Every outage, restart, and recovery transition
SHALL update every registered projection (refreshing `readiness`, `observedAt`, and `validUntil`) so
that a consuming application fails closed within a bounded refresh window; the projector SHALL never
publish `ready` unless smoke/readiness is currently proven, and SHALL keep the document within 16 KiB
and secret-safe.
Registration SHALL inspect the exact runtime ConfigMap before namespace mutation, refuse foreign or
unowned existing state, and create one already-expired `unavailable` same-owner placeholder when it
is absent. Registration and revocation SHALL carry an observed Namespace resourceVersion
precondition. Projection SHALL re-read namespace registration, owner and resourceVersion immediately
before a ConfigMap write, which SHALL carry the observed ConfigMap resourceVersion when replacing an
existing object. Cluster-wide projector RBAC SHALL be limited to Namespace discovery; Deployment and
Endpoint health reads SHALL be exact-name `get` rules in namespace Roles in `knative-serving` and
`kourier-system`.

External mode SHALL remain non-owning: explicit `install --mode external` SHALL repeat read/invoke of
the administrator-supplied existing canary and publish a four-minute lease only to registered,
same-owner application namespaces. It SHALL mutate no external Serving/Kourier/canary resource and
SHALL require periodic explicit refresh rather than installing the managed projector into the
external serving layer.

#### Scenario: A transition updates every registered projection

- **WHEN** the managed runtime transitions to degraded/unavailable (outage), back after a restart, or
  to ready after recovery
- **THEN** every registered Falcone namespace's runtime-status ConfigMap is updated with the new
  `readiness.state`, `stage`, `reason`, a fresh `lastTransitionAt`, and a refreshed
  `observedAt`/`validUntil` lease, leaving no stale `ready` projection

#### Scenario: One foreign projection does not starve valid namespaces

- **WHEN** one registered namespace already contains a foreign-owned runtime ConfigMap while another
  registered namespace has the matching owner
- **THEN** the writer records a bounded refusal for the foreign object, leaves it unchanged, and
  continues updating every valid same-owner namespace

#### Scenario: The projection is a bounded lease

- **WHEN** the projector publishes a `ready` runtime document
- **THEN** it includes an `observedAt` stamp and a bounded `validUntil` deadline it continues to
  refresh, and the chart-side guard treats an unrefreshed expired lease as unavailable rather than
  ready

#### Scenario: The projector is read-only against the serving layer

- **WHEN** the status projector runs
- **THEN** its service account has no create/update/patch/delete verb on any
  `serving.knative.dev`/CRD/`admissionregistration.k8s.io`/namespace/RBAC resource, and it writes only
  the named runtime-status ConfigMap in registered namespaces

#### Scenario: External publication is read/invoke plus status only

- **WHEN** an operator explicitly publishes or refreshes `external` status for a verified existing
  canary
- **THEN** every same-owner registered namespace receives a bounded verified lease and no external
  Serving, Kourier, canary, admission, CRD, or controller resource is mutated

#### Scenario: An unregistered or foreign-owned namespace is refused

- **WHEN** a namespace lacks the Falcone runtime-projection registration or carries a different owner
  marker
- **THEN** the projector writes no runtime-status ConfigMap into it and records a secret-safe refusal

#### Scenario: Projection never fabricates readiness

- **WHEN** readiness cannot be currently confirmed (a probe fails or the projector cannot verify the
  runtime)
- **THEN** the projected document is `degraded`/`unavailable` with a bounded reason and is never
  written as `ready`

### Requirement: Managed lifecycle has explicit upgrade, rollback, uninstall, purge, and handoff boundaries

Managed upgrades SHALL advance at most one Knative minor version at a time, record the resource
inventory, stored CRD versions, image/config state, and a recovery point before any mutation, and run
every required storage-version migration and post-upgrade step gated on readiness. Rollback SHALL be
permitted only to a bundle compatible with the current stored CRD versions; after an irreversible
storage migration, binary downgrade SHALL fail closed and require restore or forward repair.
Uninstall SHALL retain CRDs and tenant workload state by default and report what was retained.
Destructive purge SHALL enumerate impact and require an exact same-owner verified backup record plus
a separate explicit confirmation distinct from the uninstall invocation; implementing the purge
command is in scope, and executing it is not authorized by this change. Before deletion it SHALL
inventory custom resources for every installed managed CRD across all namespaces and refuse if any
object is unowned or foreign-owned, preventing a CRD cascade across the ownership boundary. Purge
SHALL refuse an owner-labelled non-bundle CRD and SHALL delete only individually verified custom
resource identities and exact pinned bundle CRD names, using UID/resourceVersion preconditions when
Kubernetes supplies them; it SHALL NOT use an owner selector for deletion. After the initial safe
inventory and before deletion, purge SHALL install one temporary, fail-closed
`ValidatingAdmissionPolicy` and matching binding that deny `CREATE` and `UPDATE` across exactly the
pinned Serving, Networking, Autoscaling, and Caching API groups (Kubernetes admission classifies
HTTP PUT/PATCH mutations as `UPDATE`; `PATCH` is not a `RuleWithOperations` value), SHALL re-inventory every pinned
resource while that fence is active, and SHALL remove the exact policy and binding only after all
destructive work finishes. A handoff to or from an Operator SHALL quiesce writes
and transfer ownership so that exactly one reconciler ever owns the installation; a handoff that fails
after the new owner mutates resources SHALL remain quiesced for restore/forward repair and SHALL NOT
restart the previous owner concurrently.

#### Scenario: Upgrade skipping a minor version is rejected

- **WHEN** a P3 operator attempts to upgrade managed Knative across more than one minor version
- **THEN** the upgrade is rejected before mutation with the required intermediate version sequence

#### Scenario: Patch downgrade uses rollback

- **WHEN** an operator asks `upgrade` to move from a newer patch to an older patch in the same minor
- **THEN** the command rejects before mutation and directs the operator to compatibility-gated
  rollback

#### Scenario: Irreversible storage migration blocks incompatible downgrade

- **WHEN** an upgrade completed an irreversible CRD storage migration and an incompatible binary
  rollback is requested
- **THEN** rollback is refused and the guidance identifies restore or forward repair from the recovery
  point

#### Scenario: Default uninstall retains durable state

- **WHEN** an operator uninstalls the managed runtime without destructive-purge confirmation
- **THEN** only resources proven safe and Falcone-owned are removed, CRDs and tenant workload state
  are retained, and the retained resources are reported

#### Scenario: Destructive purge requires a separate confirmation

- **WHEN** an operator requests destructive purge
- **THEN** the command enumerates the impacted CRDs/workloads and required backups and refuses to
  proceed without a separate explicit confirmation distinct from uninstall

#### Scenario: Purge refuses an unsafe cascade before mutation

- **WHEN** a confirmed purge finds a missing/mismatched verified backup record or any unowned or
  foreign-owned custom resource under an installed managed CRD
- **THEN** it performs no deletion or other mutation and reports the ownership/backup boundary

#### Scenario: Purge deletion equals the verified inventory

- **WHEN** a separately confirmed purge has verified its exact backup, bundle CRDs and owned custom
  resources
- **THEN** it deletes only those exact resource identities and bundle CRD names, never an owner
  selector or a non-bundle CRD

#### Scenario: Purge fences concurrent Knative writes

- **WHEN** a separately confirmed purge has completed its initial safe ownership inventory
- **THEN** it installs a fail-closed admission policy and binding that deny creates and updates
  (including HTTP PATCH requests admitted as `UPDATE`) for
  exactly the four pinned Knative API groups, re-inventories every bundle resource under that fence,
  deletes only the re-inventoried identities, and removes the exact fence objects after the last
  destructive deletion

#### Scenario: Handoff prevents simultaneous ownership

- **WHEN** an operator starts a handoff between Falcone-managed and Operator-managed Knative
- **THEN** the lifecycle records a backup, verifies all seven writer Deployments, scales their exact
  names, re-reads zero replicas and zero matching Pods, resourceVersion-fences the source marker,
  stops and releases its ownership while
  retaining CRDs/workloads, records released state in both marker data and annotation, enables
  exactly one target owner carrying the prior owner and backup reference, and verifies complete
  exclusive target readiness before
  resuming — and if the target fails after taking ownership the installation stays quiesced without
  restarting the previous owner

### Requirement: The lifecycle executable exposes secret-safe operations and acceptance hooks

The `falcone-knative` executable SHALL provide non-interactive, shell-free subcommands for
`preflight`, staged `install`, `upgrade`, `rollback`, `uninstall`, confirmation-gated `purge`,
`handoff`, and `acceptance <outage|restart|recover|replacement-conflict>`. The `acceptance`
subcommands SHALL accept the verified-target flags `--api-server`, `--cluster-uid`,
`--infrastructure-name`, `--infrastructure-id`, `--run-id`, `--release`, `--status-namespace`, and
`--status-configmap`, drive the corresponding runtime-status projection transition for disposable
acceptance, and SHALL NOT weaken tenant isolation. Every operation SHALL emit secret-safe evidence
carrying actor, action, mode, owner, target bundle, stage/result, and a correlation ID and SHALL NOT
emit any token, kubeconfig, credential, pull secret, tenant name, or unbounded status body.

#### Scenario: Acceptance outage drives the projection unavailable

- **WHEN** `falcone-knative acceptance outage` is run against a verified disposable target
- **THEN** every registered projection transitions to a non-ready state and the consuming application
  reports `KNATIVE_UNAVAILABLE`, without leaking any tenant workload identity

#### Scenario: Acceptance recover restores readiness

- **WHEN** `falcone-knative acceptance recover` is run after an outage/restart
- **THEN** readiness is re-proven and every registered projection returns to `ready` with a fresh
  transition timestamp

#### Scenario: Replacement-conflict hook is tenant-safe

- **WHEN** `falcone-knative acceptance replacement-conflict` arms a same-name replacement conflict for
  a hosted resource
- **THEN** deletion carries the observed UID and resourceVersion, ownership is retained, replay
  removes only the replacement, and no other tenant's workload
  metadata is disclosed

#### Scenario: Lifecycle evidence omits secrets

- **WHEN** any lifecycle operation emits audit or diagnostic output
- **THEN** it records actor/action/mode/owner/bundle/stage/result/correlationId and contains no token,
  kubeconfig, credential, pull secret, tenant name, or unbounded payload
