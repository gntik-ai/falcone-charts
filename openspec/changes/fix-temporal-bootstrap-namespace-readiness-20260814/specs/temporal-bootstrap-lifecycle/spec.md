## Purpose

Define an observable, idempotent, portable, secure, and recoverable lifecycle for reconciling Falcone's application Temporal namespace and search attributes during Helm install, upgrade, wait, rollback, and retry operations.

## ADDED Requirements

### Requirement: Fresh installation reconciles Temporal before dependent readiness

When Falcone is installed with Helm waiting for ordinary workloads, Falcone SHALL start reconciliation of the configured `temporal.bootstrap.namespace` and search attributes without waiting for a post-install readiness phase. Temporal-dependent workflow consumers MUST NOT start their application container until a chart-owned gate verifies the exact configured namespace and five search attributes. That gate SHALL be rendered authoritatively and MUST NOT be removable or replaceable through inherited, reused, or user-supplied values. The `workflowWorker.wrapper.componentId` SHALL remain exactly `workflow-worker`; any inherited or user-supplied divergence MUST fail before rendering rather than bypassing the component-identity condition that owns the gate. User init containers SHALL remain supported only as additions to the mandatory gate. Collision validation SHALL evaluate each user init-container name after Helm `tpl` expansion, and any effective name equal to the reserved gate identity MUST fail before workload rendering. A successful waiting install SHALL therefore be able to converge from an empty Temporal deployment without an operator creating the namespace manually.

#### Scenario: Fresh install completes Temporal bootstrap before workflow consumers become Ready

- **WHEN** an operator performs a clean Helm install with waiting enabled and the configured application namespace does not exist
- **THEN** Falcone reconciles the namespace and configured search attributes after the Temporal frontend becomes healthy
- **AND** Temporal-dependent workflow consumers become Ready only after that namespace is usable
- **AND** the install can converge without an out-of-band namespace mutation

#### Scenario: Helm wait does not defer Temporal namespace creation to a post-install hook

- **WHEN** ordinary workflow consumers are not Ready because their configured Temporal namespace has not yet been created
- **THEN** the resource that reconciles the namespace is eligible to run during the same Helm wait interval
- **AND** its execution is not deferred until all ordinary resources have already become Ready

#### Scenario: Workflow consumers wait for the exact Temporal bootstrap state

- **WHEN** Helm does not wait for ordinary Jobs or the bootstrap Job is still reconciling
- **THEN** the workflow worker's application container does not start until a tokenless Temporal-only gate has verified frontend health and the application namespace
- **AND** that gate verifies all five required search attributes by exact name and `Keyword` type
- **AND** the gate uses no Kubernetes API credential, Secret, or RBAC permission and performs no Temporal mutation

#### Scenario: Inherited values cannot remove the mandatory Temporal bootstrap-state gate

- **WHEN** an upgrade reuses historical values with an empty or replaced `workflowWorker.initContainers` list, or an operator explicitly supplies such a replacement
- **THEN** the chart still renders exactly one authoritative Temporal bootstrap-state gate before the workflow application container can start
- **AND** no values path can disable, remove, rename, or replace that required gate
- **AND** an attempt to shadow its reserved identity fails before rendering with a path-specific diagnostic

#### Scenario: Workflow component identity cannot bypass the mandatory Temporal gate

- **WHEN** inherited, reused, or user-supplied values omit `workflowWorker.wrapper.componentId` or set it to any value other than `workflow-worker`
- **THEN** the chart fails before rendering with a path-specific component-identity diagnostic
- **AND** it does not render a workflow workload whose mandatory Temporal gate was skipped by the divergent identity
- **AND** the supported historical `workflow-worker` identity continues to render exactly one mandatory gate

#### Scenario: User init containers remain additive to the mandatory Temporal gate

- **WHEN** an operator supplies one or more valid workflow-worker init containers with names that do not collide with the reserved gate
- **THEN** the chart renders the mandatory Temporal bootstrap-state gate and every user init container exactly once
- **AND** user init containers are additive rather than replacing the gate
- **AND** the workflow application container starts only after the mandatory gate and the user init containers succeed

