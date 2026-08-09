# Migration: Revision 20 to chart 0.4.3

## Preconditions

- Exact context `default`, namespace `in-falcone-staging`, release `falcone`,
  starting revision `20`, and a reviewed non-secret backup evidence reference.
- Secret-suppressed diff shows no operation against the external ESO owner and
  rendered workloads contain all six approved digests.
- Procedure already passed in a disposable revision-20 installation; shared
  staging is not the first upgrade/failure/recovery test.

## Phase A

Run `charts/in-falcone/migrations/revision-20-repair.sh --phase-a` first. It is
read-only by default. Applying requires `--apply`, backup reference, Helm diff
plugin, and `--confirm-target default/in-falcone-staging/falcone@20`. It retains
the existing hcloud-volumes claim contract, repairs ESO/OpenBao/Ferret/images,
verifies store/fourteen ExternalSecrets/Ferret readiness, and immediately disables
the one-release recovery-root allowance with an idempotent follow-up revision.

## Phase B

Run `--phase-b` dry-run. Supply the displayed immutable PVC UID. Applying also
requires the exact `--confirm-pvc falcone-postgresql-vector-data/UID`. The tool
rechecks Pending, empty volumeName, zero PV claimRefs, zero Pod references and no
successful vector Pod immediately after confirmation. It scales only the vector
StatefulSet, deletes only the exact claim, applies canonical staging values, and
waits for Bound/Ready. Any changed identity/state cancels confirmation.

## Recovery

Before Phase A, no rollback is needed. A Phase-A atomic rollback is allowed only
if preflight proves external owner and images remain safe. After Phase A, reapply
0.4.3. After Phase-B deletion, run the dry-run-first
`revision-20-forward-recovery.sh`; never blindly restore revision 20. Once data
exists, forbid claim deletion until approved backup/restore and P13 parity proof.
