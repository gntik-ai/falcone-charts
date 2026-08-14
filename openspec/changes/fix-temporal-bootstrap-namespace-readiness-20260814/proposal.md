## Why

On a fresh `helm install --wait`, the workflow consumer waits for the configured Temporal namespace `falcone-flows`, but the only reconciler for that namespace is a `post-install` hook that Helm does not start until ordinary resources are Ready. This creates a deterministic readiness cycle: the consumer cannot become Ready before namespace bootstrap, and namespace bootstrap cannot run before the release is Ready.

The defect is grounded in `charts/in-falcone/templates/temporal/bootstrap-job.yaml::temporal-bootstrap Job:5-27`, which assigns `post-install,post-upgrade`, and `charts/in-falcone/values.yaml::temporal.bootstrap:4989-5005`, which supplies the namespace and search attributes consumed by workflow workloads.

## What Changes

- Move Temporal namespace and search-attribute reconciliation into a Helm lifecycle that participates safely in a fresh `--wait` install instead of being deferred behind `post-install` readiness.
- Preserve bounded frontend waiting, idempotent namespace/search-attribute convergence, and safe repeated upgrade behavior without immutable completed-Job collisions.
- Gate Temporal-dependent workflow consumers on verified namespace readiness through a chart-owned gate that inherited values, user init-container replacement, or a divergent `workflowWorker.wrapper.componentId` cannot remove, while keeping valid user init containers additive.
- Reject reserved-gate collisions using each user init-container's effective post-`tpl` name before rendering.
- Derive one DNS-safe Temporal frontend Service hostname for long release names and reuse it exactly in the bootstrap Job and mandatory workflow gate.
- Use the subchart-visible `global.temporalAdminToolsImage` as the single image authority for the Job and gate, preserving the exact current defaults, repository, tag, optional digest, global registry rewriting, pull policy and pull secrets. Keep `temporal.adminTools.image` as an equality-validated legacy input with explicit fail-closed migration for divergent or reused custom values.
- Render effective numeric `1000:1000` identities for every chart-owned Temporal container on vanilla Kubernetes and omit all fixed identities—including inherited `temporal.*SecurityContext` IDs—throughout the OpenShift restricted path so SCC-assigned arbitrary IDs work.
- Preserve supported positive numeric UID/GID/fsGroup overrides on vanilla Kubernetes, strip those same inherited fixed identities on OpenShift, and schema-validate both complete render paths.
- Make every terminal failure non-zero, namespace-specific, numerically bounded, secret-safe, observable, and recoverable through explicit correct-or-resolve plus retry-to-fail-forward guidance without destructive Temporal rollback.
- Verify deterministically from compact byte-exact OCI index/manifest/config evidence plus every ordered layer retrieved read-only by immutable digest into unique per-run disposable storage—including root, parent, nested, and opaque whiteout semantics—that the pinned Temporal server, admin-tools and UI final passwd/group state maps named users to the chart's numeric `1000:1000` contract without versioning or retaining massive layer blobs.
- Normalize absent and empty legacy/canonical image digests identically while preserving any accepted non-empty digest in the Job and mandatory gate.
- Provide public operator procedures that select exactly one revision-scoped Job across install, upgrade, and truncated release names, plus a chart-README-linked copyable migration to the global image authority.
- Prove real Helm stored-release `--reuse-values` compatibility from base `41922e9d`: schema admits pre-global defaults to compatibility validation, exact defaults converge, and unmigrated custom legacy images fail closed.
- Execute Job discovery end to end from namespaced Helm history through derived revision/lifecycle and exact zero/one/multiple cardinality handling, including complete selector-context and fail-forward diagnostics.
- Make rollback discovery follow the effective bootstrap metadata in the active revision's stored manifest instead of assuming a rollback's new active Helm revision is copied into the replayed Job labels.
- Prove the Temporal remediation leaves the unrelated Keycloak database initialization unchanged from authoritative base `41922e9d`.
- Prove through an executable positive/negative scope test that every unrelated Knative repository, tag, and digest remains byte-exact against authoritative base `41922e9d`.
- Separate offline render predictions from disposable release-state evidence across install, upgrade, fail-forward retry, and rollback.
- Add render and executable black-box regression coverage, disposable clean-install/upgrade acceptance, operator verification and recovery guidance, and compatibility/rollback checks.
- No public Falcone API, stored Temporal workflow data, default namespace name, search-attribute schema, or Secret contract changes.

## Capabilities

### New Capabilities

- `temporal-bootstrap-lifecycle`: Defines fresh-install, upgrade, readiness, idempotency, failure, security, compatibility, rollback, test, and operator contracts for Temporal namespace bootstrap.

### Modified Capabilities

None.

## Impact

- **Chart lifecycle:** `charts/in-falcone/templates/temporal/bootstrap-job.yaml`, custom Temporal Deployments, component-wrapper init-container composition, and the Temporal-dependent workflow readiness path.
- **Configuration:** existing `temporal.bootstrap`, `temporal.jobs`, security-context, image-pull, component-identity, and user init-container configuration remain supported; `global.temporalAdminToolsImage` becomes canonical while `temporal.adminTools.image` remains compatibility-only and equality-validated. The mandatory gate and component identity are no longer replaceable and no new credential or Secret value is introduced.
- **Runtime:** Temporal server and Web UI workloads, the configured application namespace, custom search attributes, workflow-worker and other Temporal clients.
- **Operations:** clean install and upgrade with Helm `--wait`, namespaced history plus deployed-stored-manifest Job discovery, operable reused-values migration, copyable legacy-image migration, bounded diagnostics, fail-forward retry, explicit rollback preconditions, and disposable verification.
- **Verification:** Helm-render contracts, effective post-template collision checks, compact-metadata plus registry-read-only digest-bound final-filesystem image-user checks, vanilla/OpenShift identity matrices including supported overrides and schema conformance, process-isolated bootstrap behavior, real reused-values compatibility, init-container override/additivity checks, legacy/global digest normalization, executable zero/one/multiple selectors, Keycloak/Knative scope diff checks, offline versus live release-state separation, upgrade/idempotency checks, strict OpenSpec validation, chart linting, one global black-box regression, independent re-review, and disposable Kubernetes acceptance.