#### Scenario: Templated user init container names cannot collide with the reserved Temporal gate

- **WHEN** a user init-container name is authored as a Helm template expression whose evaluated value equals the reserved Temporal gate name
- **THEN** the chart compares the effective post-`tpl` name with the reserved identity and fails before rendering the workflow workload
- **AND** the diagnostic identifies the user init-container path and reserved name without evaluating arbitrary data into the mandatory gate
- **AND** no raw pre-template comparison, alias, or inherited values path can produce a second container with the reserved effective name

### Requirement: Temporal frontend addressing remains DNS-safe and shared

Falcone SHALL derive the effective Temporal frontend Service hostname through one chart helper that applies Helm-compatible `trunc 63` and trailing-hyphen `trimSuffix` behavior. The `temporal-frontend` Service name MUST be a valid DNS label no longer than 63 characters. The revision-scoped bootstrap Job and mandatory workflow bootstrap-state gate SHALL use that exact effective Service hostname in their Temporal frontend addresses. No workload MAY reconstruct an untruncated or independently truncated release-derived hostname.

#### Scenario: Long release names keep the workflow gate and Temporal frontend address identical

- **WHEN** the chart renders with a release name exactly 53 characters long
- **THEN** the effective `temporal-frontend` Service hostname is a valid DNS label no longer than 63 characters derived through the shared helper, `trunc 63`, and trailing-hyphen trimming
- **AND** the bootstrap Job Temporal address and mandatory workflow gate `TEMPORAL_ADDRESS` use exactly that effective Service hostname
- **AND** neither consumer renders an untruncated, independently derived, or otherwise divergent frontend name

### Requirement: Upgrade and retry reconciliation is idempotent and replaceable

When Helm upgrades, retries, or recovers a release, Falcone SHALL execute namespace and search-attribute reconciliation against the desired values even if the target objects already exist. Reconciliation SHALL verify the desired namespace and every configured search attribute, SHALL preserve compatible existing Temporal state, and MUST use a workload lifecycle that does not require patching an immutable completed Job. Repeating an unchanged release operation MUST converge without a duplicate-object failure. Claims about the active revision, lifecycle, retained Job objects, or Helm release history SHALL be demonstrated through actual disposable Helm release transitions; offline rendering MAY prove predicted names, selectors, and immutability inputs but MUST NOT be presented as evidence of live release state.

#### Scenario: Upgrade reconciles the Temporal namespace and search attributes idempotently

- **WHEN** an operator upgrades or retries a release whose configured namespace and some or all search attributes already exist
- **THEN** reconciliation treats compatible existing objects as converged and creates only missing desired objects
- **AND** it verifies the configured namespace and complete configured search-attribute set before reporting success
- **AND** it does not delete workflow histories, namespaces, or existing compatible search attributes

#### Scenario: Repeated reconciliation does not collide with an immutable completed Job

- **WHEN** the prior release left a completed bootstrap Job and a subsequent Helm operation renders the bootstrap workload again
- **THEN** Helm can create or run the desired bootstrap workload without attempting an illegal patch to the completed Job template
- **AND** repeated reconciliation with unchanged inputs converges successfully

#### Scenario: Release-state acceptance tracks active revision Jobs across install upgrade retry and rollback

- **WHEN** disposable acceptance drives one Helm release through install revision 1, upgrade revision 2, fail-forward retry revision 3, and a compatible rollback that creates its own Helm revision
- **THEN** each transition proves the real Helm history, active revision and lifecycle metadata select exactly the intended revision-scoped bootstrap Job
- **AND** retained completed or failed Jobs are never updated through an immutable pod-template patch and the active selector never resolves a stale revision
- **AND** offline render evidence is reported separately as name, label, selector, and immutability prediction rather than as proof of active release state

### Requirement: Bootstrap failures are bounded, observable, and fail forward safely

