# in-falcone 0.4.15

Chart 0.4.15 supersedes the immutable 0.4.14 recovery package after its
package-bound auth Job partially repaired revision 24 without advancing the live
Helm release beyond failed chart 0.4.11. The administrator-owned ESO controller
then exposed one missing OpenBao authorization: the desired
`ClusterSecretStore/openbao-backend` could authenticate but received an HTTPS
`GET /v1/auth/token/lookup-self` 403 because the `platform` policy did not grant
token self-service. No Secret payload, PVC, application image, product API, or
tenant authorization contract changes in this release.

## Exact platform token self-service policy

The rendered `openbao-policy-platform` ConfigMap adds only these capabilities:

```hcl
path "auth/token/lookup-self" {
  capabilities = ["read"]
}
path "auth/token/revoke-self" {
  capabilities = ["update"]
}
```

There is no wildcard, default policy, token creation/renewal/role access, or
additional capability. Fresh install already projects and writes the platform
policy before creating `eso-role`, so it receives the correction automatically.
The dedicated routine auth reconciler retains its existing metadata-only policy
and gains no policy-write, Secret, mount, or KV authority.

## Recovery-root policy repair before the no-default canary

The explicitly authorized recovery-root form of `openbao-auth-reconcile` mounts
`ConfigMap/openbao-policy-platform` read-only and writes that exact file before
changing or validating the no-default ESO role and before canary login. A write
failure emits `PLATFORM_POLICY_BOOTSTRAP_FAILED` without exposing credentials and
stops before store, ExternalSecret owner, or Helm mutation. Routine no-root
reconciliation neither mounts nor writes the policy.

## Exact 0.4.14 partial-recovery precursor

Revision-24 recovery retains all r20/r22/r23/r24, storage, workload, ESO custody,
two-pass Phase-A, and Phase-B JIT gates. In addition to the original legacy store
form, 0.4.15 admits only the observed 0.4.14 partial attempt:

- Helm remains failed revision 24/chart 0.4.11;
- `openbao-backend` has the exact UID, labels, Helm owner and desired
  `eso-system/eso-openbao-auth` provider spec;
- hook annotations are absent and
  `in-falcone.io/reconcile-request=phase-a-0.4.12-auth-updated` is exact;
- its single Ready condition is `False`, reason `ValidationFailed`, with the
  literal OpenBao FQDN `/v1/auth/token/lookup-self`, HTTP 403, permission-denied
  message;
- all fourteen canonical Falcone ExternalSecrets are uniquely Ready.

The resourceVersion is captured dynamically. Any URL, status code, reason,
message, spec, annotation, UID, cardinality, or ExternalSecret readiness drift
fails before mutation. Apply does not patch the already-desired store. It creates
a fresh digest-bound 0.4.15 auth Job, waits for that exact returned ref, then
waits for the store and all fourteen ExternalSecrets before continuing the two
non-global-wait Phase-A upgrades.

The retained failed 0.4.14 Job
`openbao-auth-reconcile-r24-859e037a14be-7v86n` is evidence only. Recovery never
waits on, logs, deletes, patches, reapplies, or accepts it as the current attempt;
each retry creates another 0.4.15 digest-prefixed identity.

## Upgrade and rollback boundary

Generate fresh backup/parity evidence and exact target confirmation for the
published 0.4.15 OCI digest. Do not rewrite 0.4.14 or use 0.4.11 through 0.4.14
as rollback targets. Recovery remains fail-forward. Phase B remains separately
destructive and still requires fresh Phase-A evidence plus immediate exact PVC
name/UID confirmation.
