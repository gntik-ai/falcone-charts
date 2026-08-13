# Migration: Revision 20/r24 to chart 0.4.18

Before mutation, repair validates the non-secret legacy C-25 webhook custody
contract stored in Helm revision 20 and passes explicit legacy overrides to
every render and upgrade. A failed pre-hook is resumable only for the known
`CREDENTIAL_MANAGED_SECRET_MISSING` revision whose deployed source is revision
20, the exact revision-22/chart-0.4.8 immutable-storage failure, or the exact
revision-23/chart-0.4.9 canceled upgrade whose live rollouts prove both
non-numeric image-user failures, or the exact revision-24/chart-0.4.11
global-wait timeout described below. Arbitrary failed Helm revisions are rejected.

## Preconditions and evidence

- Exact context `default`, namespace `in-falcone-staging`, release `falcone`,
  revision `20`, and starting chart `in-falcone-0.4.1`.
- A published chart 0.4.18 package digest, not a source-only estimate. Chart
  0.4.5 remains the historical artifact blocked by nested dependency-version
  parsing. Chart 0.4.6 remains the historical artifact whose live apply reached
  Helm's existing-object ownership gate. Neither artifact is overwritten or
  used as the active repair target. Chart 0.4.8 remains the immutable historical
  artifact that proved the non-secret r20 storage values also need explicit
  preservation. Chart 0.4.9 remains the immutable historical artifact whose
  revision-23 rollout proved that named image users require numeric Kubernetes
  identities. Chart 0.4.10 remains the published, unapplied artifact that fixes
  those identities but predates the exact partial manual-recovery precursor;
  it is never overwritten or accepted as the current target. Chart 0.4.11
  remains the immutable historical artifact whose first apply exposed global
  wait and the legacy store hook. Chart 0.4.12 remains the immutable failed
  recovery baseline: its CAS handoff reached `eso-system/eso-openbao-auth` before
  `eso-role` authorized that identity, producing `namespace not authorized`; its
  official recovery-root auth Job then normalized the role but rejected its own
  canary with `AUTH_CANARY_METADATA_INVALID` because the role allowed OpenBao's
  `default` policy while lookup required exactly four policies.
  Chart 0.4.13 remains immutable, published, and unapplied: Helm packaging
  extracted its repair delegate without executable mode, so the forward wrapper's
  direct execution returned 126, and its isolated r24 auth render lacked
  `--is-upgrade`, so upgrade-only validation failed before mutation.
  Chart 0.4.14 remains immutable and published as the partial recovery attempt:
  its Job normalized the no-default role while Helm stayed at failed revision
  24/chart 0.4.11, then the desired store exposed the exact platform-policy
  `lookup-self` 403 described below.
  Chart 0.4.15 remains immutable, published, and unapplied: it carried the
  least-privilege self-token policy repair but rejected the exact homogeneous
  provider-error ExternalSecret set before mutation.
  Chart 0.4.16 remains immutable, published, and attempted: its fresh Job used
  a successful dedicated login, skipped the root-only platform write, and
  failed while Helm remained r24/0.4.11.
  Chart 0.4.17 remains immutable, published, and attempted: its forced-root Job
  mounted policy ConfigMaps from live 0.4.11, so its successful policy writes
  did not contain the package self-token paths and lookup-self remained 403.
- Separate, fresh `Revision20BackupEvidence` and `Revision20ParityEvidence`
  documents. Both bind the exact source target and repair package; parity names
  the exact backup reference it verified. Their observation windows must still
  be valid when apply begins.
- Apply pulls the published 0.4.18 OCI artifact, verifies the registry-reported
  digest against the attestations, and uses the staging profile extracted from
  that same artifact; a local checkout is not the production apply source.
- Secret-suppressed semantic diff shows no create/update/removal among the
  sanitized 21 external ESO owner objects and rendered workloads contain all six
  digests from Falcone main `d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc`.
  Neither tool reads a release manifest or Secret data.
- Procedure already passed in a disposable revision-20 installation; shared
  staging is not the first upgrade/failure/recovery test.

## Phase A

