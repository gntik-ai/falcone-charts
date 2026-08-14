# Staging infrastructure repair (chart 0.4.19)

Verified source baseline: `gntik-ai/falcone-charts` commit
`c7cd7bbde9b41f0c218f77c4c43c6923c9272739`, 2026-08-10. Upgrade anchor:
Helm release `falcone`, revision 20, chart 0.4.1, Kubernetes context `default`,
namespace `in-falcone-staging`. This page is for P18 release engineers, P3 SREs,
P4/P10 read-only auditors, and P17 documentation-only responders. P8/P9/P12
data journeys and the P13 adjacent-tenant negative journey are post-recovery
acceptance gates.

## Status, outcome, and exclusions

Chart 0.4.19 carries the prior repair chain and repins all six first-party images to
Falcone main `d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc`, published by successful
`release-images` run `31337244501` as tag `0.6.6-main-d9cd0f6b`. Chart 0.4.6
corrected the dependency-version boundary
that blocked 0.4.5, but its live Phase-A apply then proved a second migration
gap: all fourteen canonical Falcone `ExternalSecret` declarations already
existed without Helm owner metadata, so Helm refused to import the first one
before the release revision advanced. Chart 0.4.7 adds only the exact,
fail-closed ownership migration for those fourteen declarations. It does not
overwrite the published 0.4.5 or 0.4.6 artifacts and changes no API, schema,
storage, authorization, image, or runtime contract.
The first real 0.4.8 Phase-A attempt then proved a third migration gap: using
the staging profile without `--reuse-values` omitted non-secret revision-20
storage values and asked Kubernetes to change four bound PVCs plus two immutable
SeaweedFS claim templates. Revision 22 failed before any PVC deletion. Chart
0.4.9 validates the exact failed-history fingerprint and public storage metadata,
then passes the validated storageClass and size values explicitly to every
render, diff and upgrade. Published chart 0.4.8 remains unchanged.
The real 0.4.9 Phase-A rollout then exposed a fourth migration gap: vanilla
Kubernetes rejected the new APISIX and Prometheus Pods because both images
declare named users while the base chart asserted `runAsNonRoot` without a
numeric identity. Revision 23 was canceled after the exact failure was captured;
the old three APISIX replicas and the old Prometheus replica remained Ready, and
the pgvector PVC was not touched. Chart 0.4.11 assigns the verified image
UID/GID 636:636 to APISIX and 65534:65534 to Prometheus. The OpenShift restricted
render still removes fixed identities so its SCC assigns an allowed arbitrary
UID/GID. Chart 0.4.10 packaged that correction and was published immutably, but
was not applied. Before its preflight could run, an authorized `kubectl-patch`
partially repaired APISIX and mounted the pre-existing standalone route
ConfigMap while Prometheus remained in the exact failed rollout. Because that
new live precursor is not the state 0.4.10 admitted, chart 0.4.11 replaces the
active recovery target rather than overwriting 0.4.10. Published charts 0.4.8,
0.4.9 and 0.4.10 remain immutable.
The first authorized 0.4.11 apply became failed revision 24 after all application
rollouts converged: Helm's global `--wait` also waited for the deliberately
Pending pgvector PVC/StatefulSet that Phase A must preserve. During that wait it
also exposed the revision-20 `ClusterSecretStore/openbao-backend` hook still
pointing at `external-secrets/eso-openbao-auth`; the current identity is
`eso-system/eso-openbao-auth`. Chart 0.4.12 admitted only that exact r24
fingerprint, hands off the legacy store with a UID/resourceVersion-guarded patch,
and replaces global Phase-A wait with explicit bounded rollout checks that omit
only pgvector. Phase B retains global wait after the separately confirmed empty
claim is recreated.
The first 0.4.12 recovery attempt proved two more fail-closed prerequisites
before Helm advanced: the administrator-owned ESO controller needed explicit
network egress to `secret-store` TCP/8200, and `eso-role` still authorized the
legacy namespace. The package then exposed a contradictory canary contract by
setting `token_no_default_policy=false` while requiring exactly four policies,
so OpenBao correctly added `default` and the hook rejected its own token.
Chart 0.4.13 was published but not applied: its packaged forward-recovery wrapper
executed the delegated repair script directly even though Helm archives extracted
that script with mode 0644, and its isolated auth Job render omitted Helm's
upgrade context. Chart 0.4.14 superseded that immutable defective artifact, and
its package-bound Job ran far enough to normalize the auth role and handoff
metadata without advancing Helm beyond failed revision 24/chart 0.4.11. The
administrator-owned ESO controller then proved that the `platform` policy lacked
the exact token self-service permissions needed by OpenBao's login validation:
the desired store remained `Ready=False/ValidationFailed` on a literal HTTPS
`GET /v1/auth/token/lookup-self` 403. Chart 0.4.15 preserved that partial attempt
as immutable evidence, installs only `lookup-self/read` and
`revoke-self/update` into `platform`, and runs the package-bound auth reconciler
before the store readiness gate,
uses recovery-root only for that bounded metadata repair, requires exactly one
accepted terminal result, and sets `token_no_default_policy=true`. Only after
that gate may it hand off the store, wait each of the fourteen ExternalSecrets,
and perform the two no-root Phase-A upgrades.
Chart 0.4.15 was published but was not applied: its pre-mutation gate accepted
the stale all-Ready ExternalSecret window but rejected the stable live precursor
where all fourteen report the same `SecretSyncedError`. Chart 0.4.16 keeps the
auth repair unchanged and admits only those two exact homogeneous sets for the
already-desired self-token-policy failure.
The authorized 0.4.16 attempt then created
`openbao-auth-reconcile-r24-10828ffdf9f1-f65tk`, but a successful dedicated
login prevented the recovery-root branch and platform policy write from running.
That Job failed and Helm remained r24/0.4.11. Chart 0.4.17 preserves the
0.4.14 and 0.4.16 failed Jobs as exact public evidence, forces recovery-root
authentication only in the isolated r24 Job, and rejects any other retained-Job
chain before mutation.
The forced 0.4.17 Job
`openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw` did use root and reported
successful policy writes, but it mounted the canonical policy ConfigMaps from
the still-live 0.4.11 release. Its ESO token therefore retained the old platform
HCL and lookup-self still returned 403. Chart 0.4.18 corrects that package/live
source mismatch; 0.4.17 is evidence, not a retry or rollback target.
The exact real packaged 0.4.18 recovery then consumed its one-use JIT but failed
the distributed CLI guard with `REVISION24_AUTH_RECONCILE_RENDER_DRIFT` before
`kubectl create`. The rendered Job was valid; the guard selected the earlier
dedicated `login_json` command because it searched for the first generic OpenBao
login substring instead of the later `canary_json` assignment. No 0.4.18 Job,
store patch, owner patch, Helm operation, or new release revision occurred.
Chart 0.4.19 is a new immutable package that fixes that proof boundary. It
requires a newly published digest, fresh evidence and a fresh one-use JIT; the
consumed 0.4.18 authorization cannot be reused.
For packaged r22/r23/r24 delegation the forward-recovery wrapper launches the
package-local repair script through `bash`; operators do not need to change the
0644 mode produced by chart extraction. The r24 auth-only render explicitly uses
`helm template --is-upgrade ... --show-only` so the chart's upgrade-only
adoption/recovery validation is enforced before the first mutation. Helm render
failure remains `REVISION24_AUTH_RECONCILE_RENDER_FAILED`; semantic or structural
drift is `REVISION24_AUTH_RECONCILE_RENDER_DRIFT`. Do not chmod package contents,
bypass validation, or fall back to charts 0.4.13 through 0.4.18.
It consumes (but never adopts) an administrator-owned
External Secrets Operator, converts OpenBao Kubernetes auth to its rotating
pod-local reviewer identity, fixes FerretDB's non-root init identity and rollout,
and supplies a staging-only pgvector storage topology. It also makes Helm
authoritative for six approved first-party image digests.