When the Temporal frontend does not become healthy, namespace reconciliation fails, a configured search attribute cannot converge, or post-write verification detects drift, Falcone SHALL stop the bootstrap workload non-zero within the configured deadline. Every terminal diagnostic from the reconciler or mandatory consumer gate—including frontend timeout, namespace verification, incompatible attribute type, attribute retry exhaustion, list failure, and final read-back drift—SHALL identify the configured namespace, failing phase or attribute, and a finite attempt or deadline bound. Every such diagnostic SHALL include bounded `correct or resolve` and `retry to fail forward safely` guidance and MUST remain secret-safe. Falcone MUST NOT allow dependent workflow consumers to report Ready from a partial bootstrap, MUST NOT delete pre-existing Temporal state, and MUST NOT perform automatic compensating rollback.

#### Scenario: Frontend unavailability fails with bounded actionable diagnostics

- **WHEN** the Temporal frontend remains unavailable through the bounded bootstrap health interval
- **THEN** reconciliation exits non-zero before any namespace or search-attribute mutation
- **AND** the diagnostic names the frontend target, failed health phase, finite bound, and the correction plus retry needed to fail forward
- **AND** no dependent workflow consumer becomes Ready against the unavailable namespace

#### Scenario: Failed reconciliation preserves existing Temporal state for fail-forward retry

- **WHEN** namespace creation, search-attribute creation, or convergence verification fails after compatible Temporal state already exists
- **THEN** reconciliation exits non-zero and names the failed phase, target namespace or attribute, and bounded retry guidance
- **AND** existing namespaces, workflow histories, and compatible search attributes remain intact
- **AND** a later Helm retry can reconcile from that preserved state without manual destructive cleanup

#### Scenario: Every terminal Temporal failure is namespace-specific bounded and fail-forward safe

- **WHEN** any reconciler or mandatory-gate phase exits because frontend, namespace, attribute type, retry, list, or final read-back convergence failed
- **THEN** its terminal diagnostic names the configured namespace and the exact failed phase or attribute
- **AND** it states a finite attempt or deadline bound plus `correct or resolve` and `retry to fail forward safely` guidance
- **AND** it prints no provider response body, credential, environment dump, Secret value, or decoded Kubernetes Secret data

#### Scenario: Every frontend and gate terminal branch reports namespace bound and fail-forward guidance

- **WHEN** either the revision-scoped Job or mandatory workflow gate terminates on frontend timeout, namespace verification, attribute list/read-back, missing or incompatible attribute, or retry exhaustion
- **THEN** the terminal message names `falcone-flows`, the frontend or attribute phase, and an explicit numeric finite bound such as attempts used over attempts allowed or deadline seconds
- **AND** the message contains both `correct or resolve` and `retry to fail forward safely`
- **AND** a vague word such as `bounded` without its numeric limit does not satisfy the contract

### Requirement: Temporal lifecycle workloads start under vanilla and OpenShift identity policies

When Falcone renders for vanilla Kubernetes, every chart-owned container in the Temporal server and Web UI Deployments, their frontend-wait gate, the revision-scoped bootstrap Job, and the workflow bootstrap-state gate SHALL default to numeric `runAsUser: 1000` and `runAsGroup: 1000`, matching the effective UID and GID of the pinned Temporal server, admin-tools, and UI images. `runAsNonRoot` MUST NOT rely on the images' named `User` declaration alone. Supported positive numeric `temporal.podSecurityContext` and `temporal.securityContext` overrides, including pod `fsGroup`, SHALL remain effective on vanilla Kubernetes at their documented scopes. When `global.podSecurity.openshiftRestricted=true`, Falcone SHALL omit fixed `runAsUser`, `runAsGroup`, and `fsGroup` fields at every applicable pod and container scope for those same workloads so the restricted SCC can assign arbitrary namespace-range identities. This final render-time stripping SHALL remove IDs reintroduced through inherited or user-supplied security values, not only chart defaults. Both render paths SHALL retain non-root execution, RuntimeDefault seccomp, disabled privilege escalation, and dropped capabilities, and their complete manifests MUST pass the repository's Kubernetes schema-conformance gate. OCI verification MUST keep only compact byte-exact index, manifest, and config evidence in the repository; it SHALL retrieve every filesystem layer read-only by immutable digest into a unique per-run temporary directory, verify each layer's declared digest and size, reconstruct the final filesystem, and remove all downloaded and extracted content through a `finally`/trap path on success or failure. Overlay processing SHALL implement root-level and arbitrarily nested parent-directory whiteouts and opaque-directory semantics, not only `/etc` fixtures.

