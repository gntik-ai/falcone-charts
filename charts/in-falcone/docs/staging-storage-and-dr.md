# Staging pgvector storage and disaster-recovery boundary

Audience: P18 release engineers, P3 operators, P4 auditors, P9 workspace
operators, and P17 responders. Chart 0.4.12 selects `local-path` only in
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
forward-reapply chart 0.4.12 on failure. Do not return to revision 20: its absent
`hcloud-volumes` contract cannot recreate service. Do not delete a data-bearing
claim to retry provisioning. Future production/HCloud CSI work needs
an explicit component owner, cloud credential custody, pinned provisioner,
snapshots, topology, restore rehearsal, monitoring, migration, and rollback plan.
