# Fix console audience mapper convergence on Keycloak 26

## Why

Issue #1511 reports repeated bootstrap failure on Keycloak 26.1.0 because
audience reconciliation compares the entire stored configuration with the
desired payload. Provider-added default keys prevent exact equality. Generic
diagnostics also obscure failed stages, malformed responses and unsafe mapper
ids.

## What Changes

Reconcile only `in-falcone-audience`, comparing required fields and every
desired string configuration value before writes and on readback. Ignore extra
provider configuration and metadata. Validate exactly one JSON array, mapper
cardinality and ids, and emit fixed bounded diagnostics with cleanup on failure.
Preserve curl style, token handling, desired payload, image references and every
existing safety gate.

Extend the existing fake Keycloak boundaries and tests at the rendered-bootstrap
seam. Keep the rendered reconciliation fixture byte-identical; update the
bootstrap hash explicitly only if it changes. No new values keys are introduced.

## Evidence and scope

The assigned clean worktree began at `557d118a88ff1eff79387c9bfdc9fea315c6e03d`,
branch `agent/falcone/1511/884b5786-7b50-5f54-992f-9b3087b38559`. Before
changing chart source, `node tests/platform-console-audience-chart.test.mjs`
failed the new Keycloak 26 stored-defaults regression with the original generic
convergence diagnostic. The missing-mapper control passed. Adding provider keys
alone caused the failure; filtering to desired keys fixed it without changing
values.

Only the chart reconciliation function and failure helper, their fixtures, tests
and this OpenSpec change are in scope. Source trust policy, console, verifiers,
other bootstrap steps and resource pruning are excluded. The companion source
repository owns its matching OpenSpec documentation.

## Delivery boundaries

The control plane assigns R1; the issue identifies an R3 authentication concern.
The delivery owner must reconcile the classification before merge and obtain
human approval and both providers if R3 applies. This maker does not grant
approval, merge, push, deploy or inspect credentials.

After publication, the operator verifies the staging bootstrap Job, Argo CD sync
and console audience mapper. Real Keycloak string representations remain an
operator verification item; comparison stays strict. Rollback is a chart revert,
though the previous code reintroduces the Keycloak 26 convergence failure.