#### Scenario: Vanilla Kubernetes uses numeric image identities for every chart-owned Temporal container

- **WHEN** the default chart is rendered for vanilla Kubernetes
- **THEN** every Temporal server container, chart-owned Temporal init gate, revision-scoped bootstrap container, and workflow bootstrap-state gate has an effective numeric UID and GID of `1000:1000`
- **AND** the Temporal Web UI container also has an effective numeric UID and GID of `1000:1000`
- **AND** semantic image-identity verification proves those numbers match the pinned server, admin-tools, and UI image users
- **AND** no chart-owned Temporal container depends on kubelet resolving the named user `temporal` to enforce `runAsNonRoot`

#### Scenario: OpenShift assigns arbitrary identities to every chart-owned Temporal container

- **WHEN** the chart is rendered with `global.podSecurity.openshiftRestricted=true`
- **THEN** every Temporal server Deployment, chart-owned Temporal init gate, revision-scoped bootstrap Job, and workflow bootstrap-state gate omits fixed UID, GID, and fsGroup at pod and container scope
- **AND** the restricted SCC can inject namespace-range identities without conflicting with a chart-pinned `1000:1000`
- **AND** non-root, seccomp, privilege-escalation, and capability-drop hardening remains present

#### Scenario: Inherited Temporal security IDs are stripped from every OpenShift container

- **WHEN** inherited or user-supplied values set fixed UID, GID, or fsGroup fields under `temporal.podSecurityContext` or `temporal.securityContext` and the OpenShift restricted profile is enabled
- **THEN** the rendered Temporal server, Web UI, server init gate, revision-scoped bootstrap, and workflow bootstrap-state gate contain none of those fixed identity fields at pod or container scope
- **AND** the source values are not mutated while every chart-owned Temporal workload honors SCC-assigned arbitrary identities
- **AND** the same inherited values retain their numeric non-root identity on vanilla Kubernetes

#### Scenario: Identity overrides render on vanilla and are stripped on OpenShift

- **WHEN** an operator supplies supported positive numeric UID, GID, and fsGroup overrides through the Temporal pod and container security values
- **THEN** a vanilla render preserves those overrides at every documented Temporal pod and container scope without falling back to the default `1000:1000`
- **AND** the corresponding OpenShift restricted render removes every fixed UID, GID, and fsGroup from all chart-owned Temporal pods, init containers, and containers
- **AND** both complete rendered manifest sets pass kubeconform or the repository's equivalent Kubernetes schema validation

#### Scenario: Vanilla preserves supported positive identity overrides while OpenShift strips fixed identities

- **WHEN** the chart is rendered once with no identity override and again with supported positive numeric pod and container UID, GID, and pod `fsGroup` overrides
- **THEN** the vanilla default render uses `1000:1000` only where no supported override applies, while the override render preserves every authored value at its documented pod or container scope
- **AND** the corresponding OpenShift restricted renders omit every fixed UID, GID, and `fsGroup` after values and templates are fully resolved
- **AND** all complete vanilla and OpenShift manifests pass the repository's Kubernetes schema-conformance gate

#### Scenario: Pinned Temporal image metadata deterministically maps named users to numeric identities

- **WHEN** release verification examines the exact pinned server, admin-tools, and UI OCI artifacts without a mutable registry lookup
- **THEN** each artifact's `Config.User` value `temporal` resolves through its own passwd and group metadata to UID and GID `1000:1000`
- **AND** the verification is digest-bound, deterministic, and fails if the configured user, passwd mapping, group mapping, or chart numeric identity drifts
- **AND** vanilla and OpenShift render assertions consume that verified identity contract without inferring runtime SCC IDs from manifests

