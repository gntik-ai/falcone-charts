# Proposed managed Knative lifecycle runbook

> **Operational stop:** managed Knative is proposed and unavailable. The procedures below define
> the expected lifecycle and evidence boundary for disposable acceptance and a future supported
> release. They have not been executed on the required remote OpenShift 4.21 environment. Do not run
> them against production, staging, a shared cluster, the current read-only evidence cluster, or any
> cluster with existing/unknown Knative ownership.

This runbook is for P18 platform installers/release engineers and P3 platform operators, with P4 and
P10 read-only evidence collection. It explains what P8 Function developers, P7 hosted-MCP owners,
P12 service workloads, and P13 adjacent tenants should observe during lifecycle transitions. Read
the [support and installation guide](managed-knative-support.md) first for the mode decision, fixed
matrix, authority, disconnected supply chain, and live blockers.

Last static verification: 2026-08-07. Evidence level: E1/E2 only. Live acceptance: blocked.

Every `<angle-bracketed>` token in a command is a required placeholder. Replace it with the verified,
approved non-secret value before execution; do not paste the brackets into a shell.

## Non-negotiable safety rules

1. Positively verify the Kubernetes context, API URL, cluster UID, OpenShift infrastructure name and
   ID, namespace, release, owner, chart version, executable SHA-256, and run ID before any lifecycle
   mutation.
2. Stop if the target is not disposable during acceptance or is not an explicitly supported target
   after general availability. A familiar context name is not target proof.
3. Preflight is read-only. Any preflight that creates, labels, annotates, patches, applies, or deletes
   an object is a failed safety gate.
4. Stop on OLM/OpenShift Serverless, raw-manifest, other-Falcone, unknown, partial, or ambiguous
   ownership. Never adopt implicitly.
5. Keep exactly one reconciler/owner. Do not start Falcone lifecycle while an Operator owns the
   installation and do not start an Operator before Falcone has quiesced and released ownership.
6. Never place tokens, kubeconfigs, credentials, pull-secret values, tenant/workspace names, or
   unbounded resource bodies in values, arguments, terminal transcripts, issue comments, CI
   artifacts, or support bundles.
7. Do not bypass matrix, stored-version, admission, smoke, backup, confirmation, or ownership gates.
8. Use the fixed `knative-serving` lifecycle namespace. Any other `--status-namespace` is an
   unsupported bundle relocation and is rejected before cluster mutation.
9. Uninstall retains CRDs and tenant workload state. Purge is separate and destructive; issue-8
   implementation and this documentation task do not authorize executing it.

## Prepare a secret-safe operation record

Use placeholders in durable records. Keep sensitive process environment, kubeconfig, and registry
credentials outside the record.

```text
actor=<approved platform operator identity; no token>
action=<preflight|install|upgrade|rollback|uninstall|handoff|acceptance>
mode=<managed|external|disabled>
owner=<safe owner name>
release=falcone-knative
targetBundle=<version and provenance-lock digest>
runId=<unique non-secret run ID>
clusterIdentity.apiUrl=<approved API URL>
clusterIdentity.clusterUid=<approved cluster UID>
clusterIdentity.infrastructureName=<approved OpenShift infrastructure name>
clusterIdentity.infrastructureId=<approved OpenShift infrastructure ID>
backupReference=<non-secret tested recovery reference>
changeWindow=<approved window/reference>
```

Do not reuse an owner or run ID across unrelated clusters. Capture executable identity before the
operation:

```bash
bin/falcone-knative --version
sha256sum bin/falcone-knative
```

Match the version/SHA-256 to the packaged provenance lock. After a successful future install, match
it again to the Helm-owned lifecycle status.

## Read-only preflight procedure

### Managed clean-cluster preflight

```bash
bin/falcone-knative preflight \
  --mode managed \
  --owner <exclusive-safe-owner-name> \
  --bundle-version 1.22.1 \
  --output json
```

Expected success evidence includes actor, action, mode, owner, target bundle, `preflight` stage,
result, correlation ID, detected Knative/Kourier 1.22.1, Kubernetes 1.34, OpenShift 4.21, and
`restricted-v2`. Success means only that a reviewed install may start; it is not readiness.

Expected failure classes include:

