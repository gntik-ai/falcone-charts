## Why

`charts/in-falcone` installs Falcone but treats Knative Serving + Kourier as an externally
satisfied production prerequisite (the OpenShift values name the OpenShift Serverless
Operator/`KnativeServing` CR; the Kubernetes values assume a pre-installed serving layer).
Falcone Functions and hosted MCP both depend on Knative Service behaviour (revisioned rollout,
scale-to-zero, internal routing, readiness, rollback, owner-scoped teardown).

The coordinated Falcone design `add-managed-knative-serving`
([gntik-ai/falcone#933](https://github.com/gntik-ai/falcone/issues/933)) adds three explicit runtime
modes — `managed`, `external`, `disabled` — and a first-class runtime-availability contract, but it
deliberately assigns the cluster-scoped serving bundle, its supply chain, its OpenShift safety, and
its lifecycle orchestration to this repository. This change is that chart-repository half
([gntik-ai/falcone-charts#8](https://github.com/gntik-ai/falcone-charts/issues/8)). It is
design-only: it does not install Knative, mutate any cluster, or claim managed support before live
disposable-cluster acceptance passes.

## What Changes

- Add a **separate `falcone-knative` Helm release + versioned client-side lifecycle executable**
  (`falcone-knative`) for `managed` mode. The managed serving bundle SHALL NEVER become an
  unconditional dependency of `charts/in-falcone`, and no long-lived Falcone/OLM Knative reconciler
  is installed.
- Vendor a reviewed **Knative Serving/Kourier 1.22.1** bundle with upstream revisions,
  original+patched manifest checksums, a license inventory, SBOMs, and a complete **digest-only image
  lock** (including the currently mutable Envoy reference), plus **digest-preserving Harbor/private
  registry rewrite** and disconnected (no public-registry) rendering.
- Fix the supported matrix to **Knative 1.22.1 / Kubernetes 1.34 / OpenShift 4.21 `restricted-v2`**;
  every other combination fails closed until independent acceptance extends it. Falcone supports its
  patched upstream bundle on this matrix; it is not the Red Hat OpenShift Serverless product path.
- Implement **fail-closed, zero-mutation preflight** (cluster-scoped authority, version, admission
  reachability, CRD/storage state, existing namespaces/resources, and exclusive
  Operator/raw/other-Falcone/unknown ownership). A clean install acquires one exclusive Falcone
  owner; an existing installation requires an explicit `external`/`disabled`/reviewed `managed`
  decision. **No installation is ever adopted implicitly.**
- Patch **Kourier for OpenShift `restricted-v2`** by removing the fixed `runAsUser`/`runAsGroup`
  `65534` (computing no substitute UID) while retaining non-root, no privilege escalation,
  `RuntimeDefault` seccomp, and dropped capabilities; no custom SCC.
- Implement the **explicit staged install** (CRDs+`Established`; namespaces/RBAC/config/Services;
  webhook backend without `AdmissionRegistration`; endpoint+certificate; the three admission
  configurations with non-empty CA bundles + admission probe; remaining Serving; Kourier; then an
  isolated create/invoke/delete **smoke `ksvc`**) before any readiness is published.
- Publish a **Helm-owned `falcone.knative-lifecycle/v1`** status ConfigMap in the status namespace
  (release/chart version, coordinated `status`, run ID, cluster identity, and the executable
  SHA-256), and **owner-safely propagate a leased `falcone.knative-runtime/v1` projection** into
  every explicitly registered Falcone application namespace. A chart-supplied, tokenless guard
  validates the lease and atomically materializes the application-visible status file for the
  control-plane and executor; an expired or invalid lease becomes `unavailable`, so the unchanged
  #933 reader cannot consume stale `ready` state.
- Wire the umbrella chart's **three-mode values**, the projected runtime-status **mount** into
  `controlPlane`/`controlPlaneExecutor`, and **namespace registration**, keeping the default
  `disabled` and current `external` behaviour **byte-compatible**.
- Implement **one-minor upgrade**, required **storage migration**, **compatibility-bounded
  rollback**, **retain-by-default uninstall**, a **separately-confirmed destructive purge**, and an
  **owner-safe (single-owner) handoff**; plus the CLI **`acceptance outage|restart|recover|
  replacement-conflict`** hooks the coordinated Falcone real-stack E2E consumes.
- Add **black-box render/policy, disconnected-Harbor, `restricted-v2`, ownership-collision,
  staged-ordering, upgrade, rollback, uninstall, projection/isolation** tests, plus clean-install,
  upgrade/rollback, docs and cleanup acceptance, and **coordinated chart/app versioning**.

## Capabilities

### New Capabilities

- `managed-knative-lifecycle`: the separate managed-Knative release, its lifecycle executable, bundle
  provenance/supply chain, preflight/ownership, security patch, staged install, status contracts,
  leased runtime-status projection, and the upgrade/rollback/uninstall/purge/handoff boundaries.

### Modified Capabilities

- `deployment-packaging`: add the `charts/in-falcone` three-mode contract, the owner-safe
  runtime-status mount into control-plane/executor, namespace registration, coordinated versioning,
  the Falcone freshness-contract release gate, and default-disabled/current-external compatibility.
  (Authored as ADDED requirements: the chart repository ships no archived spec baseline for this
  capability yet.)

## Scope and Non-goals

In scope: Knative Serving + Kourier, their cluster-scoped prerequisites, the OpenShift safety patch,
disconnected/Harbor installation, the lifecycle executable, ownership/provenance, the two status
contracts and their owner-safe cross-namespace projection, and lifecycle acceptance assets. Out of
scope: Knative Eventing, OLM packaging, the OpenShift Serverless Operator, simultaneous multi-owner
reconciliation, silent adoption of an existing installation, and any change to Falcone Function/MCP
business semantics beyond the dependency-unavailable behaviour (owned by Falcone #933). Editing the
already-approved Falcone application branch is out of scope unless an independently reviewed contract
blocker proves an application defect.

## Exit Criteria

- `openspec validate add-8-managed-knative-serving --strict` passes; `helm lint`, `helm template`,
  `kubeconform`, and the chart `node --test` suite pass; the default umbrella render is unchanged.
- A disposable clean-cluster acceptance run proves `managed` mode on supported Kubernetes and a
  remote OpenShift 4.21 cluster-admin target, including Harbor-only image rewrites and
  `restricted-v2`, and the coordinated Falcone #933 real-stack E2E passes against the published
  lifecycle status ConfigMap and lifecycle executable.
- Existing-install `external` mode, `disabled` mode, ownership-collision rejection, staged-failure
  paths, projection/isolation probes, upgrade, compatibility-bounded rollback, retain-by-default
  uninstall, separately-confirmed purge, and single-owner handoff are independently verified.
- Documentation states the support boundary and never reports `managed` mode as available before the
  implementation and acceptance evidence exist.

## Risks and Rollback

Cluster-scoped CRDs, cluster RBAC, admission webhooks, and shared namespaces have a high blast
radius; ownership ambiguity could let two reconcilers corrupt one installation. Upstream image or
manifest drift can break disconnected and security guarantees, and CRD storage migrations can make
binary rollback unsafe. This change therefore fails closed before any mutation, records provenance
and recovery points, supports exactly one active owner, retains CRDs and tenant workloads by default
on uninstall, and limits rollback to the last bundle compatible with the current stored CRD versions.
If implementation acceptance fails, the design artifacts remain but managed mode stays unavailable and
current `external`/`disabled` behaviour remains authoritative.

## Impact

- Chart evidence: `charts/in-falcone/Chart.yaml`, `charts/in-falcone/values.yaml`,
  `charts/in-falcone/values.schema.json`, `charts/in-falcone/templates/control-plane-rbac.yaml`,
  `charts/in-falcone/templates/namespace.yaml`, `charts/in-falcone/templates/mcp/rbac.yaml`,
  `deploy/openshift/values-openshift.yaml`, `deploy/kind/values-kind.yaml`,
  `.github/workflows/chart-release.yml`, `tests/*.test.mjs`.
- New chart assets: `charts/falcone-knative/**` (separate release), the vendored bundle +
  provenance/SBOM/license/image-lock, the `falcone-knative` lifecycle executable, and its acceptance
  assets.
- Coordinated consumer: `gntik-ai/falcone#933`
  (`apps/control-plane/knative-runtime.mjs` reads `/var/run/falcone/knative/status.json` as
  `falcone.knative-runtime/v1`; the real-stack E2E reads the Helm-owned
  `falcone.knative-lifecycle/v1` ConfigMap and the `falcone-knative` executable). The chart-side
  guard supplies freshness enforcement at the mounted-file boundary, so no additional consumer edit
  is required.
- External systems: Kubernetes/OpenShift admission, CRDs, cluster RBAC, namespaces, Harbor-compatible
  private registries, and the Knative Serving/Kourier data plane.