The local-path decision is staging-only, single-replica, node-local, non-HA, and
uses a StorageClass with `Delete` reclaim behavior. It is not a production
default or durability claim. No cluster apply, PVC deletion, production storage
change, or OpenBao payload migration is performed by packaging this chart.

## Ownership and security contract

The administrator owns ESO controllers, webhook, cert-controller, CRDs, and all
objects in `external-secrets`. Falcone renders nothing into that namespace and
must not label, annotate, patch, delete, force, take ownership of, or adopt those
objects. Falcone owns `ClusterSecretStore/openbao-backend`, fourteen
`ExternalSecret` declarations, `eso-system/eso-openbao-auth`, and exact RBAC:

- `external-secrets/external-secrets` and
  `secret-store/openbao-auth-reconciler` may create a token only for
  `eso-system/eso-openbao-auth`;
- `secret-store/openbao` is used only by the OpenBao StatefulSet, may create
  TokenReviews, and cannot read or write platform/recovery Secrets;
- `secret-store/openbao-bootstrap` is used by fresh bootstrap and the disabled
  migration placeholder; it can read only the fourteen named bootstrap Secrets
  and can create or update only the recovery Secret needed for initial custody;
- `secret-store/openbao-auth-reconciler` uses a dedicated OpenBao policy that
  can reconcile only Kubernetes-auth config and `eso-role` metadata plus perform
  token self-lookup/revocation; it cannot access KV, mounts, audit configuration,
  policy documents, or the bootstrap identity;