| Failure | Required behavior | Operator action |
|---|---|---|
| Namespace-only or missing cluster verb | Name the missing permission; zero mutation. | Obtain separately approved authority or select `external`/`disabled`. Do not broaden a service account silently. |
| Unsupported Kubernetes/OpenShift/Knative/Kourier | Report detected and only supported versions; zero mutation. | Use a supported disposable target or stop. Do not override the matrix. |
| OLM/OpenShift Serverless owner | Reject adoption; zero mutation. | Select `external`, or plan a separately reviewed quiesced handoff. |
| Raw/other-Falcone/unknown/partial owner | Reject adoption; zero mutation. | Inventory and establish ownership. Use `external`/`disabled` until a reviewed migration exists. |
| Admission unreachable | Name the boundary; zero mutation. | Repair cluster admission/networking, then repeat preflight. |
| CRD stored versions incompatible or unknown | Report the versions; zero mutation. | Restore/migrate under an approved plan; do not install over them. |

Preserve bounded JSON output and the exit code. Do not capture `kubectl config view --raw`, Secret
objects, registry auth, or full resource dumps.

### External-runtime validation

The external administrator creates and owns the canary. Falcone only reads and invokes it:

```bash
bin/falcone-knative preflight \
  --mode external \
  --owner <external-lifecycle-owner> \
  --external-canary <namespace>/<existing-canary-ksvc> \
  --output json
```

The operation must contain no canary create/apply/patch/delete. A missing, unreadable, incompatible,
or failed invocation produces `unverified`; it must never fabricate `ready`. Repair the external
runtime/canary under its owner's runbook, then repeat read-only validation.

Publish or refresh the bounded application status only after that decision:

```bash
bin/falcone-knative install \
  --mode external \
  --owner <external-lifecycle-owner> \
  --external-canary <namespace>/<existing-canary-ksvc> \
  --output json
```

This command repeats the exact canary read/invoke and writes only same-owner runtime-status
ConfigMaps; it does not mutate the external Serving/Kourier installation. Schedule the explicit
refresh at no more than two-minute intervals so it remains comfortably inside its four-minute
lease. A missed or failed refresh is safe: the tokenless application guard rejects the expired
source. Do not install the managed projector or grant it serving-layer ownership for external mode.

## Proposed staged install

> **Unavailable operation.** This command is documented for contract review and future disposable
> acceptance only.

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

For disconnected acceptance, append
`--registry-mirror harbor.example.internal/falcone --disconnected`. The executable must reject
`--disconnected` without a mirror. A reviewed migration is referenced explicitly with
`--reviewed-migration <non-secret-review-id>` and never permits implicit adoption.

Monitor stage transitions rather than only Pod `Ready` counts:

| Stage | Gate before continuing | Failure posture |
|---|---|---|
| `crds` | Every required CRD is applied and `Established`. | Name the CRD; do not start a dependent controller or webhook. |
| base resources | Namespaces, service accounts, cluster RBAC, configuration, and Services are present and owner-marked. | Preserve bounded diagnostics; no implicit adoption. |
| `webhook` backend | Webhook Deployment is available **without** AdmissionRegistration objects. | Do not create failure-policy admission registrations against an unavailable backend. |
| endpoint/certificate | Webhook Service has an endpoint and its generated serving certificate is available. | Stop before admission registration. |
| admission | Three configurations have non-empty CA bundles and an admission probe passes. | Do not write dependent Knative custom resources. |
| `serving` | Remaining Serving controllers are available. | Keep lifecycle/runtime status non-ready. |
| `kourier` | Controller and gateway are available under required security contexts. | Keep status non-ready and preserve diagnostics. |
| `smoke` | An isolated `ksvc` reaches Ready, is invoked cluster-internally through Kourier, and is deleted. | Never publish compatible/ready. Inventory any retained smoke resource. |
| `ready` | Lifecycle becomes `compatible`; every registered matching-owner application namespace receives a current leased `ready` projection. | Any missing/foreign registration is refused and reported without tenant metadata. |

If a stage fails, fix or forward-repair that stage and repeat under the same reviewed ownership. Do
not delete CRDs, force webhook configuration, change stored versions, or bypass smoke to make status
green.

