## Context

The chart currently renders one `temporal-bootstrap` Job with the stable release-derived name and `helm.sh/hook: post-install,post-upgrade` (`charts/in-falcone/templates/temporal/bootstrap-job.yaml::temporal-bootstrap Job:14-27`). That Job waits for the Temporal frontend, creates the application namespace if absent, and registers configured search attributes (`charts/in-falcone/templates/temporal/bootstrap-job.yaml::bootstrap script:48-97`).

The workflow worker targets `falcone-flows` and becomes Ready only after it is polling Temporal (`charts/in-falcone/values.yaml::workflowWorker:3905-3985`). During a clean install with Helm waiting for Deployments, the worker therefore waits on state created only by a post-install hook, while Helm waits on the worker before launching that hook. In addition, the frontend health loop exhausts its attempts without an explicit failure and can continue into namespace mutation.

The solution must work for clean install, ordinary upgrade, fail-forward recovery of a failed release, and compatible rollback. It must not need Kubernetes API credentials: all desired state is reconciled through the Temporal CLI against the internal frontend.

Independent review of the first implementation found four cross-cutting gaps: the admin-tools readiness gate relied on the image's named `User temporal` under vanilla kubelet validation; bespoke Temporal templates retained fixed `1000:1000` identities under the OpenShift restricted profile; `workflowWorker.initContainers` allowed inherited or user values to remove the required gate; and several terminal namespace/attribute failures lacked a namespace, finite bound, or complete fail-forward guidance. Full-suite, disposable-cluster, and final independent acceptance remain pending until those blockers are corrected.

The second independent review also returned `REQUEST_CHANGES`. It found that inherited `temporal.securityContext` IDs could survive in some OpenShift containers, `workflowWorker.wrapper.componentId` could bypass the required gate, the Job and gate had separate admin-tools image authorities, terminal frontend/gate branches still used incomplete or non-numeric bounds, and image-user evidence did not deterministically cover server, admin-tools, and UI artifacts. Helm's values boundary makes the image correction architectural: the component-wrapper subchart cannot read the parent-only `temporal.adminTools.image`, while Helm automatically propagates `global.*`. Global, disposable live, and final re-review gates remain open.

The third independent review returned `REQUEST_CHANGES` with `CHAIN_STATUS: incomplete`. Its six blocking findings are: supported UID/GID/fsGroup overrides need semantic vanilla/OpenShift coverage plus kubeconform; legacy/global image equality must normalize absent and empty digests; OCI identity proof must retain a raw cryptographically digest-bound manifest/config/filesystem chain; the public bootstrap-Job selector must cover install, upgrade, and truncated release names; migration must be copyable and linked from the chart README; and unrelated `keycloak-db-init` drift must be removed relative to authoritative base `41922e9d`. These blockers reopen focused correction and re-review; global and disposable-live validation remain pending.

The fourth independent review returned `REQUEST_CHANGES` with `CHAIN_STATUS: incomplete`. Its eight blockers are: vanilla must use `1000:1000` only as the default and preserve supported positive identity overrides while OpenShift strips fixed IDs; reserved-gate collision validation must use effective post-`tpl` user init-container names; OCI identity evidence must reconstruct the final filesystem across every layer and whiteout; real Helm reuse of pre-global values must keep exact defaults operable and reject unmigrated custom legacy images; the public selector must execute namespaced Helm-history discovery and enforce zero/one/multiple cardinality; unrelated Knative image-pin drift must be removed; install/upgrade/retry/rollback claims must be proven against actual release state or explicitly narrowed to offline predictions; and the global plus disposable-live gates remain incomplete. The prior 43/43 focused result does not satisfy these expanded contracts.

The fifth independent review returned literal `VERDICT: REQUEST_CHANGES` and `CHAIN_STATUS: incomplete`. It found that the values schema still required `global.temporalAdminToolsImage`, so a real release created from base `41922e9d` could not reach compatibility handling under `--reuse-values`; `bbx045` had not exercised actual stored release values. OCI verification used a fixed 232 MiB cache and its overlay implementation did not cover root or arbitrary parent whiteouts. The published zero/multiple Job diagnostics omitted release, namespace, revision, lifecycle, selector, and corrective fail-forward action because the focused test checked only cardinality. Finally, task 1.19 claimed byte-exact Knative isolation without an executable comparison. These four claims are reopened; global, disposable live, final re-review, and bookkeeping remain pending.

The first disposable live sequence ran on Kubernetes context exactly `default`, inside vCluster `ftb-a73c`, with host namespace `falcone-tb-live-20260814-a73c`. It proved real base-`41922e9d` stored default values without the global image object upgrade successfully under current `--reuse-values` with Job/gate image parity and readiness. A custom legacy image failed closed without mutation; copying repository, tag, optional digest, and pull policy to the canonical global object then succeeded. Current-chart clean install revision 1 converged with Helm waiting for Jobs and workloads Ready, revision 2 upgraded, revision 3 failed with bounded diagnostics without state loss, revision 4 failed forward with a distinct retained Job, rollback to source revision 2 created active Helm revision 5 while preserving Temporal state, and revision 6 restored the current chart. Evidence contained no Secrets, cleanup was complete, and staging remained unchanged. This Kubernetes run did not provide live OpenShift/SCC evidence.

