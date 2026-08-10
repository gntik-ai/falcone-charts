# Tasks

- [x] Establish the window from the rendered manifest rather than from the report: five
  `pre-upgrade` Jobs sort after the quiesce at `-35`, including both hooks observed
  failing on staging.
- [x] Confirm the restore semantics in `webhook-key-lifecycle-cli.mjs` — `restore()` is
  reachable only from the CLI's `catch`, and the success path returns
  `workloadAction=apply-target`, leaving replicas at 0 for Helm's main apply.
- [x] Add `tests/webhook-key-lifecycle-hook-order.test.mjs` and verify it fails against
  the unfixed template, naming `eso-preflight` and `falcone-temporal-schema`.
- [x] Move the four lifecycle hook resources to `3`/`5`, preserving their relative order
  and their position after the credential and database prerequisites.
- [x] Update the `-35` literal pinned in `tests/webhook-signing-key-chart.test.mjs`.
- [x] Wire the new suite into `tests/webhook-database-chart-ci.test.sh`; full chart CI
  green (`C25_CHART_CI_PASS helm_lint_profiles=4 kubeconform_matrices=12`).
- [x] Bump the chart to `0.4.11` and write its release notes.
- [ ] Human review before merge — chart hook ordering on a shared cluster.
- [ ] Operator decision: the first upgrade carrying this change is also the one that
  recovers `in-falcone-staging` from revision 23 `failed`. Not performed here.
