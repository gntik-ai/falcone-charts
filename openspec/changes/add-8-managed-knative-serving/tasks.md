## 1. Baseline and coordination

- [x] T01 Record a green baseline from a clean archive of `main`: `helm lint charts/in-falcone`,
      default `helm template`, `kubeconform`, and `node --test tests/*.test.mjs` (run from the archive
      work directory, since a test resolves the chart from CWD).
- [x] T02 Confirm the coordinated Falcone consumer contract is frozen and referenced, not edited:
      `apps/control-plane/knative-runtime.mjs` (`falcone.knative-runtime/v1`, default status file
      `/var/run/falcone/knative/status.json`, default `KNATIVE_RUNTIME_MODE=disabled`) and the
      real-stack E2E `tests/e2e/specs/issues/issue-933-managed-knative-runtime.spec.ts`
      (`falcone.knative-lifecycle/v1` ConfigMap and the `falcone-knative` executable).
- [x] T03 Record the fixed decisions that SHALL NOT be re-opened in implementation: separate
      `falcone-knative` release + client-side executable, modes `managed|external|disabled`, the
      1.22.1/Kubernetes 1.34/OpenShift 4.21 `restricted-v2` matrix, and the Falcone-vs-Red Hat support
      boundary.

## 2. Managed bundle, provenance, and supply chain (`charts/falcone-knative`)

- [x] T04 Vendor a reviewed Knative Serving + Kourier 1.22.1 bundle (Serving CRDs, Serving core,
      Kourier) with the upstream release versions and source revisions and the original manifest
      SHA-256 checksums recorded in a provenance lock.
- [x] T05 Produce and record the patched-manifest SHA-256 checksums, a license inventory, and SBOMs
      for the bundle, and add a validator that fails when any provenance field is missing or does not
      resolve to one reproducible bundle.
- [x] T06 Replace every image reference with an immutable digest — including the upstream mutable
      Envoy tag `envoy:v1.37-latest` — build the complete image-lock inventory, and add a validator
      that rejects any tag-only image.
- [x] T07 Implement deterministic digest-preserving rewrite of every bundle image to a configured
      Harbor/private registry (no digest change, no introduced tag) and a disconnected render/install
      mode that resolves images only from the mirror and makes no public-registry request.

## 3. Modes, preflight, and ownership

- [x] T08 Implement the schema-validated `managed|external|disabled` mode contract for the separate
      release and the umbrella wiring values; default `disabled`; the managed bundle is never an
      umbrella dependency.
- [x] T09 Implement fail-closed, zero-mutation preflight: cluster-scoped authority, Kubernetes/
      OpenShift compatibility, admission reachability, existing namespaces/CRDs/stored versions/RBAC/
      webhooks, every exact staged namespaced/cluster-scoped bundle identity, and conjunctive
      owner/release/state ownership markers.
- [x] T10 Implement exclusive ownership acquisition for a clean install and rejection of OLM/OpenShift
      Serverless/other-raw/other-Falcone/unknown/partial ownership; require an explicit
      `external`/`disabled`/reviewed-`managed` decision for any existing installation — never adopt
      implicitly.
- [x] T11 Implement `external`-mode discovery and read/invoke validation against an
      administrator-supplied pre-existing canary `ksvc` only: create/delete no canary or validation
      resource; when the canary is absent/unreadable/uninvokable or the version is incompatible, keep
      readiness `unverified` and gates closed and mutate nothing. On explicit publication/refresh,
      write only a bounded four-minute lease to registered same-owner application namespaces and
      mutate no external Serving/Kourier/canary resource.

## 4. OpenShift security patch and staged install

- [x] T12 Patch Kourier for OpenShift `restricted-v2`: remove fixed `runAsUser`/`runAsGroup` `65534`
      (compute no substitute), retain non-root, `allowPrivilegeEscalation: false`, `RuntimeDefault`
      seccomp, and dropped capabilities; require no custom SCC or privileged service account.
- [x] T13 Implement the ordered staged install: CRDs + `Established`; namespaces/SA/cluster RBAC/
      config/Services; webhook Deployment without `AdmissionRegistration`; webhook Service endpoint +
      certificate; the three `AdmissionRegistration` configs with non-empty CA bundles + admission
      probe; remaining Serving controllers; Kourier controller/gateway; isolated create/invoke/delete
      smoke `ksvc`; then publish `ready`. Each stage bounded, diagnostic on failure, never false-ready.