The first live sequence exposed one blocker: at active rollback revision 5, the selector derived revision 5 and returned zero Jobs because Helm replayed the source revision 2 stored manifest and its Job retained effective revision/lifecycle labels from revision 2. Therefore history identifies the active stored manifest, not necessarily the labels inside it. The corrected procedure reads the active revision's stored manifest, extracts exactly one Temporal bootstrap Job, and uses its validated effective metadata.

A bounded rerun proved that correction on Kubernetes context exactly `default` backed by K3s, in vCluster `frb-b91e` and host namespace `falcone-tb-rollback-20260814-b91e`. Current install revision 1 rendered bootstrap TTL 3600, upgrade revision 2 succeeded, and rollback created active revision 3 whose stored manifest correctly exposed effective revision 1/lifecycle `install`. The procedure selected exactly one live Job from those effective labels. All five `Keyword` attributes remained and workflow readiness was 2/2. Evidence contained no Secrets, cleanup completed, and staging remained intact. The literal harness block was not invoked only because its cleanup used prohibited `rm -f`; the same commands passed with the harness-approved cleanup-only `find` deletion. This K3s acceptance makes no OpenShift-live claim; OpenShift remains covered by the already-passing render and kubeconform contracts.

The first post-live unfiltered global diagnostic run executed exactly one `bash tests/blackbox/run.sh`: 20 files and 484 tests produced 483 pass, one fail, zero skip/cancel/todo, duration 1744354.42578 ms, and exit 1. The complete Temporal slice remained 50/50 GREEN, including `bbx046` and `bbx048`. Only `bbx-8-003` failed because expected baseline `66460fb...d97ad1` differed from actual `330c39fc...31ee`. Worktree status before and after was byte-identical at 2137 bytes with SHA-256 `35a09a89419eae794975ed3680dad1a26eddeaa21a5272c3b51b23a145e449ea`, and no artifacts remained. This run is diagnostic evidence, not the mandatory clean acceptance record. The isolated baseline contract must reproduce three times and pass focused validation before one authorized final global run.

Baseline reconciliation then reproduced `bbx-8-003` in three isolated processes selected by exact title. All three returned actual SHA-256 `330c39fcdbae7ebc9edc4f4f3a4a408c849445cf8fe32567a0369c73d93531ee` against expected `66460fb...d97ad1`, with test/total durations 15574.901252/15645.672184 ms, 15176.836961/15245.351975 ms, and 15830.621842/15900.78587 ms. Default and explicit-disabled renders were byte-identical and contained neither `falcone.knative-runtime/lifecycle` nor `KNATIVE_RUNTIME_MODE`; raw SHA `cc111e...` was informational, no packaged `.tgz` existed, and ESO `Chart.lock` `e25decc...` was preserved. Only the authoritative fixture changed. The post-update focal passed 1/1, exit 0, with test/total durations 15533.863897/15601.320765 ms; Node syntax, formatting, and focused diffcheck also passed, satisfying the prerequisite for the final unfiltered global acceptance run.

The final authoritative global acceptance then invoked exactly one `bash tests/blackbox/run.sh`. All 20 files and 484/484 tests passed with zero fail, skip, cancel, or todo, exit 0, duration 1733813.435611 ms, and overall black-box PASS. Temporal passed 50/50 from `bbx001` through `bbx050`, including `bbx046`, `bbx048`, and `bbx050`; `bbx-8-003` passed in 15678.619203 ms against reconciled baseline `330c39...`. Branch/HEAD remained `fix/temporal-bootstrap-namespace-readiness @ 41922e9d...`; pre/post NUL status was byte-identical at 2137 bytes with SHA-256 `35a09a...`. The 20-file discovered list was 1622 bytes with SHA-256 `0d5fa2...`, and all test paths were 3294 bytes with SHA-256 `01f5b1...`. No artifacts or edits remained, no cluster was mutated, and no Playwright output was produced. Final independent re-review and bookkeeping remain the only open gates.

The subsequent independent review returned `APPROVE`, `BLOCKING: none`, and `CHAIN_STATUS: complete`. It also reported non-blocking finding #1: sufficiently long release names can make the mandatory workflow gate reconstruct a Temporal frontend hostname that diverges from the DNS-safe truncated Service name. The team voluntarily promoted that finding for correction before the PR, so the approval remains evidence for the reviewed chain but a new focused RED, fix, recheck, and independent re-review are required. Non-blocking documentation polish #2 also remains: the runbook must accurately declare Bash plus `awk` and `sed` rather than POSIX-shell compatibility, and its YAML migration blocks should move to the Admin-tools section without changing the procedure.

