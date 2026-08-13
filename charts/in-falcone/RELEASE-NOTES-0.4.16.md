# in-falcone 0.4.16

Chart 0.4.16 supersedes the immutable 0.4.15 recovery package. Chart 0.4.15 was
published but was not applied: its revision-24 pre-mutation gate admitted the
observed stale `Ready=True` ExternalSecret window but rejected the stable live
state in which all fourteen canonical ExternalSecrets reported the same
provider failure. Helm therefore remains at failed revision 24/chart 0.4.11;
the retained 0.4.14 auth Job remains partial-attempt evidence only.

## Exact homogeneous ExternalSecret precursor

Only after `ClusterSecretStore/openbao-backend` matches the existing exact
desired-store self-token-policy fingerprint—UID, labels, Helm owner, provider
spec, reconcile annotation, single `ValidationFailed` condition and literal
OpenBao HTTPS lookup-self 403—revision-24 recovery accepts exactly one of two
homogeneous sets for the fourteen canonical, unique staging ExternalSecrets:

1. every ExternalSecret has exactly one condition whose type is `Ready` and
   status is `True`; or
2. every ExternalSecret has exactly one condition equal to type `Ready`, status
   `False`, reason `SecretSyncedError`, and message
   `could not get secret data from provider`.

The gate rejects mixed states; missing, additional or duplicate identities;
namespace drift; absent or extra conditions; and reason/message drift before
any mutation. ExternalSecret UIDs are deliberately not fixed or read as
authorization evidence.

Both accepted sets follow the same fail-forward sequence: do not patch the
already-desired store, create a fresh auth-reconcile Job from the digest-verified
0.4.16 package, wait for the exact returned Job reference, then wait for the
store and all fourteen ExternalSecrets before continuing the two Phase-A Helm
upgrades. The Job retains the 0.4.15 least-privilege platform self-token policy
repair; no Secret values are read and external ESO ownership is unchanged.

## Immutable target and history

Fresh backup/parity attestations and the one-use confirmation must bind the
published 0.4.16 OCI digest. Recovery rejects 0.4.15 as a target before mutation.
Do not rewrite or apply the published 0.4.15 package. Chart 0.4.14 remains the
partial auth-Job attempt, and failed Helm revision 24/chart 0.4.11 remains the
exact live precursor. Storage/PVC, r20/r22/r23/r24, JIT Phase-B, two-pass
Phase-A, fail-forward and no-rollback boundaries are unchanged.