- the identity-only `eso-openbao-auth` ServiceAccount receives no Secret
  mutation, TokenReview, or cluster-wide permission;
- OpenBao NetworkPolicy remains limited to DNS plus Kubernetes API ports 443 and
  post-DNAT 6443; no application egress expansion is introduced.

When ESO is administrator-owned, its operator must already be able to reach
`secret-store` TCP/8200. Falcone validates convergence but never creates,
adopts, or patches a controller or NetworkPolicy in `external-secrets`.

Never put a ServiceAccount JWT, OpenBao token, unseal material, Secret value,
tenant payload, kubeconfig, or backup content in values, arguments, logs, diffs,
evidence, or tickets. The runbook inspects metadata and conditions only.

For the revision-20 anchor only, Phase A prevalidates the exact fourteen live
Falcone declarations against the package render after normalizing ESO CRD
defaults. All fourteen are checked before any patch. Each object must have all
three Helm owner markers absent or the exact `Helm`/`falcone`/
`in-falcone-staging` tuple from an idempotent retry. Partial/foreign ownership,
identity drift, spec drift, UID drift, or resourceVersion drift fails closed.
Apply adopts only an absent tuple using a single metadata-only JSON patch guarded
by the observed UID and resourceVersion; it never reads a generated Secret or
uses `--take-ownership`.

## Canonical staging configuration

Use `values/staging.yaml`; do not reproduce these settings with imperative
Deployment patches. The profile selects externally managed ESO using exact
namespace and ServiceAccount identity, keeps Falcone auth in `eso-system`, pins
pgvector to `local-path` plus `topology.kubernetes.io/region=fsn1`, and declares
the APISIX UID/GID plus the mount of the existing administrator-provided
`falcone-apisix-standalone` ConfigMap. Helm does not create or adopt that
ConfigMap. Recovery requires its sole `apisix.yaml` entry to match SHA-256
`28aa61f223b1306a9604817f44abf6c8c1c867e6ba9020bc9ff85235dd2c555b`
without printing the data. The profile also records these immutable digests:

| Workload/runtime | Approved digest |
|---|---|
| control-plane | `sha256:26bb5ff1caa0ffbd9f902b5da645fa69caa9153ff6d19b28eda640f35f9c4254` |
| control-plane-executor | `sha256:94809c39149cb6d2aa12a606f5b7db19d8365e1a857b83bcd45405554116feae` |
| web-console | `sha256:4ccb885b4e15637e68f409fcedf93f180397fad3d6ccf331961d41e43af8c868` |
| workflow-worker | `sha256:0520d57d36ee1383c2077388eb4880023f3b5c11536107151a1e01657001e8aa` |
| function runtime | `sha256:b50e93fb529a2129daa4e682ea4ae3741967a649c5fc1cc5f2f2b6588eb1a0fd` |
| MCP runtime | `sha256:f0bb4c639f08c40c650e3f2b45a0d3c546fa84b0ae5d2eb9a4153860ec06a162` |

Render and schema-check before any environment action:

```bash
helm lint --strict charts/in-falcone
helm template falcone charts/in-falcone \
  --namespace in-falcone-staging \
  -f charts/in-falcone/values/staging.yaml > /tmp/falcone-staging.yaml
```

Expected: lint succeeds; the render contains no object whose metadata namespace
is `external-secrets`; the six images contain the digests above; pgvector uses
`local-path` and `fsn1`; FerretDB has UID 999, `maxUnavailable: 0`, and
`maxSurge: 1`; APISIX has `runAsUser`/`runAsGroup` 636; and Prometheus has
`runAsUser`/`runAsGroup` 65534. Both retain `runAsNonRoot`. An OpenShift
restricted render must omit those fixed APISIX and Prometheus identities.

## Fresh installation

First prove the package in a disposable non-production cluster beside a separate
disposable ESO release. Confirm the ESO APIs and exact controller ServiceAccount
before installing. Fresh installation runs the complete OpenBao bootstrap once:
initialization/unseal recovery handling, auth/mount/audit enablement, established
policy documents and initial KV seeding. The following auth hook then normalizes
only Kubernetes auth metadata and executes a no-KV login/lookup/revoke canary.
The server, bootstrap and reconciler Jobs use the distinct ServiceAccounts
`openbao`, `openbao-bootstrap`, and `openbao-auth-reconciler`, respectively.