The long-release cycle captured an authentic `bbx051` RED at 0/1, exit 1, test/total 528.675165/618.305496 ms: Service and Job used `<53r>-temporal:7233`, while the mandatory gate used `<53r>-temporal-frontend:7233`. The first correction fixed the gate but missed three main consumers; the independent checker remained RED at 0/1 with test/total 541.894635/633.481873 ms. The second correction moved those consumers to the shared value. Final checker `bbx051` passed 1/1, exit 0, test/total 536.927845/622.319052 ms. One complete Temporal focal passed 51/51, exit 0, duration 65514.005973 ms; `bbx051` took 442.551692 ms and `bbx037`, `bbx041`, `bbx046`, `bbx048`, `bbx049`, and `bbx050` took 16686.062127, 0.604961, 687.089633, 2429.451013, 82.517909, and 3.947075 ms respectively. Node syntax ran twice and passed; jq, OCI cache absence, lint, strict OpenSpec, and focused diffcheck also passed. Documentation polish #2 is complete. Because this delta follows the prior global record, authoritative baseline reconciliation, one post-delta global run, and a fresh independent re-review remain required.

Post-long-release baseline reconciliation was a no-op. Three isolated exact-title processes all passed with fixture SHA-256 `330c39fcdbae7ebc9edc4f4f3a4a408c849445cf8fe32567a0369c73d93531ee`; test/total durations were 15201.939238/15271.300684 ms, 14655.220995/14725.196037 ms, and 15209.560557/15279.413034 ms. Every run kept default and explicit-disabled byte-identical and contained neither `KNATIVE_RUNTIME_MODE` nor `falcone.knative` wiring. No fixture write occurred. A final focused 1/1 passed with test/total 15022.737141/15091.030355 ms. No packaged `.tgz` existed, ESO `Chart.lock` `e25decc...` stayed intact, and Node syntax, formatting, expected-value, and focused diff checks passed, clearing the prerequisite for the post-delta global.

The final authoritative post-delta global invoked exactly one `bash tests/blackbox/run.sh`: 20 files, 485/485 pass, zero fail/skip/cancel/todo, exit 0, duration 1736568.600687 ms, and overall PASS. Temporal remained 51/51 GREEN; `bbx051` passed in 443.433569 ms and `bbx-8-003` passed in 15258.86027 ms against baseline `330c39...`. Branch/HEAD remained `fix/temporal-bootstrap-namespace-readiness @ 41922e9d...`; pre/post NUL status was byte-identical at 2137 bytes with SHA-256 `35a09a...`. Discovery contained 20 files/1622 bytes with SHA-256 `0d5fa2`, and the full fileset was 3294 bytes with SHA-256 `01f5b1`. No artifacts or edits remained and no cluster mutation occurred. Only fresh independent re-review and final bookkeeping remain open.

## Goals / Non-Goals

**Goals:**

- Make namespace reconciliation eligible during the main Helm install/upgrade phase so `--wait` can converge.
- Give each Helm revision a replaceable bootstrap execution identity and avoid immutable Job-template patches.
- Reconcile the namespace and all five configured Keyword search attributes idempotently and verify convergence.
- Stop before mutation when frontend health never converges; preserve existing state on every later failure.
- Preserve existing values, images, restricted security, network, retention, and Temporal data contracts.
- Fail closed on the previously ineffective non-default namespace authoring and accept the exact five `Keyword` attributes in any order.
- Make the bootstrap-state gate chart-owned and non-removable while preserving user init containers additively.
- Fail before render if the established workflow component identity is omitted or changed, so it cannot bypass gate ownership.
- Resolve the Job and mandatory gate from one subchart-visible `global.temporalAdminToolsImage` and pull-secret contract; equality-validate the legacy parent path and fail closed with migration guidance on historical custom drift.
- Start every chart-owned Temporal container with image-compatible numeric identities on vanilla Kubernetes and SCC-assigned arbitrary identities on OpenShift.
- Preserve supported positive numeric identity overrides on vanilla, strip them on OpenShift, and schema-validate both full manifest sets.
- Reject a user init-container collision after its name has been fully expanded with Helm `tpl`.
- Verify the server, admin-tools, and UI named-user mappings deterministically from compact byte-exact OCI metadata, registry-read-only digest-bound layers in disposable storage, and the final filesystem after ordered layers and whiteouts.
- Make every terminal reconciliation and gate diagnostic namespace-specific, bounded, actionable, and secret-safe.
- Make the active revision Job discoverable exactly across install, upgrade, and Helm-compatible name truncation.
- Provide a chart-README-linked, copyable legacy-to-global image migration and parity check.
- Exercise exact-default and custom pre-global reused values through actual Helm release history.
- Keep unrelated Keycloak database initialization and Knative image pins byte-for-byte outside this remediation.
- Distinguish offline render predictions from actual active-release evidence across install, upgrade, retry, and rollback.
- Provide deterministic tests and disposable install/upgrade evidence plus operator recovery and rollback guidance.

**Non-Goals:**

