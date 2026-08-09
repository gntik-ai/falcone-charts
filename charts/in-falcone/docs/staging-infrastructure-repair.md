# Staging infrastructure repair (chart 0.4.3)

Verified source baseline: `gntik-ai/falcone-charts` commit
`e05f9e8cea4c4cc80573bc7ef0693fb42d47cd07`, 2026-08-09. Upgrade anchor:
Helm release `falcone`, revision 20, chart 0.4.1, Kubernetes context `default`,
namespace `in-falcone-staging`. This page is for P18 release engineers, P3 SREs,
P4/P10 read-only auditors, and P17 documentation-only responders. P8/P9/P12
data journeys and the P13 adjacent-tenant negative journey are post-recovery
acceptance gates.

## Status, outcome, and exclusions

Chart 0.4.3 repairs four independent staging faults without changing public APIs
or Falcone product source. It consumes (but never adopts) an administrator-owned
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

- `external-secrets/external-secrets` and the metadata-only OpenBao canary may
  create a token only for `eso-system/eso-openbao-auth`;
- `secret-store/openbao` may create TokenReviews and receives no generic
  ServiceAccount, node, or Secret authority from that role;
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
| control-plane | `sha256:0c6aeff8f3c115c63b49164cdb6daf73c2b4636b4d1907e48c8b18484218861a` |
| control-plane-executor | `sha256:d19acae027d39e68ae4656e779ae8ce738a22a145092681d34d01201252ac28d` |
| web-console | `sha256:2cf611ee6e77e63b80c7aa988790191a668e52f08e2f907a335d1bb8eb83ff34` |
| workflow-worker | `sha256:2669be573ec5d461f8a1e21c58c13817fd1bc14a947dba845ce1cfac8368a054` |
| function runtime | `sha256:4fe7a77b01e7e49cd97722a3f55808ec4a09c0c0886680389011ba43796382ba` |
| MCP runtime | `sha256:ef4bf4a350388508f301f6ea4f39012b412b7bb625314e136812ba8cc53efb99` |

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
4. Verify `secret-store/openbao` can create TokenReviews and the exact ESO
   controller can request only the named auth ServiceAccount token.
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
  --phase-a \
  --backup-reference BACKUP-EVIDENCE-ID
```

Expected: it confirms context `default`, namespace `in-falcone-staging`, release
`falcone`, revision `20`; renders all six digests; retains the existing immutable
`hcloud-volumes` PVC contract for Phase A; and runs a secret-suppressed Helm diff.
The apply path refuses to run without the Helm diff plugin, backup reference,
and exact just-in-time target confirmation displayed by the dry run.

After authorized disposable proof and a separate environment approval, the
applying invocation is:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-a --apply \
  --backup-reference BACKUP-EVIDENCE-ID \
  --confirm-target default/in-falcone-staging/falcone@20
```

Phase A uses the retained recovery credential for one bounded auth repair when
revision 20's expired reviewer mode prevents `openbao-init-role` login, then
immediately applies an idempotent revision with the recovery-root allowance
disabled. It must end with the external owner unchanged, the store and fourteen
ExternalSecrets Ready, auth canary passed, and FerretDB available. Phase A does
not delete or change the PVC.

## Phase B: exact empty-PVC destructive gate

Phase B is a separate maintenance window. Its preflight rechecks exact context,
namespace, release, PVC name and immutable UID; requires phase `Pending`, empty
`spec.volumeName`, no PV claimRef, no Pod reference, and no successful vector Pod;
and renders `local-path`, 10 Gi, RWO and `fsn1`. Unbound plus no PV/Pod is the
metadata proof that no volume/data exists; if any evidence changes, stop and
design a real backup/restore migration.

Dry run:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-b \
  --backup-reference BACKUP-EVIDENCE-ID \
  --pvc-uid PVC-UID-FROM-PREFLIGHT
```

Only after reviewing that output may the human provide the exact one-use name
and UID confirmation:

```bash
charts/in-falcone/migrations/revision-20-repair.sh \
  --phase-b --apply \
  --backup-reference BACKUP-EVIDENCE-ID \
  --confirm-target default/in-falcone-staging/falcone@20 \
  --pvc-uid PVC-UID-FROM-PREFLIGHT \
  --confirm-pvc falcone-postgresql-vector-data/PVC-UID-FROM-PREFLIGHT
```

The script rereads UID/phase/volumeName after confirmation, scales only
`falcone-postgresql-vector`, deletes only the exact PVC, and immediately applies
the canonical local-path revision. A changed UID/state invalidates confirmation.
No wildcard, label-wide deletion, namespace deletion, or blind retry is allowed.

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

Before Phase A, revision 20 is untouched. During a failed Phase A, atomic rollback
is allowed only if a dry-run proves it will neither mutate external ESO objects
nor revert approved images. After Phase A succeeds, do not blindly roll back:
revision 20 reintroduces owner overlap, static reviewer expiry, Ferret init failure,
and old image defaults. Reapply the repaired chart.

After PVC deletion, revision 20 cannot restore service because `hcloud-volumes`
does not exist. Use the dry-run-first forward recovery tool:

```bash
charts/in-falcone/migrations/revision-20-forward-recovery.sh \
  --backup-reference BACKUP-EVIDENCE-ID
```

After review, its apply requires
`--confirm-target default/in-falcone-staging/falcone`. It never deletes a PVC or
uses `helm rollback`; it reapplies canonical values and waits for exact vector
and Ferret workloads. Once vector data exists, deletion/storage rollback is
forbidden until an approved logical backup, restore target, parity and P13
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

The supported repair anchor is chart 0.4.1 revision 20 to chart 0.4.3,
`appVersion` 0.3.1. Chart 0.4.2 already supplied externally managed ESO packaging
but not the reviewer, FerretDB, storage, or image repair. Exact package/OCI digest
must be recorded after the merged source commit is built; source rendering alone
cannot predict that published digest. Production, HA, OpenShift, and other source
revisions do not inherit local-path and require their own proven storage choice.