An upgrade render never contains `Job/openbao-init`; it contains only
`Job/openbao-auth-reconcile`. Routine upgrades neither load platform Secrets nor
run `bao kv`, policy-document read/write/delete, or secrets-engine mutation.

After disposable install, wait for `ClusterSecretStore/openbao-backend` and all
fourteen ExternalSecrets to report Ready without querying target Secrets. Prove
FerretDB 2/2 Ready and pgvector Bound/Ready on `fsn1`. Uninstall Falcone and
prove the independent ESO release and its owner metadata are unchanged.

## OpenBao 403 decision tree

Read only auth metadata, in this order:

1. Verify the `kubernetes/` auth mount and OpenBao Ready/unsealed status.
2. Verify sanitized config fields: Kubernetes host, `disable_local_ca_jwt=false`,
   and `token_reviewer_jwt_set=false`. Never print JWT or CA bytes.
3. Verify `eso-role` binds exactly `eso-system/eso-openbao-auth`, policy names
   `platform,functions,gateway,iam`, TTL 86400 seconds, and
   `token_no_default_policy=true`.
4. Verify `secret-store/openbao` can create only TokenReviews, and that the exact
   ESO controller plus `secret-store/openbao-auth-reconciler` can request only
   the named auth ServiceAccount token. Confirm the bootstrap identity is not a
   subject of either permission.
5. Verify DNS and API egress on 53, 443, and 6443.
6. Inspect the bounded reconcile result code and OpenBao audit operation path,
   not request bodies.

`result=changed code=AUTH_METADATA_CONVERGED canary=passed` means one metadata
normalization occurred. `result=unchanged code=AUTH_METADATA_MATCHED
canary=passed` proves idempotency. `ROLE_MATCHES_AUTH_STILL_DENIED` means the
role already matches; stop rewriting it and diagnose TokenReview, TokenRequest,
mount, CA, and network. Other failures preserve KV and policy documents and
remain retryable.

## FerretDB rollout and availability

The `wait-for-documentdb` init container runs the pinned
`postgres-documentdb` digest as UID 999 with non-root, no privilege escalation,
dropped capabilities, and a read-only root filesystem. The Deployment keeps at
least two ReplicaSet revisions, uses `maxUnavailable: 0`, `maxSurge: 1`, and a
600-second progress deadline. OpenShift restricted mode removes the fixed UID so
its SCC may inject an allowed namespace-range identity.

During rollout, monitor Deployment replicas and EndpointSlices. The old Ready
ReplicaSet must continue serving the previous endpoint count until a replacement
passes `/debug/readyz`. A stalled replacement should reach ProgressDeadlineExceeded
without scaling every old endpoint away. Do not delete the old ReplicaSet.

## Revision-20 or admitted revision-23/revision-24 upgrade: dry run and Phase A

Do not make shared staging the first target. Rehearse revision 20, injected
reviewer/RBAC/network/Ferret/readiness failures, retry, Phase B, and forward
recovery in a disposable environment first. Record only references to an
approved backup and secret-safe evidence.

The operator host must provide `kubectl`, Helm, `jq`, `sha256sum`, Python 3 and
the PyYAML `yaml` module. Verify the local-only render parser before preflight:

```bash
python3 -c 'import yaml'
```

Apply additionally requires the Helm diff plugin. The parser reads only the
locally rendered manifests; it does not call a Kubernetes create/apply verb or
send the render to the API server.

The migration executable defaults to preflight and makes no mutation:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-a
```

Expected: it confirms context `default`, namespace `in-falcone-staging`, release
`falcone`, revision `20`, and source chart `in-falcone-0.4.1`; renders all six
digests; retains the existing immutable `hcloud-volumes` PVC contract for Phase
A; and runs a secret-suppressed Helm diff. The diff is checked semantically
against the sanitized 21-object inventory of the separate ESO owner, including
cluster-scoped objects. It never reads a Helm release manifest or Secret data.

Before apply, create two separate, current, metadata-only JSON attestations:

- `Revision20BackupEvidence` identifies exact context/namespace/release,
  revision 20, chart 0.4.1, target repair chart 0.4.19, published package digest,
  a non-secret backup reference, `verified: true`, `observedAt`, and
  `validUntil`;
- `Revision20ParityEvidence` binds the same target and package digest to a
  distinct parity run and names the exact backup reference it verified.

Opaque strings are not apply evidence. Expired, malformed, reused, differently
targeted, or package-mismatched attestations fail before mutation.
For a real apply the tool pulls chart 0.4.19 from
`oci://ghcr.io/gntik-ai/charts/in-falcone`, verifies the registry-reported digest
against both attestations, and renders/applies that extracted artifact and its
own staging profile. It does not apply an unbound checkout after merely comparing
a digest-shaped string.