- Introducing a long-running Temporal controller, Kubernetes RBAC, or a ServiceAccount token for bootstrap.
- Changing Temporal authentication, public APIs, namespace tenancy, retention defaults, search-attribute names/types, task queues, or stored workflow histories.
- Rebuilding or changing the pinned Temporal server or admin-tools images solely to replace their named `User` declarations.
- Making bootstrap destructive, automatically rolling back Temporal state, or deleting a shared Temporal namespace during cleanup.
- Changing the readiness implementation inside application images when their existing readiness already fails closed until Temporal polling succeeds.

## Decisions

### 1. Render one ordinary revision-scoped Job in every Helm revision

The Temporal bootstrap SHALL be an ordinary chart resource on install, upgrade, recovery, and rollback. It SHALL have no pre/post Helm hook annotations. Its DNS-safe name SHALL retain a suffix derived from `.Release.Revision` after length truncation, so every Helm revision creates a new Job instead of patching the immutable pod template of a prior completed or failed Job.

An ordinary resource is submitted in the same main phase as the Temporal Deployments and workflow consumers. It may wait for the new revision's frontend while Helm waits for consumer readiness. This also permits fail-forward recovery when the frontend itself needs changes from the new revision; a `pre-upgrade` hook could only see the old/broken frontend and would block those changes.

Prior revision Jobs remain safe to remove through Helm's normal release diff and the existing TTL-after-finished policy. No hook delete policy is needed. A retry through a new Helm revision receives a fresh identity, while Temporal-side operations remain idempotent.

Offline rendering proves only the predicted revision-scoped name, metadata, selector inputs, and immutable Job template for supplied release parameters. It does not prove which revision Helm records as active or which Job remains observable after install, upgrade, failed retry, or rollback; those claims require the disposable live sequence.

Alternatives rejected:

- Keep `post-install`/`post-upgrade`: preserves the clean-install readiness cycle.
- Use `pre-install`: bootstrap cannot reach a frontend that has not been installed.
- Use `pre-upgrade`: blocks a fail-forward revision whose frontend fix must deploy before reconciliation can succeed.
- Keep a stable ordinary Job name: Helm can attempt an illegal patch to its immutable template.
- Add a long-running controller or duplicate the logic in every consumer: expands privileges, race surface, and operational ownership without need.

### 2. Use application readiness as the release gate

The ordinary Job starts independently, waits for Temporal frontend health against the always-present `temporal-system` namespace, and then reconciles application state. Temporal-dependent consumers retain their fail-closed application readiness probes; in particular, the workflow worker reports Ready only after polling the configured application namespace. Thus a plain Helm `--wait` is gated by usable runtime state even when `--wait-for-jobs` is not supplied, while `--wait-for-jobs` can additionally observe Job completion.

Workflow consumers wait for the exact Temporal bootstrap state. The workflow worker has one tokenless admin-tools init gate that waits for frontend health, the configured namespace, and all five configured Keyword search attributes. It exits with bounded fail-forward diagnostics before the application container starts when any condition is absent or incompatible. The gate uses no Kubernetes API credentials, Secret, or RBAC contract.

The mandatory gate is not sourced from the replaceable public `workflowWorker.initContainers` list. The chart or component wrapper renders it through a reserved, authoritative path and then appends valid user init containers. An inherited empty list cannot remove it; a user list remains additive. Collision validation expands each user init-container name through the same Helm `tpl` path used by rendering and compares the resulting effective name with the reserved gate identity. A raw authored name that looks different but evaluates to the reserved name fails before workload rendering. The mandatory gate runs before user additions so Temporal state is known usable before any user init that may depend on it.

Gate ownership is also bound to the established `workflowWorker.wrapper.componentId=workflow-worker`. Validation runs before subchart workload rendering and rejects omission or divergence of that identifier. The wrapper never interprets an arbitrary component ID as permission to omit the gate; historical values using the established identity remain valid.

Alternatives rejected:

- Keep the gate as the default value of `workflowWorker.initContainers`: `--reuse-values`, `--set-json ...=[]`, or a complete user list can replace it.
- Key gate rendering only on a user-overridable component identifier without validation: changing the identifier silently bypasses the safety boundary.
- Reject every non-empty user init-container list: unnecessarily removes an established extension point.
- Depend only on the workflow application's later readiness probe: the process can crash or restart while targeting a namespace the bootstrap Job has not yet converged.

### 3. Reconcile additively, idempotently, and with read-after-write verification

After frontend health succeeds, the Job SHALL:

1. describe the configured namespace;
2. create it only when absent, tolerating an AlreadyExists race only after a successful describe verifies it;
3. enumerate all configured search attributes;
4. create only missing attributes;
5. verify every desired attribute exists with its configured type before completing.

An existing compatible namespace or attribute is success. A missing object is additive. An incompatible type, create failure, or verification mismatch is a non-zero failure; the Job never deletes or rewrites namespaces, histories, or search attributes. The current values API remains authoritative, including the five default Keyword attributes.

All rendered consumers already target `falcone-flows`. Until a future cross-layer capability introduces a genuinely shared configurable source, the chart rejects any other `temporal.bootstrap.namespace` before rendering. The search-attribute validation is set-based: it accepts any ordering of the exact five unique `Keyword` entries and rejects missing, duplicate, additional, or differently typed entries. This converts previously accepted-but-broken producer/consumer drift into an actionable pre-render failure without migrating Temporal data.