Run `revision-20-repair.sh --phase-a` first; it is read-only by default. Apply
requires both structured evidence files and an exact confirmation containing
20, source chart 0.4.1, target chart 0.4.18 and package digest. It retains the
immutable hcloud-volumes claim contract, applies repairs, verifies exact owner
metadata/images/store/fourteen unique Ready ExternalSecrets/auth/FerretDB/
endpoints, disables recovery-root, and repeats the complete gate. The final auth
result must be unchanged with the canary passed, and token lookup must expose
exactly `functions,gateway,iam,platform` without `default`.
The early confirmation check requires the exact live revision/chart to point to
`in-falcone-0.4.18` and a 64-hex SHA-256 digest before loading attestations. A
0.4.17 target fails `JIT_TARGET_CONFIRMATION_REQUIRED` before mutation.

Preflight also requires exactly the fourteen Falcone `ExternalSecret`
declarations and compares their canonical live/rendered specs without reading
generated Secret payloads. Apply validates all declarations before mutation and
adopts only an all-absent Helm owner tuple through an atomic metadata patch with
UID and resourceVersion tests. Exact already-owned retries are skipped;
partial/foreign ownership or any identity/spec/concurrency drift fails closed.
The external ESO owner's twenty-one objects are never adoption candidates.

Record those final metadata-only results as a short-lived
`StagingPhaseAAttestation`: exact source, actual result revision/chart/package,
recovery-root false, auth unchanged/canary passed, store and fourteen-secret
health, FerretDB 2/2 and endpoints, plus owner and image-set digests.

For revision 23, Phase A first proves the complete immutable public anchor:
revision 20 is deployed chart 0.4.1 with `Upgrade complete`; revision 22 is the
exact failed chart-0.4.8 six-resource immutable-storage event; and revision 23
is failed chart 0.4.9 with exactly `Upgrade "falcone" failed: context canceled`.
It then verifies intact storage plus the APISIX and observability Deployment and
Pod evidence: each new ReplicaSet has exactly one Pending
`CreateContainerConfigError` with the complete non-numeric `apisix`/`nobody`
message, while three APISIX and one observability Pods from prior ReplicaSets
remain Ready. Exact images, labels, owner kinds, generations, replica counts and
availability are part of the gate. Drift fails before rendering or mutation.

The alternate admitted precursor keeps the same exact Helm history and storage,
but requires APISIX generation 7 at exactly 3/3 Ready, one revision-7 ReplicaSet
owned by the exact Deployment name/UID, all three Pods owned by that exact
ReplicaSet name/UID and reporting UID/GID 636 with no restarts, the exact standalone
mount, and the existing ConfigMap with only `apisix.yaml` at SHA-256
`28aa61f223b1306a9604817f44abf6c8c1c867e6ba9020bc9ff85235dd2c555b`.
Prometheus must still expose the exact one-Ready/one-Pending `nobody` failure,
and no other namespace may contain a named-user `CreateContainerConfigError`.
The staging profile turns the observed APISIX identity and mount into Helm
desired state without creating or adopting that ConfigMap.
Before mutation the rendered APISIX Deployment must contain pod and container
UID/GID 636:636. After each upgrade, the live health gate requires that APISIX
identity and Prometheus container UID/GID 65534:65534; drift stops the sequence
before the next pass and requires forward recovery.

Revision-23 forward recovery delegates directly to this Phase-A procedure. The
apply confirmation binds `23`, source chart 0.4.9, target chart 0.4.18 and the
published package digest. Fresh backup and parity attestations must also target
0.4.18. Because revision 23 is itself a failed Phase-A attempt, no successful
Phase-A attestation is invented or required. The procedure still performs the
same two non-atomic Helm upgrades, never rolls back and never deletes a PVC.

