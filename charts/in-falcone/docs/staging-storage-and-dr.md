# Staging pgvector storage and disaster-recovery boundary

Audience: P18 release engineers, P3 operators, P4 auditors, P9 workspace
operators, and P17 responders. Chart 0.4.19 selects `local-path` only in
`values/staging.yaml` and restricts first placement to
`topology.kubernetes.io/region=fsn1`. Base, production, HA, and OpenShift values
remain operator-selected and do not inherit this setting.

The evidenced StorageClass uses `rancher.io/local-path`, WaitForFirstConsumer,
and `Delete` reclaim. The pgvector workload is one replica with a 10 Gi RWO
claim. This is bindable staging storage, not HA or node-independent durability.
Node loss/replacement, PVC deletion, or StorageClass reclaim can lose all data.
Alert before 80% use and keep application-level backups outside the node.

Revision 20's exact claim `falcone-postgresql-vector-data` is Pending, unbound,
and has no PV/data in the approved evidence. The expected StatefulSet may still
have one Pending Pod referencing that claim; this is not data evidence, but it
must be scaled to zero and observed terminated before the final evidence reread.
Deletion is still destructive and requires the JIT UID/state gate in
`migrations/revision-20-repair.sh`. If it ever becomes Bound, gains a
volumeName/PV claimRef, is referenced by any unexpected Pod, or has any data
evidence, the empty-claim shortcut is permanently invalid. Use a separately
approved backup/restore migration to a new PV, verify schema/row/vector-index
parity and P13 isolation, then cut over.

Phase B requires distinct, fresh, exact-target backup and parity attestations,
the fresh final Phase-A attestation, a current revision/chart/package-bound
confirmation, and a separate exact PVC name/UID confirmation. After Phase B,
forward-reapply chart 0.4.19 on failure. Do not return to revision 20: its absent
`hcloud-volumes` contract cannot recreate service. Do not delete a data-bearing
claim to retry provisioning. Future production/HCloud CSI work needs
an explicit component owner, cloud credential custody, pinned provisioner,
snapshots, topology, restore rehearsal, monitoring, migration, and rollback plan.

Revision-24 auth/store recovery is independent of the Phase-B PVC decision.
Each auth retry creates a new digest-bound generated Job and retains earlier
attempts as metadata-only evidence; it must not reuse or delete a stale Job to
make storage remediation appear ready. Store or ExternalSecret readiness
timeouts stop before Helm and never broaden the PVC deletion authorization.
The history fence requires the exact .14/.16/.17 failed anchors with six exact
provenance/hook annotations, and admits 0..N current .19 attempts only with seven
exact annotations and either the exact Failed terminal or the Kubernetes v1.36
Successful terminal. Every newly created attempt must independently log exactly
`auth_source=recovery_root result=accepted` plus one allowed terminal result;
even a retained current Successful attempt cannot satisfy or relax that proof.
Every admitted exact r24 retry crosses that history fence after Store and
fourteen-ExternalSecret precursor validation, including a retry whose Store is
already `Ready`/`complete` after a Successful Job and downstream failure. No
Store state admitted by the r24 path skips the fence or permits an earlier
create.
The 0.4.18 package failed its semantic guard before `kubectl create`; it produced
no Job, storage operation, Helm revision or Phase-B authority. A fresh 0.4.19
digest, evidence set and one-use JIT are mandatory. Pre-create 0.4.19 failure
records `authorization_consumed=true` and `mutation_started=false` without a
forward-recovery instruction. At and after the create attempt,
`mutation_started=true` makes recovery forward-only. Neither 0.4.18 nor any
chart from 0.4.11 through 0.4.17 is a storage rollback target.

Verification note: 0.4.19 changes no storage value, PVC contract, schema, RBAC,
image or topology relative to 0.4.18. The source/package verification date for
this maker diff is 2026-08-13; record the final reviewed source commit and
published OCI digest before authorizing Phase A or Phase B.