Application namespace registration is also fail-closed. Its ephemeral hook reads the namespace and
the exact runtime ConfigMap; it refuses foreign/unowned state, or creates one already-expired
`unavailable` placeholder when absent, before applying registration labels with a Namespace
`resourceVersion` test. Repeated same-owner registration is idempotent, and revocation uses the same
optimistic-concurrency boundary.

## Observe lifecycle and runtime status

The following commands are read-only. Use metadata plus the bounded JSON data; do not request Secret
objects or broad namespace dumps.

```bash
kubectl --namespace knative-serving get configmap falcone-knative-status \
  -o jsonpath='{.metadata.labels}{"\n"}{.metadata.annotations}{"\n"}{.data.lifecycle\.json}{"\n"}'

kubectl --namespace <falcone-namespace> get configmap falcone-knative-runtime \
  -o jsonpath='{.data.status\.json}{"\n"}'
```

Before relying on lifecycle status, verify:

- `app.kubernetes.io/managed-by=Helm`;
- `app.kubernetes.io/instance=<release>` and version match the coordinated package;
- `meta.helm.sh/release-name` and namespace identify the lifecycle release;
- `schemaVersion` is `falcone.knative-lifecycle/v1`;
- `status` is `compatible` only after smoke; and
- executable version/SHA-256 and live cluster identity match the approved record.

Before relying on application runtime status, verify:

- `schemaVersion` is `falcone.knative-runtime/v1`;
- mode/owner/version match the application selection and owner marker;
- compatibility is honest and readiness state/stage/reason is bounded;
- `observedAt` and `validUntil` are valid, `validUntil` is still future, and the lease remains within
  the published maximum; and
- a ready document is no larger than 16 KiB and contains no tenant or workload identity.

An expired source lease must cause the tokenless guard to replace application-visible status with
`unavailable`. Do not edit the ConfigMap to extend a deadline manually.

Published timing bounds are: managed projector refresh every 30 seconds, managed projection lease
120 seconds, explicit external publication lease four minutes, and tokenless-guard maximum accepted
lease five minutes. Treat these as upper safety bounds, not availability promises; Kubernetes
ConfigMap propagation adds platform-dependent delay.

## Upgrade: one Knative minor at a time

Before mutation:

1. Re-run managed preflight and resolve every ownership or compatibility failure.
2. Verify the exact current bundle and requested next minor. A `1.20.x` to `1.22.1` jump is invalid;
   install a supported `1.21.x` intermediate first when such a bundle is published.
3. Record a tested recovery point containing resource inventory, CRD stored versions, image lock,
   configuration state, release/version/executable identity, and backup reference.
4. Quiesce new Function and hosted-MCP mutations for the approved window while preserving
   authenticated read/diagnostic behavior.
5. Verify Harbor contains every next-bundle digest if disconnected.

The public command shape is:

```bash
bin/falcone-knative upgrade \
  --from-version <current-knative-version> \
  --to-version <next-minor-knative-version> \
  --owner <exclusive-safe-owner-name> \
  --release falcone-knative \
  --recovery-point <new-non-secret-recovery-point-id> \
  --status-namespace knative-serving \
  --status-configmap falcone-knative-status \
  --output json
```

If `--recovery-point` is omitted the executable generates an identifier. Disconnected upgrades also
require `--registry-mirror <host/project> --disconnected`; verify the next image lock is completely
mirrored before invocation.

The lifecycle must reject a skipped minor before mutation and print the required intermediate
sequence. During an accepted upgrade it must execute required CRD storage-version migrations and
post-upgrade steps, gate each on readiness, repeat admission/data-plane smoke, refresh every runtime
projection, and emit the recovery-point reference.

`upgrade` is forward-only even within one minor. For example, `1.22.2` to `1.22.1` must use the
rollback command so live stored versions are checked before Helm or recovery mutation.

After success, compare stored versions, bundle/image/config state, lifecycle/executable identity, and
ready leases with the record. Exercise authorized P8 Function and P7/P12 hosted-MCP journeys plus
P10/P13 read-only/isolation checks before reopening mutations.

## Rollback, restore, and forward repair

Rollback is not synonymous with `helm rollback`. Never use Helm alone to downgrade Knative CRDs or
controllers.

