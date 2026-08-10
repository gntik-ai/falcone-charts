# in-falcone 0.4.11

## The webhook key maintenance window can no longer strand the control plane

The `webhook-key-lifecycle` Job scales `falcone-control-plane` to 0 for its
maintenance window and, on success, leaves it there by design: it reports
`workloadAction=apply-target` and lets Helm's main upgrade apply restore
`controlPlane.replicas`. Its own restore path runs only when the Job itself fails.

At hook-weight `-35` five `pre-upgrade` Jobs sorted after it —
`credential-bootstrap`, `eso-preflight`, `temporal-db-bootstrap`, `temporal-schema`
and `openbao-tls-bootstrap`. Helm aborts the release on the first hook failure and
never reaches the main apply, and it has no failure hook and does not run
`post-upgrade` when a `pre-upgrade` hook fails, so any of those five turned its own
failure into an unbounded control-plane outage. `eso-preflight` and
`falcone-temporal-schema` each did so on `in-falcone-staging` during 0.3.1 → 0.4.1,
with `/healthz` still answering 200 from the gateway while every authenticated route
returned 502.

The four lifecycle hook resources now sort after every other `pre-upgrade` hook the
chart and its sub-charts render (RBAC `3`, Job `5`), keeping their relative order and
their position behind the credential and database prerequisites. No hook remains that
can fail inside the window.

This is ordering only. The lifecycle CLI is unchanged, the Job still holds
`deployments/scale` patch authority on the control plane alone, and the quiesce is
still rendered only when a release requests legacy adoption or a
`rotate`/`recover`/`finalize` action — on every ordinary upgrade those five Jobs
already ran with the control plane up.

`tests/webhook-key-lifecycle-hook-order.test.mjs` pins the invariant across all four
lifecycle actions, so a `pre-upgrade` hook added later at any weight fails CI by name
rather than quietly re-opening the window.

Fixes gntik-ai/falcone-charts#11. The alerting half of that issue — the platform
health surface reflecting a zero-replica control plane — is not included; the chart
ships no Prometheus rule groups, and it is tracked on `charts#19`.