### 4. Make every retry boundary explicit and fail closed

The frontend loop SHALL track whether health succeeded. Exhaustion SHALL emit one bounded diagnostic and exit non-zero before namespace describe/create or search-attribute operations. Namespace and per-attribute retries SHALL also have finite bounds within `activeDeadlineSeconds`, followed by read-after-write verification.

Every terminal branch in both the reconciler and mandatory gate names the configured namespace, phase or attribute, and a numeric finite attempt count or active-deadline value. This includes both frontend-health loops, namespace read-after-create/describe failure, incompatible attribute type, per-attribute retry exhaustion, list transport/parsing failure, missing attribute, and final atomic read-back drift. The word `bounded` without a number is insufficient. Each message contains `correct or resolve` plus `retry to fail forward safely`; none prints provider response bodies, credentials, environment dumps, or Secret values. Failure preserves partial compatible state so the next revision can resume idempotently.

### 5. Apply the platform-specific numeric identity matrix to every chart-owned Temporal container

Vanilla default renders set numeric `runAsUser: 1000` and `runAsGroup: 1000` for the Temporal server and Web UI containers, the server worker's `wait-for-frontend` init container, the revision-scoped bootstrap container, and the workflow bootstrap-state gate only where no supported override applies. The defaults match the effective UID/GID of all three pinned Temporal images and avoid kubelet's `runAsNonRoot` rejection when an image declares the non-numeric username `temporal`.

Supported positive numeric overrides from `temporal.podSecurityContext` and `temporal.securityContext`, including pod `fsGroup`, remain effective at their documented scopes on vanilla Kubernetes. The OpenShift render removes those same fixed identities after all values have merged. Both complete render profiles must pass kubeconform or the repository's equivalent Kubernetes schema gate, so identity transformation cannot produce structurally invalid manifests.

OpenShift restricted renders remove fixed `runAsUser`, `runAsGroup`, and `fsGroup` at both pod and container scope for the same chart-owned workload set, including bespoke Temporal templates that do not pass through the generic component-wrapper stripping path. The removal is applied to a deep copy after defaults and inherited `temporal.podSecurityContext`/`temporal.securityContext` values are merged, so a reused value cannot reintroduce a fixed ID. Restricted SCC then assigns namespace-range identities. Both paths retain `runAsNonRoot`, RuntimeDefault seccomp, disabled privilege escalation, and dropped capabilities.

Tests inspect every rendered chart-owned Temporal container semantically rather than grepping one values stanza. Deterministic image verification versions only compact byte-exact OCI index, manifest, and config evidence whose hashes close the pinned image chain. For every manifest-declared filesystem layer, it performs a read-only Docker Hub retrieval by immutable digest into a unique per-run temporary directory, verifies the layer's SHA digest and declared size, and then applies all layers in order. Overlay processing handles ordinary replacement, file whiteouts, and opaque-directory markers at the root and below any parent rather than special-casing `/etc`. Adversarial synthetic fixtures cover root deletion, parent deletion, nested opacity, and later recreation. `Config.User=temporal` must resolve through the final verified `/etc/passwd` and `/etc/group` to `1000:1000`; an unbound summary or arbitrarily chosen layer is insufficient. A `finally`/trap cleanup removes downloaded and extracted content after success or any failure, so no fixed 232 MiB cache or committed blob remains. The reconstruction is cryptographically closed but intentionally not fully offline. OpenShift tests assert omission at pod and container scope and do not claim a specific SCC-assigned UID/GID from render-only evidence.

Alternatives rejected:

- Rely on the named image user with only `runAsNonRoot: true`: kubelet cannot prove a named user is non-root before container creation.
- Keep `1000:1000` in OpenShift pod security contexts: blocks arbitrary UID assignment under restricted SCC.
- Strip only generic component-wrapper workloads: leaves the custom Temporal Job and Deployments inconsistent.

### 6. Resolve the Job and gate from one global admin-tools image authority

`global.temporalAdminToolsImage` is the only authority for the Temporal CLI used by the revision-scoped Job and mandatory workflow gate. `global.*` is the required boundary because Helm propagates it into the component-wrapper subchart; the subchart cannot safely read the parent's `temporal.adminTools.image`. The canonical defaults exactly mirror the historical image: `docker.io/temporalio/admin-tools:1.31.1`, no digest, `IfNotPresent`.

The effective repository, tag, optional digest, pull policy, global registry rewrite and normalized global/private-registry pull-secret set are identical in both pods. A canonical override changes both. `workflowWorker.temporalBootstrapImage` is rejected if authored, and the wrapper defines no hard-coded fallback that can drift.

`temporal.adminTools.image` remains in the values/schema surface solely for compatibility. Validation normalizes repository, tag, optional digest and pull policy and requires equality with the global authority. A mismatch fails before manifests with a bounded diagnostic naming both paths and instructing the operator to copy all fields to `global.temporalAdminToolsImage`. A reused historical custom legacy image without the new global object also fails closed; silently choosing canonical defaults would change the installed CLI. A historical legacy value equal to exact defaults remains compatible.

