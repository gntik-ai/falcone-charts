# in-falcone 0.4.17

Chart 0.4.17 supersedes the immutable 0.4.16 recovery package. The authorized
0.4.16 apply created a fresh auth Job, but a previously successful dedicated
login remained the effective credential, so the recovery-only platform policy
write never ran. The Job failed and Helm remained at failed revision 24/chart
0.4.11. No storage, PVC, ESO ownership, Secret payload, application image, or
tenant authorization contract changes in this release.

## Explicit forced-root recovery mode

`openbao.openbao.authReconcile.forceRecoveryRoot` is a boolean whose canonical
default is `false`. It is valid only with `allowRecoveryRoot=true`; rendering
fails if force is enabled without that explicit recovery authorization.

The isolated revision-24 recovery Job sets both values to `true`. In that form it
does not attempt the dedicated Kubernetes login. It loads the mounted recovery
root token directly, emits only
`auth_source=recovery_root result=accepted`, writes the exact platform policy,
and only then reconciles auth metadata, the no-default ESO role, and the canary.
The token is never printed. The package guard verifies the forced-root marker,
the recovery mount, and policy-before-terminal ordering before creating the Job;
the CLI accepts exactly one forced-root source marker plus one existing terminal
success line.

Routine reconciliation remains unchanged: `forceRecoveryRoot=false` and
`allowRecoveryRoot=false`, dedicated login only, no recovery Secret mount and no
policy write. The permitted `allow=true, force=false` compatibility form retains
dedicated-first behavior with recovery-root fallback only after login failure.

## Exact retained failure chain

Under the existing exact Store lookup-self 403 and homogeneous fourteen-ES
precursor, preflight now requires two exact anchor Jobs with prefix
`openbao-auth-reconcile-r24-`:

- the 0.4.14 partial Job `openbao-auth-reconcile-r24-859e037a14be-7v86n` with
  UID `352c1698-ac65-4af2-a25a-00bd183e9a11`, its exact package digest, target,
  source revision and Helm hook annotations; and
- the 0.4.16 failed forced-root-missing Job
  `openbao-auth-reconcile-r24-10828ffdf9f1-f65tk` with UID
  `979dac0c-507c-4b19-9f07-2c5e98a66acc` and its own exact provenance.

Both must have `failed=1` and exactly two uniquely typed conditions:
`FailureTarget=True/BackoffLimitExceeded` and
`Failed=True/BackoffLimitExceeded`, in either order. Condition messages are not
part of the authorization fingerprint.
Resource versions and timestamps are not fixed. Additional prefix-matching Jobs
are admitted only when every one is a prior 0.4.17 attempt with the current
package digest and target, an exact generated-name prefix and valid suffix, a
unique UUID UID, the exact six provenance/hook annotations, `failed=1`, and the
same exact two-condition failure state. Names and UIDs must be unique across the
whole history. Missing anchors or any differently named, owned, annotated or
failed Job stops before mutation. Recovery never waits on, reads logs from,
deletes, reapplies or reuses a retained Job; every retry creates a fresh
digest-bound 0.4.17 identity.

## Release and rollback boundary

Fresh backup/parity evidence and the exact one-use confirmation must bind the
published 0.4.17 OCI digest. The 0.4.16 target is rejected before mutation.
Chart 0.4.16 remains published and attempted, 0.4.15 remains published but not
applied, 0.4.14 remains the partial Job, and live Helm remains r24/0.4.11. The
repair remains fail-forward; none is a rollback target. Existing ESO custody,
Secret silence, storage/PVC, r20/r22/r23/r24, two-pass Phase-A and separately
confirmed Phase-B JIT gates remain unchanged.