```bash
bin/falcone-knative rollback \
  --to-version <previous-compatible-bundle-version> \
  --owner <exclusive-safe-owner-name> \
  --recovery-point <non-secret-recovery-point-id> \
  --output json
```

Before mutation, the lifecycle compares the target bundle with current stored CRD versions. It must
reject an incompatible binary downgrade. If a storage migration was irreversible, remain quiesced
and choose one of:

- **restore:** restore the approved pre-mutation recovery point, including stored custom resources
  and configuration, then prove consistency and smoke before unquiescing; or
- **forward repair:** keep the migrated storage version, repair/advance controllers and configuration
  to a compatible bundle, then repeat readiness and smoke.

Do not falsify a version, edit CRD status/storedVersions, or force a Helm revision. A rejected
rollback with zero mutation is correct behavior.

## Retain-by-default uninstall

Uninstall removes only resources proven safe and owned by this lifecycle. It retains CRDs and tenant
Knative workload state by default:

```bash
bin/falcone-knative uninstall \
  --owner <exclusive-safe-owner-name> \
  --release falcone-knative \
  --output json
```

Expected output enumerates removed and retained resource classes, explicitly including retained
CRDs and tenant workloads. Record them as recovery/cleanup obligations. Do not treat a missing Helm
release as proof that data or cluster-scoped objects are gone. The umbrella's mode must be changed
through a separate explicit decision; uninstall must not silently change application values.

When changing an application release from active `managed`/`external` to `disabled`, request the
one-time owner-checked registration revocation explicitly:

```bash
helm upgrade <falcone-release> charts/in-falcone \
  --namespace <falcone-namespace> \
  --set-string global.knativeRuntime.mode=disabled \
  --set global.knativeRuntime.unregister=true
```

The pre-upgrade hook removes the runtime-projection and owner labels only when the live namespace
still carries the same owner. A normal/default disabled render is hook-free. After the transition,
persist `unregister=false` on the next reviewed values update.

## Destructive purge boundary

Purge destroys retained CRDs/custom resources and tenant workload state. It is not an uninstall
option and is not authorized by this issue or runbook.

The unconfirmed inventory call must fail without mutation while enumerating impacted CRDs/workloads,
required backup evidence, and the separate confirmation requirement:

```bash
# Inventory/refusal only. Do not add a confirmation and do not execute a destructive purge here.
bin/falcone-knative purge \
  --owner <exclusive-safe-owner-name> \
  --release falcone-knative \
  --output json
```

An eventual purge requires a second, independently authorized invocation containing both
`--backup-evidence <reviewed-non-secret-id>` and the exact distinct phrase
`--confirm-purge PURGE-<release>-<owner>`. Do not reuse uninstall approval, automate confirmation in
CI, or paste a confirmation into a durable record. Before authorization, prove restore,
legal/retention approval, tenant impact notification, target identity, and a complete destructive
inventory. This document intentionally provides no executable confirmed-purge command, and no purge
was executed for issue 8.

The backup identifier must name an exact ConfigMap in the lifecycle status namespace. Before any
destructive call, the CLI requires the same owner, `falcone.io/backup-verified=true`, data schema
`falcone.knative-recovery/v1`, `state=verified`, and a `sha256:<64 lowercase hex>` inventory digest.
It then lists every custom resource for every installed managed CRD across all namespaces. One
missing owner label, foreign owner, missing record, or digest mismatch refuses the purge with zero
mutation. CRD deletion is reached only after that complete proof.

Only after that initial safe inventory, the confirmed implementation installs one temporary
`admissionregistration.k8s.io/v1` `ValidatingAdmissionPolicy` and matching
`ValidatingAdmissionPolicyBinding`. The policy is fail-closed and the binding denies `CREATE` and
`UPDATE` across exactly the Serving, Networking, Autoscaling, and Caching Knative API groups. With
Kubernetes admission, `UPDATE` covers HTTP PUT and PATCH mutations; `PATCH` is not a valid
`RuleWithOperations.operations` value. With
the fence active, the CLI re-inventories every pinned resource before the first deletion. It never
deletes with an owner selector: it deletes only the second inventory's exact custom-resource names,
then each exact bundle CRD name. Kubernetes UID/resourceVersion preconditions bind custom-resource
deletion to the re-inspected object when those fields are available. Any changed identity or
precondition conflict stops progress. The CLI removes the exact admission binding and policy only
after the last destructive deletion; no selector or collection cleanup is used.