Compatibility is evaluated as a tri-state contract: the exact historical default is neutral and permits a canonical override; a custom legacy value identical to the canonical global object is compatible; and a custom legacy value with a missing or different canonical object fails migration validation. Optional digest comparison normalizes absent/empty values, while a non-empty canonical digest is preserved by both rendering helpers so Job and gate resolve the same digest-qualified image rather than diverging on tag handling.

This compatibility must also work through Helm's real stored-value behavior. Acceptance installs the chart and values/schema from base `41922e9d`, then applies the new chart with actual `--reuse-values`. The new schema cannot unconditionally require an authored `global.temporalAdminToolsImage`, because that would reject historical stored values before compatibility validation. Exact historical-default legacy input without a stored global object remains operable and yields the canonical default in Job and gate. A custom legacy image without an equal stored canonical global object reaches compatibility validation and fails before rendering with the copy-and-retry migration path. A direct `helm template` merge or fabricated values object is useful unit evidence but cannot substitute for stored release-value behavior.

Alternatives rejected:

- Read `temporal.adminTools.image` directly from component-wrapper: Helm subcharts cannot read arbitrary parent values.
- Duplicate the current admin-tools defaults under workflow-worker values: tag, digest, registry rewriting and pull policy can drift independently.
- Let component-wrapper fall back to a hard-coded admin-tools image: bypasses the chart's canonical override and global registry/air-gap contract.
- Silently prefer global over a divergent historical custom legacy value: changes the runtime CLI during `--reuse-values` without operator migration.
- Reuse the workflow-worker application image for the gate: it does not own the required Temporal CLI contract.

### 7. Make revision-Job discovery and image migration executable

The public operator procedure discovers the bootstrap Job by chart-owned release, revision, and lifecycle metadata instead of constructing a fixed name. Starting only from operator-supplied release and namespace, it invokes namespaced `helm history` and requires exactly one row with status `deployed`; that row supplies `ACTIVE`. It then reads `helm get manifest` for `ACTIVE`, extracts exactly one `Job` with component `temporal-bootstrap`, and validates the stored Job's effective revision label as positive plus lifecycle label as `install` or `upgrade`. The complete Kubernetes selector uses those effective stored-manifest labels, which may differ from `ACTIVE` after rollback. It handles Helm-compatible truncation of long release names. Zero or multiple active history rows, stored bootstrap Jobs, or live matches—and invalid stored labels—fail closed with an actionable bounded diagnostic that includes release, namespace, active revision, effective revision, effective lifecycle, complete selector, observed cardinality, `correct or resolve`, and `retry to fail forward safely`. Executable acceptance stubs install, upgrade, retry, rollback, history/manifest/live cardinalities, and does not prefill `JOB_NAME`, revision, or lifecycle.

Legacy-image migration is a copyable values block or command linked directly from the chart README. It transfers repository, tag, optional digest, and pull policy from `temporal.adminTools.image` to `global.temporalAdminToolsImage`, explains that an omitted digest and `digest: ""` are equivalent, and verifies that Job and gate render one identical effective image before retry.

Alternatives rejected:

- Construct a Job name from an assumed suffix: install/upgrade lifecycle and DNS truncation make that stale or ambiguous.
- Describe the migration only in a release note: operators encountering pre-render failure need a durable chart entry point and copyable recovery procedure.
- Select the first matching Job: ambiguity can report or act on the wrong Helm revision.

### 8. Preserve unrelated capability scope

This remediation does not change the Keycloak database initialization template, render contract, tests, helpers, or guidance, and it does not change any Knative image repository, tag, or digest. A focused executable comparison against authoritative base `41922e9d` verifies that `keycloak-db-init` and every Knative image pin are byte-for-byte unchanged. Negative fixtures perturb a Knative repository, tag, and digest independently and must fail the scope test. A task assertion or unrelated generic diffcheck is insufficient. Any unrelated drift is removed before global validation and independent re-review.

### 9. Preserve the existing secret-free restricted execution model

The Job continues to use the chart-routed pinned admin-tools image, `automountServiceAccountToken: false`, non-root pod/container contexts, disabled privilege escalation, and dropped capabilities. It receives only the frontend address, namespace, retention and non-sensitive desired attributes. It has no Secret environment source, Secret volume, Kubernetes API RBAC, or plaintext credential.

No new persistence is introduced. Job completion and Temporal read-after-write state are the only success evidence.

### 10. Preserve state across adoption, retry, and compatible rollback

Adoption requires no values or Temporal data migration. The first revision with this change reconciles the existing namespace and attributes, then normal revisions repeat the same additive verification. Each rollback is itself a new Helm revision and therefore receives a fresh bootstrap Job identity when the target chart contains this lifecycle.