Revision 24 is admitted only with the exact r20/r22/r23 predecessors and its
chart-0.4.11 timeout fingerprint: the unbound vector PVC, vector StatefulSet
0/1, legacy store, all fourteen provider failures and deadline exceeded. Live
evidence must prove the same PVC UID with no volume/PV, every non-vector rollout
healthy, numeric APISIX/Prometheus convergence and zero named-user failures.
Besides the legacy hook form and an already-Ready idempotent retry, the evidence
gate admits only the 0.4.14 partial attempt: exact desired spec, labels, Helm
owner and UID; no hooks; exact
`in-falcone.io/reconcile-request=phase-a-0.4.12-auth-updated`; one
`Ready=False`, `ValidationFailed` condition with the literal OpenBao FQDN
`GET /v1/auth/token/lookup-self`, code 403 and permission-denied message; and all
fourteen canonical, unique staging ExternalSecrets in one homogeneous state.
Each must have exactly one condition: either every object is Ready=True, or
every object is exactly Ready=False/SecretSyncedError with message
`could not get secret data from provider`. Mixtures, extra/missing conditions,
condition drift, names, namespaces, duplicates or cardinality drift fail before
mutation. ExternalSecret UIDs are not hardcoded. Store resourceVersion is
required but captured dynamically. No other live or history drift is accepted.

After all read-only and package-bound gates but before mutating the store, any
ExternalSecret owner metadata, or Helm, exact r24 apply renders and executes the
official auth-reconcile Job from the digest-verified 0.4.18 package with
`allowRecoveryRoot=true`, `forceRecoveryRoot=true`, and
`spec.activeDeadlineSeconds=300`, `restartPolicy=Never` and `backoffLimit=0`.
The forced form skips dedicated login, loads the mounted recovery token without
printing it and emits the exact root-source marker. It mounts no canonical
policy ConfigMap: the package embeds platform and auth-reconcile HCL from the
same helpers as their canonical ConfigMaps, writes those bytes into private
`emptyDir` snapshots, verifies their rendered SHA-256 values, then writes both
policies before changing/validating roles and the canary. Platform contains only
the existing KV paths plus `lookup-self` read and `revoke-self` update;
`PLATFORM_POLICY_BOOTSTRAP_FAILED` is stable and credential-silent. The dedicated
identity gains no policy-write, mount, Secret, or KV authority. After validating
that official object, each attempt changes only its metadata: it removes
`metadata.name`, sets `metadata.generateName` to
`openbao-auth-reconcile-r24-<digest12>-` using the first twelve lowercase package
digest hex characters, and adds
`in-falcone.io/recovery-package-digest=<full sha256 digest>`,
`in-falcone.io/recovery-target-chart=in-falcone-0.4.18`, and
`in-falcone.io/recovery-source-revision=24`. Namespace, annotations already in
the official object, labels, spec and pod template do not change.

The CLI runs `kubectl create -f <attempt> -o name` and accepts exactly one newly
returned ref matching
`^job\.batch/openbao-auth-reconcile-r24-<digest12>-[a-z0-9]([-a-z0-9]*[a-z0-9])?$`,
with a DNS-valid generated name. It passes that exact ref, without reconstructing
or rediscovering it, to the five-minute `Complete` wait and the subsequent log
read. It accepts exactly one `auth_source=recovery_root result=accepted` marker
plus exactly one terminal line: either
`result=changed code=AUTH_METADATA_CONVERGED canary=passed` or
`result=unchanged code=AUTH_METADATA_MATCHED canary=passed`. The converged
`eso-role` uses `token_no_default_policy=true`; canary lookup exposes exactly
`functions,gateway,iam,platform`. The CLI never reads a Secret resource or
payload, and Job/CLI output contains no credential. Creation, completion,
metadata, canary, or terminal-log drift stops before every later mutation. A
deadline/completion failure retains the failed Job in `secret-store` for evidence
and emits `REVISION24_AUTH_RECONCILE_INCOMPLETE` plus
`FORWARD_RECOVERY_REQUIRED`; create failure uses
`REVISION24_AUTH_RECONCILE_CREATE_FAILED`, invalid create output uses
`REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT`, and render, log-read and log-content
failures use their corresponding stable `REVISION24_AUTH_RECONCILE_*` codes. All
failed attempts are retained; the successful attempt is retained at least until
r24 recovery completes. A retry repeats the whole live/package preflight and
creates a new generated Job identity. It never deletes, reuses or reapplies a
prior identity, and no stale Job or stale log can satisfy the current attempt.
That includes the exact retained 0.4.14 Job
`openbao-auth-reconcile-r24-859e037a14be-7v86n` and 0.4.16 Job
`openbao-auth-reconcile-r24-10828ffdf9f1-f65tk`, plus 0.4.17 Job
`openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw`. Before create, the public Job
list must contain those three prefix-matching anchors with their exact
UIDs, package/target/source and hook annotations, failed count, and exactly two
uniquely typed `FailureTarget` and `Failed` conditions, both
`True/BackoffLimitExceeded`, in either order. Resource versions and timestamps
remain dynamic. Additional prefix Jobs are admitted only as prior attempts for
the current 0.4.18 package digest/target, with an exact digest-prefixed generated name,
valid suffix, unique UUID UID, exact provenance/hooks, failed count and the same
two-condition state. Names and UIDs are unique across the history; any other
drift fails before mutation.