## Quiesced single-owner handoff

Use handoff only under a reviewed migration plan, for example from Falcone-managed raw upstream
Knative to an administrator-owned Operator path:

```bash
bin/falcone-knative handoff \
  --from falcone \
  --to operator \
  --owner <exclusive-safe-owner-name> \
  --release falcone-knative \
  --status-namespace knative-serving \
  --recovery-point <new-non-secret-recovery-point-id> \
  --backup-evidence <reviewed-non-secret-backup-id> \
  --output json
```

The supplied backup evidence must satisfy the same exact verified-backup contract used by purge.
The state machine is ordered:

1. record backup/recovery point and full owned inventory;
2. verify the exact seven Falcone writers, scale every exact Deployment, and re-read zero replicas
   plus zero owner-matched writer Pods;
3. quiesce Function/MCP lifecycle writes and stop Falcone reconciliation while retaining
   CRDs/workloads;
4. resourceVersion-fence the source marker, atomically mark it released in both ownership metadata
   and data, then enable
   exactly one target owner carrying the previous-owner and backup-evidence references;
5. verify target adoption, admission, Serving/Kourier health, canary/smoke, status projection, and
   downstream behavior; and
6. resume writes only after target readiness is proven.

The seven writers are webhook, activator, autoscaler, Serving controller, Kourier controller,
Kourier gateway, and the release status projector. A missing owner label or non-zero post-scale
replica/Pod blocks release. The reverse path starts from exactly one live exclusive Operator marker,
not a historical released Falcone marker.

If the target mutates resources and then fails, remain quiesced. Do not restart the previous Falcone
owner concurrently. Restore the recovery point or forward-repair the target under one owner. The
reverse Operator-to-Falcone path also requires the Operator to be quiesced/released and the managed
preflight to prove clean, explicit handoff ownership; it is never implicit adoption.

## Outage, restart, and recovery

### Normal production response

The status projector continuously re-derives health and refreshes a bounded lease. On runtime or
projector failure:

- every registered matching-owner projection must move to `degraded`/`unavailable`, or its lease
  must expire to unavailable within the bounded projector + kubelet + guard window;
- Falcone Function/hosted-MCP gates remain closed;
- authorization and ownership checks continue to precede dependency disclosure;
- read-only status and audit remain bounded and secret-safe; and
- no operator manually fabricates a ready ConfigMap.

Triage the first non-ready `stage` and `reason`, lifecycle status, projector heartbeat/missed-refresh
metric, webhook endpoint/certificate/CA/admission probe, Serving controllers, Kourier, and cluster
events. Capture only the named resource and bounded recent events/logs. Repair the failed layer,
repeat smoke, and require fresh transition timestamps and leases before declaring recovery.

### Disposable acceptance hooks

`acceptance outage|restart|recover|replacement-conflict` are test hooks, not general production
incident commands. Use them only on a verified disposable target and provide every identity flag:

```bash
bin/falcone-knative acceptance <outage|restart|recover|replacement-conflict> \
  --api-server <exact-approved-api-url> \
  --cluster-uid <exact-approved-cluster-uid> \
  --infrastructure-name <exact-approved-infrastructure-name> \
  --infrastructure-id <exact-approved-infrastructure-id> \
  --run-id <unique-non-secret-run-id> \
  --release falcone-knative \
  --status-namespace knative-serving \
  --status-configmap falcone-knative-status
```

The executable must compare supplied identity to the live target before mutation. Missing/mismatched
identity fails with zero mutation. `outage`/`restart` must remove stale ready state; `recover` must
re-prove readiness and refresh every transition/lease; `replacement-conflict` must retain logical
ownership, remove only the same-name replacement during replay, and disclose no tenant/workload
identity.

The replacement delete carries the UID and resourceVersion observed during its owner-scoped read.
A same-name swap therefore yields a bounded precondition conflict, performs no replacement create,
and publishes no ready projection.

## Secret-safe troubleshooting

