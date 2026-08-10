# in-falcone 0.4.10

## Numeric image identities and revision-23 recovery

Vanilla Kubernetes values now retain `runAsNonRoot: true` while assigning the
numeric image identities required by the named-user APISIX and Prometheus
images: UID/GID 636 for `docker.io/apache/apisix:3.10.0-debian` and UID/GID
65534 for the existing Prometheus v3.2.1 digest. The OpenShift restricted
overlay continues to remove fixed UID/GID values so its SCC can assign an
arbitrary namespace-range identity.

Revision-20 repair and forward-recovery tooling now targets chart 0.4.10. It
admits revision 23 only when public Helm history proves the exact deployed
revision-20, failed revision-22 and canceled revision-23 chain, public storage
metadata is unchanged, and the APISIX and observability rollouts expose exactly
the two expected non-numeric-user `CreateContainerConfigError` failures while
their previous replicas remain available. Drift fails before mutation. An
admitted revision-23 recovery reuses the two-pass Phase-A path without
fabricating a Phase-A attestation, rollback, atomic upgrade or PVC deletion.

The published 0.4.9 package remains the immutable historical source of the
revision-23 failure. Staging also advances all six first-party image digests to
Falcone main `d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc`, tag
`0.6.6-main-d9cd0f6b`, from successful `release-images` run `31337244501`.
Base, production, HA and OpenShift image defaults are unchanged.
