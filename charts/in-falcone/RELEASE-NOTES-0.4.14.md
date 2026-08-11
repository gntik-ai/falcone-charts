# in-falcone 0.4.14

Chart 0.4.14 supersedes the immutable published-but-unapplied 0.4.13 package as
the fail-forward staging recovery target for the exact failed
revision-24/chart-0.4.11 anchor. It corrects two package execution defects found
before any 0.4.13 cluster mutation. It does not alter the admitted Helm history,
OpenBao/ESO policy model, storage evidence, image digests, product API, or the
separately confirmed Phase-B PVC safety boundary.

## Packaged recovery entrypoint

Helm archives preserve the recovery scripts as regular package files and an
extracted `migrations/revision-20-repair.sh` may have mode 0644. The 0.4.13
forward wrapper used direct `exec` for the r22/r23/r24 delegation, so the public
package could terminate with exit 126 before its repair preflight ran.

The 0.4.14 forward wrapper now uses `exec bash <package-local-repair-script>` and
passes the same validated phase, apply, evidence, backup reference, and target
confirmation arguments unchanged. Recovery correctness therefore no longer
depends on an executable bit in the extracted archive. The wrapper remains
forward-only and does not add a rollback, storage deletion, or cluster bypass.

## Revision-24 auth preflight render

The revision-24 auth-first gate renders only the official package-bound
`openbao-auth-reconcile` Job before any `kubectl create`, ClusterSecretStore
handoff, ExternalSecret-owner change, or Helm upgrade. In 0.4.13 that isolated
`helm template --show-only` command omitted `--is-upgrade`; the chart's existing
upgrade-only validation correctly rejected the render with
`REVISION24_AUTH_RECONCILE_RENDER_FAILED` before mutation.

Chart 0.4.14 passes `--is-upgrade` to that isolated render. It preserves the exact
staging values, target namespace/version, `allowRecoveryRoot=true` override,
300-second Job deadline, package-digest-derived generated identity and provenance
annotations. The validation is not weakened or bypassed: the preflight now
evaluates the same upgrade context as the two later Phase-A Helm upgrades.

All existing r24 safety gates remain in force:

- fresh backup/parity evidence and one-use target confirmation must bind the
  registry-reported 0.4.14 package digest;
- only the fresh ref returned by `kubectl create -o name` may satisfy the
  five-minute completion wait and credential-silent terminal log proof;
- failed attempts remain retained and retries create a new Job identity;
- the UID/resourceVersion-guarded store handoff and fourteen individual
  ExternalSecret Ready waits precede Helm;
- both Phase-A passes keep recovery-root disabled, omit global wait, and retain
  explicit non-vector rollout and health checks;
- Phase B remains a separate destructive window requiring fresh Phase-A evidence
  and immediate exact PVC name/UID confirmation.

## Upgrade and rollback boundary

Do not apply 0.4.13 and do not rewrite or delete its published artifact. Generate
new evidence and confirmations for the published 0.4.14 OCI digest, then follow
`docs/staging-infrastructure-repair.md`. The live precursor remains failed
revision 24 on chart 0.4.11. Charts 0.4.11, 0.4.12, and 0.4.13 are not rollback
targets; recovery remains fail-forward to 0.4.14. No Kubernetes Secret payload is
read or emitted by either corrected path.
