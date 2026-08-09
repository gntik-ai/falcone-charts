# Migration: Revision 20 to chart 0.4.7

## Preconditions and evidence

- Exact context `default`, namespace `in-falcone-staging`, release `falcone`,
  revision `20`, and starting chart `in-falcone-0.4.1`.
- A published chart 0.4.7 package digest, not a source-only estimate. Chart
  0.4.5 remains the historical artifact blocked by nested dependency-version
  parsing. Chart 0.4.6 remains the historical artifact whose live apply reached
  Helm's existing-object ownership gate. Neither artifact is overwritten or
  used as the active repair target.
- Separate, fresh `Revision20BackupEvidence` and `Revision20ParityEvidence`
  documents. Both bind the exact source target and repair package; parity names
  the exact backup reference it verified. Their observation windows must still
  be valid when apply begins.
- Apply pulls the published 0.4.7 OCI artifact, verifies the registry-reported
  digest against the attestations, and uses the staging profile extracted from
  that same artifact; a local checkout is not the production apply source.
- Secret-suppressed semantic diff shows no create/update/removal among the
  sanitized 21 external ESO owner objects and rendered workloads contain all six
  approved digests. Neither tool reads a release manifest or Secret data.
- Procedure already passed in a disposable revision-20 installation; shared
  staging is not the first upgrade/failure/recovery test.

## Phase A

Run `revision-20-repair.sh --phase-a` first; it is read-only by default. Apply
requires both structured evidence files and an exact confirmation containing
20, source chart 0.4.1, target chart 0.4.7 and package digest. It retains the
immutable hcloud-volumes claim contract, applies repairs, verifies exact owner
metadata/images/store/fourteen unique Ready ExternalSecrets/auth/FerretDB/
endpoints, disables recovery-root, and repeats the complete gate. The final auth
result must be unchanged with the canary passed.

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
metadata, and reapplies chart 0.4.7. It never deletes storage. Once data exists,
claim deletion is forbidden until a separately approved backup/restore and P13
parity proof.