The distributed forward-recovery entrypoint invokes its package-local repair
delegate through `bash`, independent of archive executable mode. The isolated
auth Job render passes `--is-upgrade` before `--show-only`, so it evaluates the
same upgrade-only chart contract as the later Helm upgrades. Both checks occur
before the first mutating command.

Only after that auth-first proof may apply hand off the exact legacy store to the
unique rendered spec with its UID/resourceVersion-guarded patch, or recognize an
exact already-desired retry/partial precursor. It never patches that desired
precursor. It waits separately with `--timeout=10m` for the
store and for `gateway-apisix-credentials`, `gateway-shared-secret`,
`iam-identity-client`, `iam-keycloak-credentials`, `iam-superadmin`,
`platform-documentdb-credentials`, `platform-documentdb-replication`,
`platform-encryption-key`, `platform-ferretdb-credentials`,
`platform-kafka-credentials`, `platform-postgresql-credentials`,
`platform-postgresql-vector-credentials`, `platform-s3-credentials`, and
`platform-temporal-credentials` to be Ready before ExternalSecret owner adoption
or Helm. The administrator-owned ESO controller's network/egress path to OpenBao
is an external prerequisite: readiness failure stops before Helm and Falcone
neither creates nor adopts the `external-secrets` namespace, controller, or
network policy.

Both Phase-A Helm upgrades omit global `--wait` and use `--timeout 20m`. After
each upgrade, the CLI runs `rollout status --timeout=10m` separately for every
managed Deployment, every non-vector managed StatefulSet and OpenBao; it never
waits for the intentionally Pending vector StatefulSet. The following health
gate uses `--timeout=10m` separately for FerretDB `Available` and the store
`Ready`. A first-pass or final health-gate failure emits respectively
`PHASE_A_HEALTH_GATE_FAILED` or `FINAL_HEALTH_GATE_FAILED`, followed by
`FORWARD_RECOVERY_REQUIRED`, and stops before the next pass or success without
rollback. The first pass retains the explicit recovery-root allowance; the
second pass sets it false and must finish with auth unchanged plus canary passed.
Phase B retains `--wait` after the separately confirmed empty PVC is deleted and
recreated.

## Phase B

Run `--phase-b` dry-run in a separate maintenance window. Apply requires all
three attestations, package-bound confirmation of the actual Phase-A revision,
exact PVC UID, and a separate exact PVC name/UID confirmation. Before scale the
only permitted claim reference is the exact Pending vector StatefulSet Pod. The
tool scales only that StatefulSet to zero, performs a bounded termination wait,
then rereads PVC UID/phase/volume, every PV claimRef, Pod reference and successful
Pod evidence. It revalidates live revision/chart and external owner metadata
immediately before deleting only the exact still-empty claim. Any drift cancels
the confirmation.

## Recovery

All mutation paths are fail-forward. There is no atomic apply or rollback path.
A failed mutation prints `FORWARD_RECOVERY_REQUIRED`. The recovery tool defaults
to read-only, revalidates the three structured attestations, actual current
revision/chart/package confirmation, semantic external-owner diff and exact owner
metadata, and reapplies chart 0.4.18. It never deletes storage. Charts 0.4.11
through 0.4.17 are not rollback
targets; Helm rollback,
`--atomic`, and restoration to revision 20 remain forbidden. Once data exists,
claim deletion is forbidden until a separately approved backup/restore and P13
parity proof. Release notes and operator recovery/storage procedures must identify
0.4.18, package-bound policy snapshots, the forced-root auth-first gate, exact
credential-silent retained log proof, external ESO
network prerequisite, two-pass wait behavior, and this forward-only boundary.