The disposable live sequence records Helm history and Jobs after install revision 1, upgrade revision 2, bounded failure revision 3, fail-forward revision 4, rollback active revision 5, and current-chart restore revision 6. At every transition it verifies the single deployed active revision identifies one stored manifest, then the exactly-one bootstrap Job in that manifest supplies effective selector metadata; this accounts for rollback replaying source-revision labels. It also verifies Helm never patches an immutable completed or failed Job template. Offline `bbx048` proves only stored-value coalescence and captured post-render output, not actual apply; the disposable sequence is the evidence for real Helm application. OpenShift identity remains render/kubeconform evidence until separately proven live.

Rolling back to a compatible earlier chart does not undo or delete Temporal state. Operators SHALL verify that the configured namespace remains usable before rollback; if bootstrap state is incomplete or incompatible, the safe path is to correct the cause and retry forward. No chart path attempts compensating deletion.

### 11. Verify behavior at render, process, and disposable-cluster boundaries

Render contracts SHALL trace the literal OpenSpec scenario headers and assert ordinary lifecycle, revision-scoped identity, fixed workflow component identity, no pre/post bootstrap hook, post-`tpl` reserved-name rejection, non-removable plus additive init-container composition, one global admin-tools image/pull contract, absent/empty legacy digest normalization, vanilla identity defaults and overrides, inherited-ID stripping for OpenShift, kubeconform in both profiles, exact install/upgrade/truncation Job selection, retained values, complete numeric diagnostics, least privilege, and no unrelated Keycloak or Knative drift. Deterministic image tests SHALL verify compact byte-exact index/manifest/config metadata, read-only per-digest retrieval with SHA/size validation, the all-layer chain, and final whiteout-aware filesystem for exact server/admin-tools/UI OCI artifacts without committing layer blobs. Process-isolated tests SHALL execute the rendered POSIX shell with fake Temporal CLI behavior for clean creation, existing-state upgrade, repeated reconciliation, frontend exhaustion, partial failure, verification drift, and sentinel-secret absence. Stored-value tests SHALL exercise an actual pre-global Helm release upgraded with reused exact-default and custom legacy values. Operator tests SHALL execute namespaced history discovery and zero/one/multiple Job cardinalities.

A disposable Kubernetes acceptance SHALL exercise clean install with Helm waiting, an idempotent upgrade, a failed attempt followed by fail-forward retry, Job identity replacement, namespace/search-attribute convergence, dependent readiness, and resource cleanup. It SHALL use an explicitly verified non-production context and isolated installation; it SHALL not mutate shared staging state or delete shared Temporal data. Operator guidance SHALL cover verification signals, bounded failures, retry, rollback preconditions, and disposable cleanup.

One unfiltered global black-box run and the disposable live sequence are independent mandatory gates. Focused success cannot close either. Final independent re-review occurs only after both and after the OpenSpec bookkeeping validation.

### 12. Reuse one DNS-safe Temporal frontend hostname

The chart owns one helper for the effective Temporal frontend Service hostname. It combines the release-derived prefix with `temporal-frontend`, applies `trunc 63`, and removes a trailing hyphen. The Service metadata name, bootstrap Job frontend address, and mandatory workflow gate `TEMPORAL_ADDRESS` all consume that helper result rather than reconstructing the name independently.

A render contract uses a release name of exactly 53 characters, long enough to force truncation. It asserts the Service hostname remains a valid DNS label of at most 63 characters and that both clients use it byte-for-byte. This correction changes only name derivation; it does not rename short-release Services or change ports, namespaces, credentials, readiness semantics, or Temporal state.

## Risks / Trade-offs