| Symptom | Read-only checks | Safe remediation boundary |
|---|---|---|
| Preflight says unsupported | Detected/supported matrix fields and exact executable/chart versions. | Move to exact matrix or use `external`/`disabled`; never override. |
| Ownership collision | Bounded object kind/name/owner classification; no full dumps. | Stop. Establish external ownership or design a quiesced handoff. |
| CRD stage timeout | Named CRD conditions and bounded events. | Repair API/admission issue; do not start dependent controllers. |
| Webhook/admission failure | Deployment availability, Service endpoint, certificate presence, non-empty CA bundle, admission probe result. | Repair backend/certificate/CA before registration/dependent writes. |
| Kourier rejected by OpenShift | Pod admission reason and rendered security context. | Require platform-assigned UID/GID with restricted-v2 controls; do not create a custom SCC. |
| Smoke fails | Bounded smoke stage/result and internal route result. | Repair Serving/Kourier, delete only owned smoke residue, retry stage. |
| Runtime was ready but app says unavailable | Source projection presence/schema/size/owner, `validUntil`, guard state, projector heartbeat. | Restore projector/health and publish a freshly proven lease; never extend/edit ready manually. |
| External remains unverified | Existing canary readability, compatibility, and invocation result. | External owner repairs/replaces canary; Falcone never creates it. |
| Rollback refused | Current CRD stored versions, migration record, target compatibility, recovery point. | Restore or forward-repair. Do not use Helm-only downgrade. |
| Handoff target fails | Recovery point, quiesced state, released/current owner, target mutation point. | Stay quiesced; restore or forward-repair one owner. |

Allowed evidence fields are actor, action, mode, owner, bundle, stage, result, correlation ID,
bounded reason, version/digest, non-secret run ID, cluster identity, timestamps, and retained/removed
resource classes. Redact or omit Authorization headers, cookies, tokens, kubeconfigs, Secret data,
pull credentials, tenant/workspace names, Function/MCP names, revision/URL payloads, and unbounded
logs/status.

When a support case needs logs, use the shortest relevant time window and exact workload, inspect
the output locally for sensitive content, then attach a redacted excerpt plus hashes/metadata. Do not
use `kubectl get secrets -o yaml`, `kubectl cluster-info dump`, an unrestricted `must-gather`, or
shell tracing around credential-bearing commands.

## Disposable acceptance cleanup and proof

Before acceptance, create an inventory with kind, namespace, name, owner marker, run ID, creation
time, and intended cleanup/retention action. Include cluster-scoped resources and status projections;
exclude Secret data and tenant payloads.

After each scenario:

1. delete the scenario's isolated smoke/canary/test workload only if the lifecycle owns it;
2. verify adjacent and foreign-owned resources are byte-for-byte/identity unchanged;
3. use retain-uninstall for the lifecycle release and record retained CRDs/workload obligations;
4. remove the disposable cluster through the separately authorized environment teardown, not an
   unreviewed purge;
5. prove all inventoried disposable resources are absent or explicitly retained with an owner and
   recovery action;
6. prove application projections no longer claim stale ready state; and
7. independently review the cleanup record before ending the run.

Do not execute the destructive purge command to make an acceptance cleanup convenient. If the
environment cannot be cleaned without it, the environment owner must provide a separate destructive
authorization and verification workflow outside issue 8.

## Evidence checklist and completion criteria

An operation is complete only when its intended result and cleanup/recovery obligations are both
evidenced:

- exact target and executable/chart/bundle identity verified;
- preflight result and zero-mutation failure evidence retained;
- stage transitions and readiness/smoke outcome retained;
- lifecycle ConfigMap Helm ownership and schema verified;
- every registered matching-owner projection has the correct fresh lease;
- unregistered/foreign namespaces were refused without metadata disclosure;
- P8/P7/P12 behavior and P10/P13 read-only/isolation expectations were checked as applicable;
- Harbor-only digest resolution and `restricted-v2` admission were proven when applicable;
- recovery point, retained state, rollback/forward-repair, and handoff obligations recorded;
- bounded evidence was inspected for secrets and tenant/workload identifiers; and
- disposable cleanup is complete and independently reviewed.

Until the remote OpenShift 4.21 acceptance, coordinated Falcone issue 933 journey, and cleanup proof
exist, the only correct final status for managed support is **proposed/unavailable**.