## 5. Status contracts and cross-namespace projection

- [x] T14 Render the Helm-owned `falcone.knative-lifecycle/v1` ConfigMap in the fixed
      `knative-serving` status namespace (name default `falcone-knative-status`) with the Helm
      labels/annotations and the exact JSON schema (`schemaVersion`, `release`, `version`, `status`,
      `runId`, `clusterIdentity{apiUrl,infrastructureName,infrastructureId,clusterUid}`,
      `lifecycleExecutable{name:"falcone-knative",version,sha256}`); advance `status` to `compatible`
      only after the smoke stage, keeping the object Helm-managed.
- [x] T15 Implement the leased `falcone.knative-runtime/v1` projection writer (in the lifecycle
      executable and the managed-mode least-privilege status projector): derive `schemaVersion/mode/owner/version/
      compatibility/readiness{state,stage,reason,lastTransitionAt}`, an `observedAt` stamp, a bounded
      `validUntil` lease (+ `externalCanary.state` for external), write it as a ConfigMap into every
      registered, owner-verified Falcone namespace, refuse unregistered/foreign-owned namespaces,
      bootstrap an expired fail-closed placeholder before late registration, fence Namespace and
      ConfigMap read-modify-write operations with resourceVersion,
      refresh the lease on every transition and interval, and keep the document ≤16 KiB and
      secret-safe.
- [x] T16 Ship the status projector as a least-privilege workload with RBAC that has **no**
      create/update/patch/delete verb on any `serving.knative.dev`/CRD/`admissionregistration.k8s.io`/
      namespace/RBAC resource — only write access to the named runtime-status ConfigMap through an
      owner-derived service account and ordinary Role/RoleBinding in each registered namespace, with
      no cluster-wide ConfigMap write and exact namespace Roles for health reads — plus a bounded
      refresh interval, a liveness/heartbeat signal, and a metric so
      operators can alert on a missed refresh.
- [x] T17 Ensure every outage/restart/recovery transition (operator-driven and projector-detected)
      updates every registered projection within a bounded window and never leaves a stale `ready`
      projection; publish bounded `observedAt`/`validUntil` leases and never publish `ready` unless
      smoke/readiness is currently proven.

## 6. Lifecycle command: upgrade, rollback, uninstall, purge, handoff, acceptance

- [x] T18 Implement one-minor-at-a-time upgrade with a pre-mutation recovery record (resource
      inventory, stored CRD versions, image/config state), required storage-version migrations and
      post-upgrade steps gated on readiness, and rejection of skipped-minor or patch-downgrade
      upgrades.
- [x] T19 Implement compatibility-bounded rollback (only to a bundle compatible with the current
      stored CRD versions); after an irreversible storage migration, fail closed and direct to
      restore/forward repair from the recovery point.
- [x] T20 Implement retain-by-default uninstall (retain CRDs and tenant workload state; report
      retained resources) and a separate confirmation-gated destructive `purge` that enumerates
      impacted CRDs/workloads, validates an exact same-owner backup record, inventories every custom
      resource under installed managed CRDs, refuses foreign/unowned/non-bundle cascade risk, and
      establishes a fail-closed four-group admission write fence, re-inventories under that fence,
      deletes only exact verified identities with UID/resourceVersion preconditions, and removes the
      exact fence after deletion; implement the command but do not execute it.
- [x] T21 Implement owner-safe handoff to/from an Operator: back up, quiesce writes, stop and release
      the exact seven writers and prove zero replicas/Pods while retaining CRDs/workloads,
      resourceVersion-fence and record released state
      in ownership data and metadata, enable exactly one target owner with backup/prior-owner state,
      verify complete exclusive target readiness; on post-mutation failure remain quiesced and never restart the previous owner
      concurrently.
- [x] T22 Implement the `falcone-knative` executable subcommands (`preflight`, `install`, `upgrade`,
      `rollback`, `uninstall`, `purge`, `handoff`, `acceptance <outage|restart|recover|
      replacement-conflict>`), the verified-target flags, shell-free execution, self-recorded SHA-256,
      and secret-safe evidence (actor/action/mode/owner/bundle/stage/result/correlationId).

## 7. Umbrella chart wiring (`charts/in-falcone`)

- [x] T23 Add the schema-validated runtime-mode value and wire `KNATIVE_RUNTIME_MODE` +
      `KNATIVE_RUNTIME_STATUS_FILE` onto `controlPlane`/`controlPlaneExecutor` for `managed`/`external`
      via the `component-wrapper` values, preserving the default `disabled` byte-compatible render.