#### Scenario: Raw digest-bound OCI evidence proves every pinned Temporal image identity

- **WHEN** verification evaluates the pinned Temporal server, admin-tools, and UI image artifacts
- **THEN** retained byte-exact OCI index, manifest, and config bytes form a verified digest chain to the asserted image identity, and every registry-retrieved filesystem layer is bound to its manifest-declared digest and size
- **AND** `Config.User`, passwd, and group evidence is derived from that verified raw chain rather than from an unbound hand-authored summary
- **AND** deterministic verification fails on any byte, digest, size, user, UID, GID, or provenance mismatch while using only read-only public registry access and disposable layer storage

#### Scenario: OCI identity evidence reconstructs the final filesystem across layers and whiteouts

- **WHEN** deterministic verification derives passwd and group identity data from a pinned server, admin-tools, or UI OCI image
- **THEN** it retains only compact byte-exact index, manifest, and config evidence in the repository and retrieves every layer read-only by immutable digest from Docker Hub into `/tmp` or another disposable cache
- **AND** it verifies each retrieved layer's SHA digest and declared size before applying every manifest-declared layer in order with ordinary replacement, `.wh.<name>` deletion, and `.wh..wh..opq` opaque-directory semantics
- **AND** it resolves `Config.User`, `/etc/passwd`, and `/etc/group` from the resulting effective filesystem rather than from an arbitrarily selected layer
- **AND** verification fails if any layer is unavailable, omitted, reordered, size- or digest-mismatched, or interpreted without its whiteout effect, and it does not require versioning the retrieved layer blobs

#### Scenario: OCI reconstruction uses per-run cleanup and general whiteout semantics

- **WHEN** image verification succeeds, fails during download or hashing, or encounters an adversarial synthetic layer sequence
- **THEN** it uses a unique per-run temporary directory rather than a fixed shared cache and removes every downloaded blob and extracted file through a guaranteed `finally` or trap path
- **AND** overlay reconstruction applies file whiteouts and opaque-directory markers at the filesystem root and beneath any parent directory according to OCI layer order
- **AND** adversarial fixtures prove replacement, parent deletion, root deletion, nested opaque directories, and later-layer recreation before final passwd/group resolution
- **AND** no successful or failing run leaves the fixed 232 MiB cache or another persistent layer cache behind

### Requirement: Bootstrap Job and consumer gate use one authoritative admin-tools image contract

When Falcone renders the revision-scoped bootstrap Job and mandatory workflow bootstrap-state gate, both SHALL resolve their image exclusively from the subchart-visible `global.temporalAdminToolsImage`. Its exact defaults SHALL remain `repository: docker.io/temporalio/admin-tools`, `tag: "1.31.1"`, no digest, and `pullPolicy: IfNotPresent`. Both workloads SHALL preserve the same effective repository, tag, optional digest, pull policy, global registry rewrite, and normalized global/private-registry image-pull-secret set. No workflow-specific bootstrap image value or component-wrapper fallback SHALL be able to select a different image. The values schema MUST NOT make authored presence of `global.temporalAdminToolsImage` a prerequisite that rejects stored values created by the authoritative pre-change chart before compatibility validation can evaluate them.

The existing `temporal.adminTools.image` SHALL remain a legacy compatibility input, not an independent authority. When present, its normalized repository, tag, optional digest, and pull policy MUST equal `global.temporalAdminToolsImage`; any divergence SHALL fail before rendering with a migration diagnostic naming both paths and directing the operator to copy all four fields to the global authority. Reused historical values with a custom legacy image and no canonical global value MUST fail closed with the same migration guidance instead of silently reverting to defaults. Historical default-valued input remains compatible with the exact canonical defaults. `workflowWorker.temporalBootstrapImage` SHALL be rejected before rendering if authored and MUST never alter either workload.

Compatibility SHALL be exercised through a real Helm release created from a values set predating `global.temporalAdminToolsImage` and subsequently upgraded with reused values. An exact historical-default legacy image with no stored global object MUST remain operable and resolve both Job and gate to the canonical default. A custom legacy image with no equal canonical global object MUST fail before rendering until the operator performs the documented migration.

