# Staging infrastructure repair (chart 0.4.4)

Verified source baseline: `gntik-ai/falcone-charts` commit
`e05f9e8cea4c4cc80573bc7ef0693fb42d47cd07`, 2026-08-09. Upgrade anchor:
Helm release `falcone`, revision 20, chart 0.4.1, Kubernetes context `default`,
namespace `in-falcone-staging`. This page is for P18 release engineers, P3 SREs,
P4/P10 read-only auditors, and P17 documentation-only responders. P8/P9/P12
data journeys and the P13 adjacent-tenant negative journey are post-recovery
acceptance gates.

## Status, outcome, and exclusions

Chart 0.4.4 carries the 0.4.3 repair and repins the six first-party images to
Falcone main `61540248` without changing public APIs or Falcone product source.
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

Never put a ServiceAccount JWT, OpenBao token, unseal material, Secret value,
tenant payload, kubeconfig, or backup content in values, arguments, logs, diffs,
evidence, or tickets. The runbook inspects metadata and conditions only.

## Canonical staging configuration

Use `values/staging.yaml`; do not reproduce these settings with imperative
Deployment patches. The profile selects externally managed ESO using exact
namespace and ServiceAccount identity, keeps Falcone auth in `eso-system`, pins
pgvector to `local-path` plus `topology.kubernetes.io/region=fsn1`, and records
these immutable digests:

| Workload/runtime | Approved digest |
|---|---|
| control-plane | `sha256:adead18f61c601b016b46af29bcb8d3959bb7956cde4f37775fff6abf6278253` |
| control-plane-executor | `sha256:91c5e8dbc66cf2a10a4c7545d2822624f165f9d39fa3847e5645ed394ef4aa6c` |
| web-console | `sha256:9c540d1c12f3adf9efbb80a08a314b1dd2b3a3e1443784125a020b9345026191` |
| workflow-worker | `sha256:fd98a3683aa3457bfda00ea05f1563cd398b951fad22af4f2b7e6b27b038087d` |
| function runtime | `sha256:3329ffdd4a4f97f5dd6818f256507789495fc21d4f0d2a7fdfdf3148a4d15613` |
| MCP runtime | `sha256:03f1eeaf932a3c87d581e596645f27f3a5d3da04df4b59341bd23fe32e9abfcb` |

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
`maxSurge: 1`.

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
   `platform,functions,gateway,iam`, and TTL 86400 seconds.
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

## Revision-20 upgrade: dry run and Phase A

Do not make shared staging the first target. Rehearse revision 20, injected
reviewer/RBAC/network/Ferret/readiness failures, retry, Phase B, and forward
recovery in a disposable environment first. Record only references to an
approved backup and secret-safe evidence.

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
  revision 20, chart 0.4.1, target repair chart 0.4.4, published package digest,
  a non-secret backup reference, `verified: true`, `observedAt`, and
  `validUntil`;
- `Revision20ParityEvidence` binds the same target and package digest to a
  distinct parity run and names the exact backup reference it verified.

Opaque strings are not apply evidence. Expired, malformed, reused, differently
targeted, or package-mismatched attestations fail before mutation.
For a real apply the tool pulls chart 0.4.4 from
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
  --confirm-target 'default/in-falcone-staging/falcone@20/in-falcone-0.4.1->in-falcone-0.4.4/sha256:PUBLISHED_PACKAGE_DIGEST'
```

Phase A uses the retained recovery credential for one bounded auth repair when
revision 20's expired reviewer mode prevents dedicated reconciler login, then
immediately applies an idempotent revision with the recovery-root allowance
disabled. Both passes compare exact ESO owner metadata captured immediately
before them. After the no-root pass it repeats the owner/image/store/auth/
FerretDB/EndpointSlice gates and requires auth `result=unchanged`, the exact
fourteen unique named ExternalSecrets Ready, FerretDB 2/2, and at least two
Ready endpoints. Phase A does not delete or change the PVC.

Create a fresh `StagingPhaseAAttestation` from that final metadata-only result.
It binds the original 20/0.4.1 source, the actual current revision, chart 0.4.4,
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
  --confirm-target 'default/in-falcone-staging/falcone@CURRENT_REVISION/in-falcone-0.4.4/sha256:PUBLISHED_PACKAGE_DIGEST' \
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

Before Phase A, revision 20 is untouched. Every mutation path is forward-only:
the tools do not use atomic upgrade or any rollback operation. A failed apply
prints `FORWARD_RECOVERY_REQUIRED`; inspect metadata, correct the cause, and
reapply the same package. Revision 20 reintroduces owner overlap, static reviewer
expiry, Ferret init failure, and old image defaults.

After PVC deletion, revision 20 cannot restore service because `hcloud-volumes`
does not exist. Use the dry-run-first forward recovery tool:

```bash
charts/in-falcone/migrations/revision-20-forward-recovery.sh \
  --backup-attestation /secure/path/revision20-backup.json \
  --parity-attestation /secure/path/revision20-parity.json \
  --phase-a-attestation /secure/path/phase-a.json
```

After review, its apply requires the actual
`default/in-falcone-staging/falcone@CURRENT_REVISION/in-falcone-0.4.4/sha256:PUBLISHED_PACKAGE_DIGEST`
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

The supported repair anchor is chart 0.4.1 revision 20 to chart 0.4.4,
`appVersion` 0.3.1. Chart 0.4.2 already supplied externally managed ESO packaging
but not the reviewer, FerretDB, storage, or image repair. Exact package/OCI digest
must be recorded after the merged source commit is built; source rendering alone
cannot predict that published digest. Production, HA, OpenShift, and other source
revisions do not inherit local-path and require their own proven storage choice.
