## Context

`charts/in-falcone` (chart `0.4.1`, app `0.3.1`) installs Falcone and treats Knative Serving +
Kourier as an external production prerequisite. The coordinated Falcone design
`add-managed-knative-serving` (issue #933) adds three runtime modes and a first-class availability
contract but assigns the cluster-scoped serving bundle, its supply chain, OpenShift safety, and
lifecycle orchestration to this repository (issue #8). The consuming application is **frozen** for
this change: `apps/control-plane/knative-runtime.mjs` reads `/var/run/falcone/knative/status.json` as
`falcone.knative-runtime/v1`, defaults `KNATIVE_RUNTIME_MODE=disabled`, and fails closed on a
missing/invalid/mode-mismatched/stale-version status. The real-stack E2E
`issue-933-managed-knative-runtime.spec.ts` reads the Helm-owned `falcone.knative-lifecycle/v1`
ConfigMap and executes the chart-owned `falcone-knative` executable.

This is a design contract only. It installs nothing, mutates no cluster, and does not claim managed
support. Live clean-install/upgrade/rollback acceptance is **blocked** on a disposable, cluster-admin
remote OpenShift 4.21 / Kubernetes 1.34 target that is not yet provisioned; the current shared k3s
1.36.1 environment (already carrying a raw Knative/Kourier install and a live Falcone release) is out
of matrix, pre-owned, and non-disposable, so it is valid only for read-only discovery.

### Personas and authority boundary

- **P18 installer/release engineer** selects a mode, supplies mirror/provenance, and runs the
  `falcone-knative` lifecycle under cluster-admin authority.
- **P3 operator/SRE** observes stage/reason/recovery and performs supported lifecycle operations.
- **P4 security/compliance** audits provenance/SBOM/licenses, the `restricted-v2` patch, ownership
  boundaries, and secret-safe evidence.
- **P8 function developer, P7 MCP owner, P12 MCP consumer** retain runtime behaviour through the
  coordinated Falcone #933 contract and receive bounded unavailability only after authorization.
- **P10 read-only auditor/viewer** reads secret-safe mode/owner/version/readiness without a mutation
  path.
- **P13 adjacent tenant** cannot infer another tenant's Knative workload or dependency state.
- **P17 documentation-only installer** needs exact prerequisites, the Falcone-vs-Red Hat support
  boundary, expected outputs, recovery, cleanup, and compatibility — with managed labelled proposed
  until acceptance.
- A **cluster administrator** grants the cluster-scoped authority `managed` needs; this is a
  deployment boundary, not a tenant role.

## Goals / Non-Goals

**Goals:** a reproducible operator-free Knative Serving + Kourier bundle; explicit
`managed`/`external`/`disabled` ownership; OpenShift `restricted-v2` without a custom SCC;
disconnected Harbor installation with immutable digests; a first-class runtime-availability contract
projected owner-safely into the application namespace; clean-install/upgrade/rollback/uninstall/purge/
handoff behaviour; and default-disabled/current-external byte compatibility.

**Non-Goals:** OLM packaging, the OpenShift Serverless Operator, Knative Eventing, a Knative-free
backend, simultaneous multi-owner reconciliation, silent adoption, and any change to Falcone
Function/MCP business semantics beyond the frozen dependency-unavailable behaviour.

## Decisions

### D1: A separate `falcone-knative` release + client-side executable — never an umbrella dependency

The managed serving bundle is cluster-scoped shared infrastructure (CRDs, cluster RBAC, admission
webhooks, system namespaces, controllers, an ingress data plane). It cannot install with ordinary
namespace-editor credentials and cannot safely coexist with another reconciler. It is therefore a
**separate `charts/falcone-knative` release** operated by a versioned client-side executable
(basename `falcone-knative`), not a dependency of `charts/in-falcone` and not a long-lived in-cluster
Operator/controller. The executable owns staged CRD lifecycle (Helm's `crds/` does not upgrade, roll
back, or delete CRDs); the Helm release owns the rendered non-CRD bundle and the Helm-owned lifecycle
status ConfigMap. *Alternative rejected:* a component-wrapper alias inside `in-falcone` — it would
make managed Knative an unconditional umbrella dependency, incur the four-copy alias tax, and violate
the ownership boundary.

### D2: Two distinct status contracts with distinct owners

- **`falcone.knative-lifecycle/v1`** — **Helm-owned** ConfigMap in the fixed, non-relocatable
  `knative-serving` status namespace (name default `falcone-knative-status`). Fields:
  `schemaVersion`, `release`, `version`, `status` (`compatible` only after smoke), `runId`,
  `clusterIdentity{apiUrl,infrastructureName,infrastructureId,clusterUid}`,
  `lifecycleExecutable{name:"falcone-knative",version,sha256}`. It carries the Helm labels/annotations
  the E2E asserts (`app.kubernetes.io/managed-by=Helm`, `.../instance=<release>`,
  `.../version=<chartVersion>`, `meta.helm.sh/release-name`, `meta.helm.sh/release-namespace`).
  Dynamic values (run ID, cluster identity, executable SHA-256, and the final `compatible` status)
  are supplied to the Helm release by the executable so the object stays Helm-managed throughout.
- **`falcone.knative-runtime/v1`** — the application status the frozen consumer reads at
  `/var/run/falcone/knative/status.json`. Fields (validated by `knative-runtime.mjs`): `schemaVersion`,
  `mode`, `owner` (SAFE_NAME), `version` (must equal `1.22.1` or the consumer marks it incompatible),
  `compatibility` (`compatible|incompatible|unverified`),
  `readiness{state,stage,reason,lastTransitionAt}` where `state ∈ {ready,unverified,degraded,
  unavailable,disabled}`, `stage ∈ {configured,preflight,crds,webhook,serving,kourier,smoke,ready,
  disabled,external_validation,unknown}`, `reason` matches `^[A-Z][A-Z0-9_]{0,63}$`, and in `external`
  mode `externalCanary.state ∈ {verified,missing,unreadable,invoke_failed}`. It additionally carries a
  **lease** (`observedAt` + a bounded `validUntil`); these are additive fields the current consumer
  ignores (it validates timestamp syntax but not age), so publishing them is backward-compatible and
  is consumed through the chart-side freshness guard described in D3. This object is **written by
  the lifecycle executable and the projector, not by the umbrella Helm release**.

### D3: Resolve the cross-namespace stale-status problem with an owner-safe projector + fail-closed mount

Kubernetes cannot mount a ConfigMap across namespaces, and the frozen consumer trusts the mounted
file (it does not independently probe Knative and does not currently enforce a max-age). Two
sub-problems: **propagation** (lifecycle status lives in `knative-serving`; the app reads it in its
own namespace) and **staleness** (a `ready` file must flip to non-ready when the runtime breaks).

Chosen mechanism:

1. **Projection.** The lifecycle executable and, for managed mode, a companion **least-privilege status projector**
   derive the `falcone.knative-runtime/v1` document and write it as a ConfigMap into every Falcone
   application namespace that carries the runtime-projection **registration label + owner marker**.
   External mode uses an explicit periodic lifecycle refresh that re-reads/re-invokes the supplied
   canary and writes a four-minute lease; it installs no managed projector into the external
   serving layer. Unregistered or foreign-owned namespaces are refused (no silent adoption). The projector mutates
   **nothing** in the serving layer: its RBAC has zero create/update/patch/delete verbs on
   `serving.knative.dev`/CRDs/`admissionregistration.k8s.io`/namespaces/RBAC — its only write is the
   named status ConfigMap in registered namespaces. This is a read-only health→status bridge, not a
   Knative reconciler, so it does not violate the "no long-lived Operator/controller for the managed
   lifecycle" constraint.
   Registration uses an ephemeral namespace hook: it refuses a foreign/unowned existing status
   object or creates one already-expired `unavailable` placeholder, then applies registration with a
   Namespace resourceVersion test. Revocation is similarly fenced. Projector health reads are
   exact-name ordinary Roles in `knative-serving`/`kourier-system`; only Namespace discovery remains
   cluster-wide. Projection rechecks Namespace owner/registration/resourceVersion immediately before
   its ConfigMap PUT, which retains the observed ConfigMap resourceVersion.
2. **Fail-closed materialization.** `charts/in-falcone` mounts the projected ConfigMap read-only as an
   optional **source directory** (never via `subPath`) and mounts a separate `emptyDir` at
   `/var/run/falcone/knative/` on `controlPlane`/`controlPlaneExecutor`. A chart-supplied guard has no
   service-account token and no Kubernetes API authority. It validates the bounded source document,
   checks `validUntil` against its wall clock, and atomically replaces the application-visible
   `status.json` in the `emptyDir`. Missing, malformed, oversized, or expired source produces a valid
   `falcone.knative-runtime/v1` `unavailable` document. The application never reads the raw projection,
   and the umbrella templates no projector-owned runtime ConfigMap.
3. **Transition freshness.** Operator-driven transitions (install stages, upgrade, rollback,
   uninstall, handoff, and the E2E `acceptance outage|restart|recover` hooks) rewrite every registered
   projection synchronously. The projector re-derives readiness on a bounded interval so an
   *unattended* degradation flips projections to `degraded`/`unavailable` within one interval + the
   kubelet ConfigMap sync period. If the projector itself stops, `validUntil` expires and each local
   guard atomically materializes `unavailable` within its bounded check interval.

The projection is a **lease**: every `ready` document carries `observedAt` and a bounded `validUntil`
that the managed projector or explicit external CLI invocation refreshes. The guard, rather than the frozen Falcone consumer, enforces the
deadline. This closes the projector double-fault (projector down **and** runtime silently broken)
inside this repository and keeps the #933 schema and reader unchanged.

*Alternatives.* **(a) CLI-only projection (no projector):** simplest, but an unattended runtime
failure between operator commands leaves a stale `ready` projection indefinitely — rejected. **(b)
Directly mounting the projection:** kubelet propagates updates, but a projector outage can leave a
valid-looking `ready` file indefinitely because the consumer does not check age — rejected. **(c)
Editing the Falcone consumer:** unnecessary once the chart-side guard enforces the lease, and outside
this one-repository change.

Operationally the projector runs as a Deployment with a liveness/heartbeat probe and a missed-refresh
metric so operators can alert before any lease expires; the frozen consumer also already fails closed
on a missing/invalid file.

### D4: Lock provenance and every image; digest-preserving Harbor rewrite

The bundle records upstream versions + source revisions, original + patched manifest checksums, a
license inventory, SBOMs, and a complete image digest list. Validation rejects any tag-only image,
including upstream's mutable `docker.io/envoyproxy/envoy:v1.37-latest`. Rewrite to Harbor is
deterministic and **digest-preserving**; disconnected render/install resolves only from the mirror and
makes no public-registry request. The bundle is Falcone-supported on the fixed matrix and is
explicitly not the Red Hat OpenShift Serverless product path.

### D5: Patch Kourier for OpenShift's arbitrary-UID model, no custom SCC

The OpenShift rendering removes Kourier's fixed `runAsUser: 65534`/`runAsGroup: 65534` (computing no
substitute) and retains `runAsNonRoot: true`, `allowPrivilegeEscalation: false`,
`seccompProfile.type: RuntimeDefault`, and `capabilities.drop: [ALL]`. No custom SCC, privileged
service account, or UID-range exemption is introduced.

### D6: Staged, readiness-gated install with a smoke gate; fixed matrix; fail-closed preflight

Preflight (zero-mutation) checks authority, version/matrix, admission reachability, existing
namespaces/CRDs/stored-versions/RBAC/webhooks, the full resource inventory, and ownership, then the
executable applies CRDs (+`Established`), namespaces/RBAC/config/Services, the webhook backend without
`AdmissionRegistration`, the endpoint+certificate, the three admission configs (non-empty CA +
admission probe), remaining Serving, Kourier, an isolated smoke `ksvc`, and only then publishes
`ready`. Only the 1.22.1 / Kubernetes 1.34 / OpenShift 4.21 `restricted-v2` combination is accepted;
all others fail closed.

### D7: Upgrade one minor at a time; retain by default; single-owner handoff

Forward-only, one-minor upgrades with a pre-mutation recovery record and gated storage migrations;
compatibility-bounded rollback (fail closed after an irreversible migration → restore/forward repair);
retain-by-default uninstall; an exact-name, UID/resourceVersion-bounded, separately-confirmed
destructive purge that establishes a temporary fail-closed admission fence and re-inventories under
that fence before deletion (implemented, not executed by this change); and a quiesced, exactly-one-owner
handoff that proves all seven writers and Pods stopped before a resourceVersion-fenced release and
whose post-mutation failure stays quiesced.

## Data and control flow

```text
P18 selects mode (umbrella values: managed|external|disabled; default disabled)
   |
   +-- disabled --> app KNATIVE_RUNTIME_MODE=disabled; no mount; honest disabled status
   |
   +-- external --> app mounts projection (optional); executable validates admin canary read/invoke
   |                 only, then explicit periodic CLI refresh writes external_validation status
   |
   +-- managed  --> falcone-knative preflight (zero mutation)
                        |-- fail --> nothing mutated + actionable, secret-safe result
                        |-- pass --> CRDs -> RBAC/config/Services -> webhook backend
                                     -> AdmissionRegistration+CA+probe -> Serving -> Kourier
                                     -> smoke ksvc
                                        |-- ok  --> Helm status=compatible; projector writes ready
                                        |            into every registered namespace; app gates open
                                        |-- fail --> non-ready projection naming the stage; gates shut
```

Two ConfigMaps: Helm-owned `falcone.knative-lifecycle/v1` in `knative-serving` (E2E evidence);
projector-owned `falcone.knative-runtime/v1` in each registered app namespace (mounted by the app).
Both are non-secret and bounded.

## Migration and rollout

1. Land this design after independent `system-reviewer` approval; keep current prerequisite docs
   authoritative; leave the change active.
2. Implement the chart-side bundle, provenance, security patch, preflight, staged phases, status
   contracts, projector, umbrella wiring, and tests behind an unavailable-by-default gate.
3. Prove fresh managed install, Function/MCP journeys, isolation, outage/recovery, air-gap, upgrade,
   the rollback boundary, retain uninstall, and ownership collisions on disposable Kubernetes and
   remote OpenShift 4.21 cluster-admin environments; run the coordinated Falcone #933 real-stack E2E.
4. Coordinate chart/app versions and only then document `managed` as supported. Existing installations
   convert no mode by default; operators select `external`, `disabled`, or a reviewed `managed`
   migration.

## Risks / Trade-offs

- **Cluster blast radius** — CRDs/webhooks/shared controllers: mitigated by a separate privileged
  phase, fail-closed authority/ownership checks, and staged readiness.
- **CRD irreversibility** — storage migrations can block downgrade: mitigated by one-minor upgrades,
  recovery records, compatibility gates, retain-by-default uninstall, and forward repair.
- **Supply-chain drift** — mutable/public images break air-gap: mitigated by provenance locking,
  digest-only validation, SBOM/licenses, and mirror-only acceptance.
- **Stale runtime status** — mitigated by a leased projection (`observedAt`/`validUntil`) + the
  owner-safe managed projector or repeated external canary refresh + non-subPath optional mount +
  chart-side tokenless freshness guard. The guard enforces the lease without a Falcone application
  edit, so a stopped writer becomes unavailable rather than leaving stale `ready`.
- **Remote acceptance gap** — the current shared cluster is out of matrix and pre-owned; this design
  records the limitation and does not treat discovery as install proof.

## Validation references

- Chart repo: `charts/in-falcone/**`, `.github/workflows/chart-release.yml`, `tests/*.test.mjs`, and
  the prior `add-6-openshift-airgap-build-inputs` provenance/airgap precedent.
- Coordinated consumer: `gntik-ai/falcone` `apps/control-plane/knative-runtime.mjs`,
  `tests/contracts/knative-runtime-deployment.contract.test.mjs`,
  `tests/unit/knative-runtime-image-wiring.test.mjs`,
  `tests/e2e/specs/issues/issue-933-managed-knative-runtime.spec.ts`.