- **Revision-scoped Jobs briefly add one Job object per active revision** → retain the current TTL-after-finished setting and let Helm's release diff remove prior identities; test rapid upgrade/retry sequences.
- **A user who omits Helm waiting can receive command success before reconciliation finishes** → keep runtime readiness fail closed and document how to observe the revision-scoped Job and namespace convergence.
- **A broken frontend still consumes the bounded Job deadline** → fail before mutation with target-specific diagnostics and a fresh identity on the next fail-forward revision.
- **Temporal CLI output formats can drift between pinned image versions** → parse only the minimum namespace/attribute contract, pin the image, and test success, AlreadyExists, wrong type, and malformed output.
- **Rollback to a pre-fix chart reintroduces the post-hook implementation** → allow rollback only after the namespace is already verified usable; otherwise recover forward.
- **Application readiness behavior could drift from namespace usability** → keep an executable acceptance that proves the consumer remains unready before bootstrap and ready after convergence.
- **Moving the gate out of the user list can change init-container ordering** → reserve the mandatory gate first, append user entries in authored order, reject a duplicate reserved name, and test inherited/empty/non-empty values.
- **A future Temporal image can change its effective UID/GID** → inspect exact digest-bound server, admin-tools, and UI OCI config/passwd/group metadata and require chart IDs to match before release.
- **Custom Temporal templates can bypass generic OpenShift stripping** → inventory every Job/Deployment pod, init container, and container in both platform renders.
- **A workflow component-ID override can bypass wrapper-specific safety** → validate the exact supported identity before rendering and test omission plus divergent inherited/user values.
- **A duplicated gate image setting can drift from the Job or air-gap registry** → keep `global.temporalAdminToolsImage` as the sole subchart-visible authority and compare image, policy, rewrite and pull secrets in every profile.
- **Historical `--reuse-values` can carry only a custom legacy image** → fail before render with explicit field-copy migration guidance; never silently fall back to the new global defaults.
- **A supported identity override can be applied inconsistently** → render the full workload inventory in vanilla and OpenShift profiles and require schema conformance for both.
- **Compact image evidence can be detached from retrieved layers** → hash byte-exact index/manifest/config metadata, retrieve every layer by immutable digest, and verify layer SHA plus size before trusting user mappings.
- **A fixed-name operator command can select the wrong bootstrap Job** → select by release/revision/lifecycle metadata, require exactly one result, and test long release names.
- **Temporal-focused work can accumulate unrelated chart drift** → compare Keycloak database initialization with base `41922e9d` and remove any difference before global validation.
- **A templated user name can bypass a raw reserved-name comparison** → compare only effective post-`tpl` names and fail before workload rendering.
- **OCI identity data can come from a layer hidden by a later whiteout** → reconstruct the complete ordered filesystem from verified temporary layers and honor deletion plus opaque-directory semantics.
- **Full OCI layer fixtures exceed repository and hosting limits** → version only compact metadata, fetch public layers read-only by immutable digest into a unique per-run directory, and guarantee cleanup on success or failure.
- **A fixed OCI cache can retain hundreds of MiB across runs** → prohibit shared cache paths and assert `finally`/trap removal after injected download, hash, overlay, and identity failures.
- **A special-cased `/etc` overlay can miss root or parent whiteouts** → use a path-general overlay algorithm and adversarial synthetic root, parent, nested-opacity, and recreation fixtures.
- **Schema validation can preempt legacy compatibility** → install base `41922e9d`, reuse its actual stored values, and ensure exact-default omission reaches compatibility while custom drift fails closed there.
- **Selector tests can pass by checking only count** → assert every zero/multiple terminal diagnostic field and both corrective fail-forward clauses.
- **Rollback active revision can differ from replayed Job metadata** → use the unique deployed history revision only to retrieve its stored manifest, then derive the selector from exactly one stored bootstrap Job's validated effective labels.
- **A task claim can conceal Knative drift** → execute byte-exact positive and repository/tag/digest negative comparisons against base `41922e9d`.
- **Independent name reconstruction can diverge after DNS truncation** → centralize the frontend hostname helper and compare Service, Job, and gate values under an exact 53-character release name.
- **Direct values merging can misrepresent Helm `--reuse-values`** → create an actual pre-global release and exercise exact-default plus custom legacy upgrades.
- **A documented selector can look plausible without being executable** → stub and execute namespaced Helm history and Kubernetes cardinalities without prefilled derived variables.
- **Offline renders can overstate active release behavior** → label them as predictions and require disposable release transitions for history, active metadata, rollback and retained Job claims.
- **Temporal work can carry unrelated Knative image drift** → compare all Knative pins byte-for-byte with base `41922e9d` before global validation.

## Migration Plan

1. Add black-box tests and capture the pre-change failures for lifecycle, replacement, and timeout behavior.
2. Render the bootstrap as an ordinary revision-scoped Job and harden its POSIX reconciliation script without changing values.
3. Correct the first and second independent-review blockers: protected additive gate composition, fixed workflow component identity, one global admin-tools image authority plus legacy equality/migration validation, numeric vanilla identities, complete inherited-ID OpenShift stripping, deterministic image metadata, and uniform numeric terminal diagnostics.
4. Correct the third independent-review blockers: preserve supported vanilla identity overrides while stripping them on OpenShift, schema-validate both profiles, normalize absent/empty digests, retain a raw digest-bound OCI chain, make Job selection and image migration executable, and remove unrelated Keycloak initialization drift.
5. Correct the fourth independent-review blockers: validate effective templated gate names, reconstruct whiteout-aware OCI filesystems, exercise real reused pre-global values, execute namespaced exact-cardinality Job discovery, remove Knative pin drift, and separate offline predictions from actual release state.
6. Correct the fifth independent-review blockers through a real base-release `--reuse-values` sequence, per-run OCI cleanup and path-general whiteouts, complete selector failure diagnostics, and executable Knative pin comparisons.
7. Pass the expanded focused render/process/image-authority/OCI-identity/operator/scope tests, schema/lint/render validation, the unfiltered global black-box suite, strict OpenSpec validation, and a fresh independent review.
8. In an isolated disposable installation on a verified non-production context, prove clean install, upgrade, failure/retry, rollback, active revision metadata, immutable Job safety, state preservation, identity compatibility, readiness, and cleanup.
9. Publish and adopt through the normal release path. Verify the new revision Job, configured namespace and all five attributes before declaring the release healthy.

Rollback does not reverse Temporal state. If the retained namespace is compatible and verified, a chart rollback may proceed and workloads must be rechecked. If it is not verified, stop and fail forward with a corrected revision. Never delete the namespace, search attributes, or histories as rollback compensation.