- [x] T24 Mount the projected runtime-status ConfigMap as an optional source directory (no `subPath`)
      plus an application-visible `emptyDir` at `/var/run/falcone/knative/` on `controlPlane`/
      `controlPlaneExecutor`; add a tokenless guard that validates the source lease and atomically
      materializes `status.json`, replacing missing/invalid/expired input with `unavailable`; template
      no projector-owned `falcone.knative-runtime/v1` object in the umbrella.
- [x] T25 Register the pre-created application namespace for owner-checked projection (registration
      label + owner marker) with ephemeral owner-checking hooks and fail-closed placeholder bootstrap;
      retain only namespace-local projector
      RBAC; revoke on uninstall or explicit `disabled + unregister=true`; keep normal disabled
      hook-free. Update `deploy/openshift/values-openshift.yaml` and `deploy/kind/values-kind.yaml`
      example overlays to document the three modes without changing defaults.

## 8. Tests (`tests/*.test.mjs`, `tests/*.test.sh`)

- [x] T26 Render/policy tests (Kubernetes and OpenShift): digest-only images (incl. Envoy),
      disconnected Harbor rewrite preserving digests, `restricted-v2` Kourier patch + retained
      security controls + no custom SCC, and the byte-compatible default/disabled umbrella render.
- [x] T27 Preflight/ownership collision tests: OLM/Serverless/other-raw/other-Falcone/unknown/partial
      ownership rejection with zero mutation; namespace-only authority denial; existing-install
      explicit-decision gate.
- [x] T28 Staged-ordering tests: CRD `Established` gate, webhook-before-`AdmissionRegistration`,
      CA/admission probe gate, smoke-`ksvc` gate, and failed-stage-is-not-success.
- [x] T29 Status-contract tests: Helm-owned `falcone.knative-lifecycle/v1` labels/annotations + exact
      schema and `compatible`-only-after-smoke; `falcone.knative-runtime/v1` projection schema/bounds/
      secret-safety; source mount + tokenless guard + application `emptyDir` on both workloads;
      missing/invalid/expired-projection fail-closed; projector least-privilege RBAC (no
      serving/CRD/webhook write verbs).
- [x] T30 Projection/isolation + transition tests: transition updates every registered projection with
      no stale `ready`; unregistered/foreign namespace refused; adjacent-tenant non-disclosure.
- [x] T31 Upgrade/rollback/uninstall/purge/handoff tests: skip-minor rejection, irreversible-migration
      downgrade block, retain-by-default uninstall, purge separate-confirmation + impact enumeration,
      backup/foreign-resource purge refusal before mutation, live-marker enforcement for every
      mutating command, exact-inventory purge, patch-downgrade rejection, resourceVersion/UID races,
      fail-closed admission fencing plus under-fence re-inventory, exact fence cleanup, single-owner
      handoff and quiesced post-mutation failure.
- [x] T32 Wire the new tests into `.github/workflows/chart-release.yml` alongside the existing lint/
      kubeconform/`helm template`/node-test gates.

## 9. Documentation (14-part standard) and acceptance

- [x] T33 Author install (clean `managed`, existing `external`, `disabled`), cluster-admin
      prerequisites, Harbor mirroring, `restricted-v2`, support boundary, and version-compatibility
      documentation; keep managed labelled proposed/unavailable until acceptance.
- [x] T34 Author runbooks: preflight, staged install/readiness, upgrade, rollback/forward-repair,
      handoff, uninstall + separately-confirmed purge, outage/recovery, secret-safe evidence
      collection, and troubleshooting.
- [ ] T35 Run disposable clean-cluster acceptance on supported Kubernetes and a remote OpenShift 4.21
      cluster-admin target (no OLM/Serverless Operator), prove all workloads under `restricted-v2`,
      Harbor-only image resolution, the coordinated Falcone #933 real-stack E2E, and remove every
      disposable resource; record secret-safe evidence.
- [ ] T36 Coordinate chart/app versions so the mount contract matches the consuming image; lease
      freshness is enforced by the chart-side tokenless guard (T24), so no Falcone consumer edit is
      required for correctness (an additive Falcone-side freshness check remains optional
      defense-in-depth, not a release prerequisite). Land after independent `system-reviewer` approval
      and only then document `managed` as supported. Do not archive/sync this change until both
      repositories pass acceptance and cleanup is proven.
