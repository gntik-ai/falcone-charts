# Change: Order the webhook key quiesce last among pre-upgrade hooks

## Why

The `webhook-key-lifecycle` Job scales `falcone-control-plane` to 0 for its
maintenance window and, on success, deliberately leaves it there: the CLI returns
`workloadAction=apply-target` and relies on Helm's main upgrade apply to restore
`.Values.controlPlane.replicas`. Its `restore()` closure runs only in the CLI's own
`catch`, so it covers the lifecycle Job failing and nothing else.

At hook-weight `-35` five pre-upgrade Jobs sorted after the quiesce —
`credential-bootstrap`, `eso-preflight`, `temporal-db-bootstrap`, `temporal-schema`
and `openbao-tls-bootstrap`. Helm has no failure hook and does not run `post-upgrade`
when a `pre-upgrade` hook fails, so any of those failing aborts the release before the
restoring apply and strands the control plane at 0 replicas with no recovery path.
`eso-preflight` and `falcone-temporal-schema` each did exactly this on
`in-falcone-staging` while upgrading 0.3.1 → 0.4.1: two unrelated root causes, one
shared outcome, every authenticated route 502 until an operator scaled the Deployment
back by hand. `/healthz` kept answering 200 from the gateway throughout.

This is a property of the hook ordering rather than of either failure, which is why
the fix is ordering and a rendered-manifest invariant rather than either root cause.

## What Changes

- Move the four `webhook-key-lifecycle` hook resources so the quiesce Job sorts after
  every other `pre-upgrade` hook the chart and its sub-charts render: RBAC `-37` → `3`,
  Job `-35` → `5`. Their relative order is unchanged, so the Job still finds its
  ServiceAccount and Role, and the credential and database prerequisites still precede it.
- Add `tests/webhook-key-lifecycle-hook-order.test.mjs`, which pins the invariant rather
  than the literal: across all four lifecycle actions, no `pre-upgrade` hook may sort at
  or after the quiesce. A hook added later at any weight fails the suite by name.
- Wire that suite into `tests/webhook-database-chart-ci.test.sh`.
- Ship chart `0.4.11` and its release notes.

## Impact

Affected source is limited to `charts/in-falcone/templates/webhook-key-lifecycle.yaml`,
`charts/in-falcone/Chart.yaml`, the release notes, two chart test files and this OpenSpec
package. No Falcone product API or source change occurs, and no CLI behaviour changes.

The quiesce renders only when a release requests key lifecycle work — legacy adoption, or
a `rotate`/`recover`/`finalize` rotation action. On every ordinary upgrade the five Jobs
now ahead of it already run with the control plane up, so this puts the lifecycle path on
the same footing as the path that has always been taken rather than creating a new one.

## Exclusions and gates

No cluster is contacted. No deploy, no `helm upgrade`, no merge. `in-falcone-staging` is
at revision 23 `failed`, so the first upgrade that carries this change is the one that
recovers it — that upgrade is an operator decision under
`charts/in-falcone/migrations/revision-20-forward-recovery.sh`, not part of this change.

Scenario 3 of the filed requirement — that the platform health surface reflect a
zero-replica control plane instead of `/healthz` answering 200 from the gateway — is
**not** covered here. The chart ships zero Prometheus rule groups, so an alert added now
would be evaluated by nothing; it belongs with `charts#19` and is recorded there rather
than silently satisfied.
