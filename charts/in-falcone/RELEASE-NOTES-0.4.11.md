# in-falcone 0.4.11

Chart 0.4.11 supersedes the active staging recovery target without overwriting
the published 0.4.10 artifact. Chart 0.4.10 fixed the APISIX and Prometheus
numeric image identities but was not applied. Before its preflight, an
authorized `kubectl-patch` partially recovered APISIX and mounted the existing
`falcone-apisix-standalone` ConfigMap while observability retained the exact
named-user failure.

This release:

- admits only that exact partial revision-23 precursor, including Helm history,
  immutable storage, the Deployment UID/generation → ReplicaSet UID/revision →
  Pod UID owner chain, APISIX replicas/mount/runtime UID/GID,
  Prometheus failure, ConfigMap SHA-256 and global error cardinality;
- declares APISIX pod UID/GID 636:636 and the standalone ConfigMap mount in the
  staging profile, while retaining the container-level non-root identity;
- does not create, adopt, read as a Secret, or mutate the external ConfigMap;
- retains the six first-party image digests from Falcone main
  `d9cd0f6b56a4f8241e39d5336f3a7505afcdb9cc`;
- keeps the OpenShift overlay free of fixed UID/GID values;
- preserves the fail-forward two-pass Phase-A path, package-bound attestations,
  no `--reuse-values`, no `--atomic`, no rollback and no PVC deletion.
- validates the exact APISIX 636:636 render before mutation and revalidates live
  APISIX 636:636 plus Prometheus 65534:65534 after each upgrade, stopping before
  the second pass if convergence drifts.
- parses the unique rendered APISIX Deployment locally with Python 3/PyYAML;
  render validation never invokes a Kubernetes create/apply verb.

Any precursor drift fails before render or mutation. Phase B remains a separate
JIT-confirmed operation.