After authorized disposable proof and a separate environment approval, the
applying invocation is:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-a --apply \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --confirm-target 'default/in-falcone-staging/falcone@20/in-falcone-0.4.1->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST'
```

For the admitted failed 0.4.8 attempt, the same two evidence documents must be
retargeted to the published 0.4.19 digest and the one-use confirmation is instead:

```text
default/in-falcone-staging/falcone@22/in-falcone-0.4.8->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST
```

For revision 23, preflight additionally requires the exact public history chain:
revision 20 is deployed chart 0.4.1 with `Upgrade complete`; revision 22 is the
failed chart-0.4.8 six-resource immutable-storage rejection; and revision 23 is
failed chart 0.4.9 with exactly `Upgrade "falcone" failed: context canceled`.
It then verifies the two Deployments and their Pods by labels, images,
ReplicaSet ownership, observed generation, replica counts, availability and
waiting status. Exactly one APISIX and one Prometheus replacement must be
Pending with their named-user `CreateContainerConfigError`, while three APISIX
and one Prometheus Pods remain Ready. Any extra, missing or changed failure,
image, owner, count, message or availability fails before mutation. It reads no
Pod logs, Secret payloads or Helm release manifest.

One additional revision-23 precursor is admitted because the live release was
partially repaired outside Helm before the 0.4.10 preflight: APISIX must be
generation 7, exactly 3/3 Ready on one revision-7 ReplicaSet whose Deployment
owner name/UID and Pod owner name/UID form one exact controller chain, use pod
UID 636 with no pod GID declaration, report runtime UID/GID 636:636 with zero
restarts, and mount the exact standalone ConfigMap; observability must remain
generation 5 with one Ready Pod and exactly one Pending `nobody` named-user
error. The ConfigMap name,
single key and digest above are revalidated, and no other named-user error may
exist in any namespace. Any different patch, mount, UID/GID, owner, count,
status, ConfigMap content or global error fails before render or mutation.

Revision-23 apply uses fresh backup/parity attestations bound to chart 0.4.19 and
the published package digest, plus this exact one-use confirmation:

```bash
charts/in-falcone/migrations/revision-20-forward-recovery.sh \
  --apply \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --confirm-target 'default/in-falcone-staging/falcone@23/in-falcone-0.4.9->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST'
