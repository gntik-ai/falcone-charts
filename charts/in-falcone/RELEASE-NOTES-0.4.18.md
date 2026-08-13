# in-falcone 0.4.18

Chart 0.4.18 supersedes the immutable but failed 0.4.17 recovery package. The
0.4.17 forced-root Job was correctly bound to the package digest and wrote both
requested policies, but its policy files came from same-name ConfigMaps in the
still-live 0.4.11 release. Consequently the issued ESO token still lacked the
new self-service policy paths and `lookup-self` returned 403. Helm remains at
failed revision 24/chart 0.4.11. This release changes no application image,
Secret payload, ESO ownership, storage/PVC or tenant authorization boundary.

## Package-bound policy snapshots

The platform and auth-reconcile HCL each have one Helm helper source. Fresh
install ConfigMaps and the isolated forced-recovery Job render those same exact
bytes. Only `allowRecoveryRoot=true,forceRecoveryRoot=true` embeds the policy
snapshots into its container script and materializes them in private `emptyDir`
volumes. It mounts neither `openbao-policy-platform` nor
`openbao-policy-auth-reconcile`, so an older or poisoned live ConfigMap cannot
influence recovery.

Before using recovery-root, the Job verifies each materialized file against the
SHA-256 rendered from the package. After the exact credential-silent
`auth_source=recovery_root result=accepted` marker, it writes platform then
auth-reconcile policy, reconciles the bootstrap/reconciler/ESO roles, and only
then performs canary login, lookup-self and revoke-self. The migration CLI
structurally validates the embedded bytes, hashes, emptyDir-only mounts and this
ordering before creating the Job.

Routine reconciliation remains dedicated-only: both recovery flags default to
false, no recovery Secret or snapshot volume is mounted, no package HCL is
embedded and no policy-write command exists. The dedicated identity receives no
new capability.

## Terminal diagnostic retention

The forced Job uses `restartPolicy: Never` and `backoffLimit: 0`. A terminal
failure therefore has one Pod/container attempt whose credential-silent log is
retained with the failed Job instead of being replaced by automatic container
or Pod retries. Operator retry repeats all live/package gates and creates a new
digest-bound Job; it never deletes, waits on, logs, patches or reuses a prior
attempt.

## Exact retained history and target

The exact r24 precursor requires these three immutable failed anchors:

- 0.4.14 `openbao-auth-reconcile-r24-859e037a14be-7v86n`;
- 0.4.16 `openbao-auth-reconcile-r24-10828ffdf9f1-f65tk`;
- 0.4.17 `openbao-auth-reconcile-r24-4cd761dd8b0a-qjnfw`, UID
  `c8fd1c27-f68b-4d33-b10f-3b832c741cd3`, digest
  `sha256:4cd761dd8b0a855cdae29a8f808382333918beb9ab7d0b485dffaaf81a677328`.

Each anchor must retain its exact name, UID, package/target/source and Helm hook
annotations, `failed=1`, and exactly `FailureTarget` plus `Failed`, both
`True/BackoffLimitExceeded`. ResourceVersion, timestamps, condition order and
messages remain dynamic. Zero or more additional 0.4.18 failures are admitted
only with the current digest/target, exact digest-derived generated-name prefix,
valid suffix, unique UUID UID and the same provenance/status fingerprint.

Fresh backup/parity attestations and the one-use confirmation must bind the
published 0.4.18 OCI digest. Target 0.4.17 is rejected before mutation. Charts
0.4.17, 0.4.16 and 0.4.14 remain failed evidence; 0.4.15 remains published but
unapplied; live Helm remains r24/0.4.11. Recovery remains fail-forward and none
of those packages is a rollback target.