#### Scenario: Bootstrap Job and mandatory gate share the authoritative admin-tools image

- **WHEN** an operator renders exact defaults or overrides `global.temporalAdminToolsImage` with repository, tag, optional digest and pull policy while global registry and pull-secret settings are enabled
- **THEN** the revision-scoped Job and mandatory workflow gate render the identical effective image and pull policy from that single subchart-visible authority
- **AND** both apply the same global registry rewrite and normalized image-pull-secret set
- **AND** an identical legacy `temporal.adminTools.image` remains compatible without becoming authoritative
- **AND** a divergent legacy value, a reused historical custom legacy value without the global authority, or an authored `workflowWorker.temporalBootstrapImage` fails before rendering with bounded path-specific migration guidance and cannot divert either workload

#### Scenario: Legacy and global image equality normalizes absent and empty digests

- **WHEN** the legacy and canonical admin-tools image objects have identical repository, tag and pull policy while one omits `digest` and the other sets `digest: ""`
- **THEN** validation treats both forms as the same no-digest state and permits rendering
- **AND** a non-empty digest remains significant and must match exactly on both paths unless the legacy value is the neutral historical default
- **AND** Job and gate preserve an accepted non-empty canonical digest in the same effective image reference

#### Scenario: Reused pre-global image values preserve defaults and fail closed on custom legacy drift

- **WHEN** an actual Helm release created without `global.temporalAdminToolsImage` is upgraded with reused values, once with the exact historical-default legacy image and once with a custom legacy image
- **THEN** the exact-default case remains operable and resolves the Job and mandatory gate to the identical canonical default without requiring a synthetic stored global key
- **AND** the custom case fails before rendering unless repository, tag, normalized optional digest, and pull policy have been copied to an equal canonical global object
- **AND** the diagnostic and documented migration permit the operator to correct the stored values and retry without silently changing the Temporal CLI image

#### Scenario: Real pre-global Helm stored values remain operable under reuse-values

- **WHEN** a real Helm release is installed from the values and schema at authoritative base `41922e9d` and the new chart is applied with actual `--reuse-values`
- **THEN** stored exact-default legacy image values that contain no `global.temporalAdminToolsImage` pass schema and compatibility validation and converge Job plus mandatory gate on the canonical default
- **AND** stored custom legacy image values with no equal canonical global object fail closed before rendering with a copyable migration diagnostic instead of being rejected by an unconditional schema requirement or silently reset
- **AND** after the operator adds the equal canonical repository, tag, normalized optional digest, and pull policy, the same release can be retried and converges without replacing Temporal state

### Requirement: Temporal bootstrap remains secret-free and least-privileged

When Falcone renders or runs the Temporal bootstrap workload, the workload SHALL use a pinned chart-routed image and the existing restricted security contract: non-root execution, privilege escalation disabled, all Linux capabilities dropped, no ServiceAccount token automount, and no Kubernetes API permission. The bootstrap workload SHALL NOT render a Kubernetes Secret, reference or mount a credential Secret, receive plaintext credentials, or print Secret values. Diagnostics MUST be limited to non-sensitive resource targets, phases, statuses, and retry guidance.

#### Scenario: Bootstrap rendering remains secret-free and least-privileged

- **WHEN** the chart renders the Temporal bootstrap path with sentinel values present in unrelated platform Secrets
- **THEN** the bootstrap workload has no Secret-backed environment variable or volume, no plaintext credential, and no automounted ServiceAccount token
- **AND** its pod and container security contexts enforce the restricted non-root and capability-dropping contract
- **AND** executable success and failure output contains none of the sentinel values or decoded Kubernetes Secret data

### Requirement: Lifecycle changes preserve compatibility, rollback safety, tests, and operations