```

Because revision 23 is itself a failed Phase-A attempt, forward recovery
delegates to the two-pass Phase-A implementation and does not accept or
fabricate a Phase-A attestation. It does not use `--atomic`, `--reuse-values`,
rollback or PVC deletion.

Revision 24 is admitted only when Helm history also preserves the exact
revision-20 deployed source, revision-22 immutable-storage failure and
revision-23 canceled named-user failure; r24 itself must be failed chart 0.4.11
with the exact vector-PVC/vector-StatefulSet, legacy-store, fourteen
ExternalSecret and deadline-exceeded fingerprint. Public evidence must show the
same unbound PVC UID, all non-vector workloads converged, APISIX 636:636,
Prometheus 65534:65534, zero named-user failures, the exact legacy hook store,
the `eso-system` ServiceAccount and exactly fourteen NotReady ExternalSecrets.
It also admits only the observed 0.4.14 partial recovery: the same store UID,
labels, Helm owner and desired `eso-system` provider spec; no hook annotations;
the exact `in-falcone.io/reconcile-request=phase-a-0.4.12-auth-updated` annotation;
one `Ready=False`, `ValidationFailed` condition whose literal message identifies
HTTPS `GET /v1/auth/token/lookup-self`, code 403 and `permission denied`; and the
same fourteen unique ExternalSecrets in one of two complete homogeneous states.
Every object must have exactly one condition: either all are `Ready=True`, or
all are exactly `Ready=False`, reason `SecretSyncedError`, message
`could not get secret data from provider`. Mixed states, extra or absent
conditions, condition field drift, namespace/name/cardinality drift, and
duplicates are rejected. ExternalSecret UIDs are not hardcoded. The store
resourceVersion is captured dynamically for evidence rather than hardcoded.
For the stable provider-error set, preflight additionally lists only public Job
metadata and requires the exact retained r24 auth anchors from 0.4.14, 0.4.16
and 0.4.17.
Their names, UIDs, package/target/source and hook annotations, `failed=1`, and
exactly two uniquely typed `FailureTarget` and `Failed` conditions, both
`True/BackoffLimitExceeded`, must match the release notes; `succeeded` is absent
or zero. Each anchor has exactly six annotations: three provenance and three
Helm hooks. Condition order and messages are not fixed.
Resource versions and timestamps remain dynamic. A retry may add only a fully
attested terminal Job for the current 0.4.19 digest: the digest-prefixed
generated name has a valid suffix, the UID is a unique UUID, and exactly seven
annotations are present—the six provenance/hooks plus the quoted
`falcone.gntik.ai/attested-chart-version=0.4.19`. Its status is exactly one of:
Failed with `failed=1`, `succeeded` absent or zero, and only
`Failed`+`FailureTarget` `True/BackoffLimitExceeded`; or Kubernetes v1.36
Successful with `succeeded=1`, `failed` absent or zero, and only
`Complete`+`SuccessCriteriaMet` `True/CompletionsReached`. All names and UIDs are
unique. Missing anchors or any other metadata/status history drift reports
`REVISION24_AUTH_RECONCILE_HISTORY_DRIFT` before mutation. Because the
0.4.18 failure was pre-create, any Job name, generated prefix, target annotation,
or alleged anchor for 0.4.18 is unexpected history and fails the same gate.
The history fence runs after Store and fourteen-ExternalSecret precursor
validation on every admitted exact r24 retry, regardless of Store state. In
particular, Store `Ready`/`complete` after a Successful auth Job and downstream
failure still requires the history read and strict validation before a new
create; no admitted Store state bypasses the fence.
Any history, resource, owner, spec, UID, resourceVersion, count, condition or
identity drift fails before mutation.

Dry-run reports whether the exact store requires handoff or only the platform
self-token policy repair. Apply first renders
only the official auth-reconcile Job from the digest-attested package, sets
`allowRecoveryRoot=true` and `forceRecoveryRoot=true` for that Job alone, and
does not attempt the otherwise successful dedicated login. The forced Job does
not mount either canonical policy ConfigMap. Instead, the same Helm helpers that
render those ConfigMaps embed the exact platform and auth-reconcile HCL into the
package Job; it writes those bytes into private `emptyDir` snapshots and verifies
their rendered SHA-256 values before authentication. Before create, the 0.4.19
guard requires exactly one semantic command substitution assigned to
`canary_json` whose command is
`bao write -format=json auth/kubernetes/login`, whose role is exactly
`role="$role"`, and whose JWT is read only from `/canary/token`. The earlier
dedicated `login_json` branch remains present but cannot satisfy this match. A
missing, duplicated, renamed, differently roled or differently sourced canary
fails `REVISION24_AUTH_RECONCILE_RENDER_DRIFT`.

The same guard captures unique anchors and requires strict order: platform and
auth-reconcile snapshot materialization, both SHA-256 checks, the accepted
recovery-root source, platform policy, auth-reconcile policy, bootstrap role,
reconciler role, ESO role, semantic canary, lookup-self, revoke-self, and the
two-result terminal block. It continues to require one Job and one reconciler
container, `restartPolicy: Never`, `backoffLimit: 0`, exact policy content,
private `emptyDir` mounts, the recovery mount, and no canonical policy ConfigMap
mount. It loads the mounted recovery token directly,
emits the credential-silent marker
`auth_source=recovery_root result=accepted`, writes the platform snapshot and
then auth-reconcile snapshot, and only then changes or validates roles and the
canary. The stable
`PLATFORM_POLICY_BOOTSTRAP_FAILED` error stops before every later mutation. The
canonical value `forceRecoveryRoot=false` is valid in routine reconciliation;
`true` is rejected unless `allowRecoveryRoot=true`. Routine upgrades remain
dedicated-only, mount no recovery Secret and cannot write policies. The
dedicated reconciler receives no policy-write, mount, Secret or KV permission.
Forced recovery uses `restartPolicy: Never` and `backoffLimit: 0`, retaining one
terminal Pod/container log for diagnosis. It never replaces that evidence with
an automatic restart or replacement attempt.
The CLI converts only the Job's execution metadata to
`generateName: openbao-auth-reconcile-r24-<digest12>-`. The attempt is annotated
with the quoted attested chart version, complete package digest, target chart
and source revision. The CLI uses
`kubectl create -o name`, validates the single generated `job.batch/...` ref,
waits on that exact ref for `Complete` for at most five minutes (the Job itself
has a 300-second active deadline), reads only that ref's log, and accepts exactly
one forced-root source marker plus one `changed/CONVERGED` or
`unchanged/MATCHED` terminal line with `canary=passed`.
The source marker must be exactly
`auth_source=recovery_root result=accepted` in the freshly created Job's log on
every attempt, even when history already contains a Successful current-package
Job. It emits no credential and reads no Secret. Failure or log drift stops before
store, ExternalSecret, or Helm mutation. Failed attempts remain available as
evidence. A retry repeats package and live preflight, creates a new generated
identity, and never reapplies, deletes, waits on, or reads a stale Job, including
`openbao-auth-reconcile-r24-859e037a14be-7v86n` and
`openbao-auth-reconcile-r24-10828ffdf9f1-f65tk`, or the exact failed 0.4.17 Job
`openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw`. The
procedure then validates the
store's unique desired rendered object and exact admitted live form. Only the
legacy hook form uses one
JSON patch with UID and resourceVersion tests to remove only
`helm.sh/hook`/`helm.sh/hook-weight` and replace the public spec. It never
patches the already-desired precursor. It never reads a Secret or patches
the administrator-owned ESO release. The store and all
fourteen ExternalSecrets must become Ready before Helm starts. Revision-24 apply
uses fresh 0.4.19-bound backup/parity evidence and:

```text
default/in-falcone-staging/falcone@24/in-falcone-0.4.11->in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST
```

Acceptance of that exact confirmation consumes the one-use authorization and
prints `authorization_consumed=true`. Pull, render and guard remain read-only.
For any rejection before create, expected failure evidence includes
`mutation_started=false` and omits `FORWARD_RECOVERY_REQUIRED`; the live
r24/0.4.11 state needs no restoration, but another attempt still needs a fresh
JIT. Immediately before invoking `kubectl create`, the CLI records
`mutation_started=true`. A create error or lost response is therefore treated
as potentially accepted by the API server and emits `FORWARD_RECOVERY_REQUIRED`,
as does every later failure.

Before the first mutation the recovery tool parses the rendered APISIX
Deployment and requires pod and container UID/GID 636:636 plus the exact mount.
Each Phase-A Helm command omits global `--wait`, whose resource set includes
the intentionally Pending vector workload. After each upgrade the procedure
uses a 20-minute Helm timeout and then waits up to ten minutes per Falcone
Deployment, non-vector Falcone StatefulSet and OpenBao. Its health gate requires the same live APISIX
identity and Prometheus container UID/GID 65534:65534. A convergence drift stops the
current Phase A, emits forward-recovery guidance and prevents the next pass.

Before either apply, preflight reads only public metadata/spec and proves the
four standalone PVCs are Bound `local-path` 10 Gi, the filer/master immutable
claim templates remain `hcloud-volumes` 10 Gi, and their historical child PVCs
are Bound `local-path` 10 Gi. Any drift or a list/history mismatch invalidates
the confirmation. The tool never uses `--reuse-values`.

Phase A forces the retained recovery credential only in the isolated pre-handoff
auth Job. Both Helm
passes keep the recovery-root allowance disabled and compare exact ESO owner metadata captured immediately
before them. After the no-root pass it repeats the owner/image/store/auth/
FerretDB/EndpointSlice gates and requires auth `result=unchanged`, the exact
fourteen unique named ExternalSecrets Ready, FerretDB 2/2, and at least two
Ready endpoints. Phase A does not delete or change the PVC.

Create a fresh `StagingPhaseAAttestation` from that final metadata-only result.
It binds the original 20/0.4.1 source, the actual current revision, chart 0.4.19,
the same package digest, recovery-root disabled, auth unchanged/canary passed,
store/ExternalSecret/FerretDB health, owner-inventory digest, image-set digest,
and a short `observedAt`/`validUntil` window. Phase B rejects a missing, stale,
or live-revision-mismatched Phase-A attestation.

## Phase B: exact empty-PVC destructive gate

Phase B is a separate maintenance window. Its preflight rechecks exact context,
namespace, release, PVC name and immutable UID; requires phase `Pending`, empty
`spec.volumeName`, no PV claimRef and no successful vector Pod; and renders
`local-path`, 10 Gi, RWO and `fsn1`. The one admitted initial Pod topology is
exactly `falcone-postgresql-vector-0`, Pending, controlled by the exact vector
StatefulSet, and referencing that claim. Any other Pod reference fails closed.
Unbound plus no PV/data-bearing Pod is the metadata proof that no volume/data
exists; if any evidence changes, stop and design a real backup/restore migration.

Dry run:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-b --pvc-uid PVC-UID-FROM-PREFLIGHT
```

