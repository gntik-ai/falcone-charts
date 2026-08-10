# Design

## The window, exactly

Helm sorts hooks of one event by `helm.sh/hook-weight` ascending. Rendering the chart on
upgrade with legacy adoption gives this `pre-upgrade` sequence (Jobs only):

| weight | Job | |
|---|---|---|
| -45 | `webhook-key-credential` | provisions the key Secret the quiesce mounts |
| -43 | `webhook-db-credential` | provisions the lifecycle database credentials |
| -40 | `webhook-db-authority-r1` | |
| **-35** | **`webhook-key-lifecycle`** | **scales `falcone-control-plane` to 0** |
| -30 | `credential-bootstrap` | |
| -19 | `eso-preflight` | observed failure, 2026-08-09 |
| -1 | `temporal-db-bootstrap` | |
| 0 | `temporal-schema` | observed failure, 2026-08-09 |
| 0 | `openbao-tls-bootstrap` | |

Everything below the quiesce runs while the control plane is down, and Helm aborts the
release on the first failure among them — before the main apply that would restore
`spec.replicas`.

## Why ordering rather than a compensating hook

The issue suggested pairing the scale-down with `helm.sh/hook: post-upgrade,post-rollback`
and a `helm.sh/hook-failure-policy` counterpart. Neither exists in Helm's model:

- There is no `hook-failure-policy` annotation. `helm.sh/hook-delete-policy: hook-failed`
  governs deletion of the failed hook's own resources; it runs nothing.
- `post-upgrade` does not fire when a `pre-upgrade` hook fails. `execHook` returns the
  error as soon as a hook fails to reach ready, and the upgrade aborts before the
  `post-upgrade` phase is ever reached.

A compensating hook therefore cannot run on the abort path. What can be changed is where
in the sequence the window opens: with the quiesce last, no hook remains that can fail
inside it.

## Why moving it later is safe

The quiesce exists so that no control-plane replica mutates the webhook key ledger while
the lifecycle Job rewrites it. That property is a function of the Job's own body — quiesce,
then mutate — not of where the Job sits relative to unrelated hooks. Nothing between `-35`
and `0` reads or writes the webhook ledger; they bootstrap credentials, ESO, Temporal
schema, OpenBao TLS.

The stronger argument is empirical: the lifecycle template is gated on `$runLifecycle`, so
an upgrade with no adoption and no rotation action renders no quiesce at all. Those five
Jobs already run with the control plane up on every ordinary release. Moving the quiesce
behind them makes the lifecycle path match the path the platform takes on every other
upgrade. The final test in the suite pins that gate so the argument stays true.

Ordering within the lifecycle block is preserved by moving all four resources by the same
step (`-37` → `3`, `-35` → `5`), so the Job's ServiceAccount, Role and RoleBinding are
still created before it. That also avoids depending on when Helm applies
`hook-delete-policy: hook-succeeded` to non-Job hook resources.

## Residual, stated

Two paths still end with the control plane at 0, and both are outside this change:

1. The lifecycle Job failing with `WEBHOOK_KEY_STATE_AMBIGUOUS`. The CLI suppresses
   `restore()` there deliberately — a lost commit acknowledgement means the durable target
   may already own every row, and reviving a source-reference workload in that state is
   worse than staying down. An exact Helm retry reconciles it through the
   `alreadyQuiesced` replay path.
2. The main apply itself failing after the quiesce. `--atomic` rolls back, and the
   rollback's own apply restores `spec.replicas`.

Neither is the reported defect, and neither is fixable by ordering.