When an existing release adopts this lifecycle, Falcone SHALL preserve the established `falcone-flows` namespace, retention, exact five-attribute set, image, resource, timeout, and security contracts. Because consumers have always targeted `falcone-flows`, authoring a different producer namespace MUST fail before rendering instead of producing a silently divergent installation. The five required `Keyword` attributes MAY be authored in any order, but missing, duplicate, additional, or differently typed entries MUST fail before rendering. Adoption and rollback MUST NOT delete a Temporal namespace, workflow history, or search attribute. Rollback SHALL be considered safe only when the retained configured namespace is already usable by the target workload version; otherwise the operator SHALL correct the condition and retry forward. The change SHALL provide deterministic render and process-isolated black-box coverage using the literal scenario headers in this specification, one complete unfiltered global black-box run, disposable clean-install and upgrade acceptance, and operator procedures for verification, failure interpretation, fail-forward recovery, compatible rollback, and cleanup. Focused success MUST NOT substitute for either the global or live gate, and publication requires a fresh independent approval after both are complete.

#### Scenario: Existing values and Temporal state remain compatible across upgrade and rollback

- **WHEN** an operator upgrades an existing release and later evaluates or executes a rollback to a compatible chart version
- **THEN** the established `falcone-flows` and exact five-`Keyword` contract remains valid without data migration and retained workflow state is not destructively changed
- **AND** reordering those exact five attributes remains valid while divergent namespace or attribute contracts fail before rendering
- **AND** automated tests cover install waiting, upgrade/retry idempotency, immutable-Job safety, bounded failure, and secret-safe rendering
- **AND** operator guidance requires namespace/readiness verification before rollback, otherwise directs correction and fail-forward retry
- **AND** disposable acceptance cleans up only the test installation and never deletes shared Temporal application state

#### Scenario: Global and live acceptance remain mandatory publication gates

- **WHEN** all focused render, process, OCI, compatibility, and operator-procedure tests pass but the unfiltered global suite or disposable live release sequence has not completed
- **THEN** the change remains incomplete and MUST NOT be published or described as independently accepted
- **AND** the global suite runs unfiltered exactly once for the acceptance record and the live gate proves install, upgrade, retry, rollback, readiness, release metadata, state preservation, and cleanup
- **AND** independent re-review occurs only after both gates have evidence and must resolve every remaining blocker

### Requirement: Operator procedures resolve revision Jobs and legacy image migration exactly

Falcone SHALL provide public, executable operator procedures that locate the Temporal bootstrap Job without assuming an untruncated fixed name and that migrate legacy admin-tools image values without guesswork. Job discovery SHALL invoke `helm history` with the explicit release namespace and derive `ACTIVE` as the single revision whose status is `deployed`. It SHALL then read the stored deployed manifest using `helm get manifest --revision ACTIVE`, extract exactly one `Job` whose component is `temporal-bootstrap`, validate its effective revision label as a positive integer and its effective lifecycle label as `install` or `upgrade`, and construct the live selector from those effective stored-manifest labels. It MUST NOT assume the effective bootstrap revision equals `ACTIVE`, because Helm rollback creates a new active history revision while replaying the source revision's stored manifest metadata. Zero or multiple deployed history revisions, zero or multiple bootstrap Jobs in the stored manifest, invalid effective labels, and zero or multiple live Job matches SHALL terminate with a bounded diagnostic that identifies release, namespace, active revision, effective revision, effective lifecycle, complete selector, cardinality, and corrective action. Migration guidance SHALL be linked from the chart README and SHALL provide copyable values or commands for repository, tag, optional digest, and pull policy plus post-render Job/gate parity verification.

#### Scenario: Public Job selectors resolve install upgrade and truncated release names

- **WHEN** an operator runs the documented Job-discovery procedure for an install revision, an upgrade revision, or a release name long enough to trigger DNS-name truncation
- **THEN** the procedure resolves exactly the revision-scoped Temporal bootstrap Job for that release, revision, and lifecycle
- **AND** it does not construct a stale fixed name that omits the upgrade phase or Helm truncation behavior
- **AND** zero or multiple matches fail closed with a bounded actionable diagnostic

#### Scenario: Executable Job discovery derives lifecycle and enforces exact cardinality