Only after reviewing that output may the human provide the exact one-use name
and UID confirmation:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-b --apply \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --phase-a-attestation /secure/path/phase-a.json \
  --confirm-target 'default/in-falcone-staging/falcone@CURRENT_REVISION/in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST' \
  --pvc-uid PVC-UID-FROM-PREFLIGHT \
  --confirm-pvc falcone-postgresql-vector-data/PVC-UID-FROM-PREFLIGHT
```

The script first admits only the exact initial Pending Pod described above. It
then scales only `falcone-postgresql-vector` to zero, performs a bounded wait for
that Pod to terminate, and only then rereads UID/phase/volumeName, every matching
PV claimRef, Pod reference, and successful/data evidence. Immediately before
the exact delete it also revalidates live revision/chart and unchanged external
owner metadata. A changed UID/state invalidates confirmation. No wildcard,
label-wide deletion, namespace deletion, unbounded wait, or blind retry is
allowed.

## Health, evidence, and alerts

P3/P4/P10 checks require no Secret access:

- external ESO controller Available with unchanged Helm owner annotations;
- store Ready and fourteen `ExternalSecret` conditions Ready/SecretSynced within
  ten minutes;
- OpenBao Ready plus reconcile `changed` once or `unchanged`, canary passed;
- FerretDB ends 2/2 Ready without dropping the prior EndpointSlice count;
- pgvector PVC Bound using local-path, Pod Ready on region `fsn1`, `pg_isready`
  and extension availability checked without selecting tenant rows;
- post-upgrade secret-suppressed diff empty except hook lifecycle objects;
- six live pod-template images match canonical staging values.

Alert on an ExternalSecret not Ready for ten minutes, FerretDB available replicas
below two during this rollout, PVC Pending five minutes after Phase B, or any
owner/image drift. Bound logs and Events; redact authorization headers, JWTs,
cookies, Secret data, request bodies, tenant identifiers, and unseal material.

## Failure, retry, rollback, and forward recovery

Before Phase A, revision 20 is untouched. The published 0.4.18 failure occurred
before create, so it needs no cluster rollback and produced no Job or Helm
revision. Once 0.4.19 may attempt create, every mutation path is forward-only:
the tools do not use atomic upgrade or any rollback operation. A post-create
failed apply prints `FORWARD_RECOVERY_REQUIRED`; inspect metadata, correct the
cause, obtain fresh target-bound authorization as required, and reapply the same
0.4.19 package. For revision 24, do not delete or reuse a retained
`openbao-auth-reconcile-r24-*` Job: the retry creates a new digest-prefixed
identity and binds its wait/log evidence only to the ref returned by that create.
Revision 20 reintroduces owner overlap, static reviewer expiry, Ferret init
failure, and old image defaults.

After PVC deletion, revision 20 cannot restore service because `hcloud-volumes`
does not exist. Use the dry-run-first forward recovery tool:

```bash
charts/in-falcone/migrations/revision-20-forward-recovery.sh \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --phase-a-attestation /secure/path/phase-a.json
```

After review, its apply requires the actual
`default/in-falcone-staging/falcone@CURRENT_REVISION/in-falcone-0.4.19/sha256:PUBLISHED_PACKAGE_DIGEST`
confirmation. It revalidates the same three attestations, secret-suppressed
semantic owner diff, and external owner metadata. It never deletes a PVC or
returns to an old release; it reapplies canonical values and waits for exact
vector and Ferret workloads. Once vector data exists, deletion/storage rollback
is forbidden until an approved logical backup, restore target, parity and P13
tenant-isolation proof exist.

## Persona verification and cleanup

Disposable verification must cover P18 install/upgrade/uninstall, P3 recovery,
P4/P10 metadata-only evidence, P8 document/vector round trips, P9 continuity and
maintenance visibility, P12 scoped secret/data use, P17 following this page
without source archaeology, and P13 direct-ID/cross-tenant negative probes. P13
must fail closed without foreign data, Secret values, or existence metadata.

Uninstall/cleanup removes only Falcone-owned disposable resources. It must leave
the independent ESO release Ready with the same owner annotations and specs.
Never clean shared staging as part of a disposable rehearsal. Independent review
and clean-install/upgrade verification are release gates after this maker change;
static rendering is not live proof.

## Compatibility and provenance

The supported repair anchor is chart 0.4.1 revision 20, including the admitted
failed 0.4.8/r22, 0.4.9/r23 and admitted 0.4.11/r24 chain, to chart 0.4.19,
`appVersion` 0.3.1. Chart 0.4.2 already supplied externally managed ESO packaging
but not the reviewer, FerretDB, storage, or image repair. Exact package/OCI digest
must be recorded after the merged source commit is built; source rendering alone
cannot predict that published digest. Production, HA, OpenShift, and other source
revisions do not inherit local-path and require their own proven storage choice.
Relative to immutable 0.4.18, 0.4.19 changes no values/schema, ServiceAccount or
RBAC, image, probe, network policy, storage, credential, application API, or
tenant/workspace contract. Source/package checks for this uncommitted maker diff
were run on 2026-08-13; record the final reviewed commit and published OCI digest
here before release or environment authorization.
