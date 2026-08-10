# in-falcone 0.4.12

Chart 0.4.12 is the fail-forward staging recovery target after the first
authorized 0.4.11 Phase-A attempt became Helm revision 24. Kubernetes applied
the 0.4.11 resources, but Helm's global `--wait` could never complete while
the intentionally unbound `falcone-postgresql-vector-data` claim and its
StatefulSet remained Pending for the separately confirmed Phase B.

That wait also exposed an older hook-to-resource handoff gap. The live
`ClusterSecretStore/openbao-backend` still carried the revision-20 Helm hook
annotations and referenced `external-secrets/eso-openbao-auth`, although the
current chart and least-privilege RBAC use `eso-system/eso-openbao-auth`.
Consequently the store and all fourteen Falcone ExternalSecrets were NotReady.

This release:

- admits only the exact revision-24/chart-0.4.11 timeout fingerprint, its
  revision-20/revision-22/revision-23 predecessors, the unchanged empty vector
  PVC and the exact converged 0.4.11 workload state;
- validates the unique legacy store, desired local render, owner tuple, UID and
  resourceVersion before an exact JSON-patch handoff;
- removes only the two obsolete Helm hook annotations and replaces only the
  public store spec with the rendered `eso-system` identity; it never reads or
  writes Secret payloads and never mutates the administrator-owned ESO release;
- waits for the store and exact fourteen ExternalSecrets to become Ready before
  either Helm mutation;
- runs both Phase-A Helm upgrades without global `--wait`, then performs
  bounded explicit rollout checks for every managed Deployment and StatefulSet
  except the intentionally Pending pgvector StatefulSet;
- retains global Helm `--wait` for Phase B, after the separately confirmed
  empty PVC has been deleted and the replacement must become Bound and Ready;
- preserves forward-only recovery, two package-bound Phase-A passes, the six
  Falcone main image digests, APISIX 636:636, Prometheus 65534:65534, external
  ESO ownership and the OpenShift arbitrary-UID overlay.

Any history, store, owner, CAS, readiness, workload identity or PVC drift fails
closed. Revision 24 is never rolled back and Phase B still requires a fresh
Phase-A attestation plus separate exact PVC confirmation.
