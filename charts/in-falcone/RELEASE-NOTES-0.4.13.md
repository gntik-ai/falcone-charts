# in-falcone 0.4.13

Chart 0.4.13 supersedes 0.4.12 as the immutable fail-forward staging recovery
target for the exact failed revision-24/chart-0.4.11 anchor. It does not alter
the admitted Helm history, storage evidence, first-party image digests, public
API, or Phase-B PVC safety boundary.

## OpenBao and externally managed ESO recovery

- The revision-24 recovery CLI now renders and executes only the official
  package-bound `openbao-auth-reconcile` Job before changing the legacy
  `ClusterSecretStore`, any `ExternalSecret` owner metadata, or the Helm
  release.
- Every recovery attempt creates a fresh
  `openbao-auth-reconcile-r24-<digest12>-*` Job, annotated with the complete
  package digest, target chart and source revision. The CLI validates the single
  ref returned by `kubectl create -o name` and uses only that ref for its
  five-minute completion wait and log check. Failed attempts are retained;
  retries never reuse or delete stale Jobs.
- Recovery-root access is enabled only for that bounded pre-handoff Job. The CLI
  waits for `Complete` and accepts exactly one terminal result:
  `changed/AUTH_METADATA_CONVERGED/canary=passed` or
  `unchanged/AUTH_METADATA_MATCHED/canary=passed`.
- The durable ESO role now sets `token_no_default_policy=true`; role and canary
  lookup must expose exactly `functions,gateway,iam,platform`.
- Both Phase-A Helm upgrades keep recovery-root disabled, omit global `--wait`,
  and retain the explicit non-vector rollout and final health gates.
- The UID/resourceVersion-guarded store handoff remains idempotent. Each of the
  fourteen named Falcone `ExternalSecret` resources must become Ready before
  the first Helm upgrade.

The administrator-owned External Secrets Operator must already have network
reachability to OpenBao on TCP/8200. Falcone does not create, adopt, or mutate
the `external-secrets` namespace, its controller, or its NetworkPolicies. A
missing egress prerequisite fails closed before ExternalSecret ownership or
Helm mutation. Store and per-ExternalSecret Ready waits are individually capped
at ten minutes and any first timeout emits forward-recovery guidance without a
rollback.

## Safety and compatibility

Apply still requires fresh backup and parity attestations bound to the
registry-reported 0.4.13 package digest and the exact one-use confirmation. The
procedure never reads Kubernetes Secret payloads or prints credentials. Phase B
remains a separate destructive operation requiring a fresh final Phase-A
attestation and exact PVC name/UID confirmation. Rollback to revision 20 remains
unsupported; recovery is forward-only.