- **WHEN** the published procedure is executed against controlled Helm history and Kubernetes Job fixtures representing zero, one, and multiple matches
- **THEN** it invokes `helm history` for the supplied release with `-n` and the supplied namespace, derives the active revision and install-or-upgrade lifecycle, and builds the complete metadata selector without a prefilled `JOB_NAME`
- **AND** exactly one match emits that Job for subsequent observation
- **AND** zero or multiple matches exit non-zero with a diagnostic naming release, namespace, revision, lifecycle, selector, cardinality and corrective action

#### Scenario: Job discovery cardinality failures include complete fail-forward context

- **WHEN** the executable operator procedure resolves zero Jobs or more than one Job for the derived active release state
- **THEN** it exits non-zero and the terminal diagnostic includes the release, namespace, revision, lifecycle, complete selector, and observed cardinality
- **AND** the diagnostic includes both a `correct or resolve` action and `retry to fail forward safely` guidance specific to the selector mismatch
- **AND** an assertion that checks only the numeric count does not satisfy the contract

#### Scenario: Rollback Job discovery follows the deployed stored manifest metadata

- **WHEN** Helm history has exactly one `deployed` active revision and that revision is a rollback such as active `r5` replaying the stored manifest from source revision `r2`
- **THEN** the procedure derives `ACTIVE` from the unique deployed history row and reads `helm get manifest` for that active revision
- **AND** it extracts exactly one stored `Job` with component `temporal-bootstrap`, validates the Job's effective revision as positive and lifecycle as `install` or `upgrade`, and builds the live selector from those effective labels
- **AND** it does not require the effective stored-manifest revision to equal the active Helm history revision
- **AND** install `r1`, upgrade `r2`, retry/fail-forward revisions, rollback `r5` to stored `r2`, zero or two stored bootstrap Jobs, invalid effective labels, and zero or two live matches are handled deterministically
- **AND** every failure identifies release, namespace, active revision, effective revision, effective lifecycle, complete selector and corrective fail-forward guidance

#### Scenario: Legacy image migration is copyable and linked from the chart README

- **WHEN** render validation rejects a custom `temporal.adminTools.image` because it is missing from or diverges from `global.temporalAdminToolsImage`
- **THEN** the chart README links directly to the migration procedure
- **AND** the procedure gives a copyable values block or command that transfers repository, tag, optional digest, and pull policy to the canonical global path
- **AND** it covers absent-versus-empty digest normalization and verifies the rendered Job and gate use one identical effective image before retry

### Requirement: Temporal remediation remains isolated from unrelated bootstrap capabilities

The remediation SHALL modify only the Temporal bootstrap lifecycle and the generic wiring strictly necessary to render its mandatory gate. It MUST NOT change the behavior or rendered contract of unrelated Keycloak database initialization or alter any Knative image pin. Scope verification SHALL compare the affected Keycloak initialization artifact and Knative image values with the authoritative branch base and fail on any unrelated drift.

#### Scenario: Temporal remediation preserves unrelated Keycloak database initialization

- **WHEN** the remediation diff is compared with authoritative base commit `41922e9d`
- **THEN** the Keycloak database initialization template and its rendered behavior are byte-for-byte unchanged
- **AND** no Temporal test, helper, documentation, or migration requires a `keycloak-db-init` change
- **AND** any such unrelated diff is removed before global validation and independent re-review

#### Scenario: Temporal remediation does not change Knative image pins

- **WHEN** the remediation diff is compared with authoritative base commit `41922e9d`
- **THEN** every Knative image repository, tag, and digest remains byte-for-byte unchanged
- **AND** no Temporal bootstrap requirement, test, helper, migration, or operator procedure depends on a Knative image-pin change
- **AND** any unrelated Knative pin drift is removed before global validation and independent re-review

#### Scenario: Knative image pins are byte-exact against the authoritative base

- **WHEN** an executable scope test compares the remediation with authoritative base commit `41922e9d`
- **THEN** every Knative image repository, tag, and digest value is byte-for-byte identical to the base
- **AND** the test fails when a synthetic repository, tag, or digest drift is introduced
- **AND** task completion cannot rely only on source inspection, a task assertion, or an unrelated diffcheck
