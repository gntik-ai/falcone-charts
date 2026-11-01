# Implementation and validation

## Deployment repository

- [x] Verify the assigned clean worktree, branch and immutable base `557d118a`.
- [x] Read the supplied implement-issue execution contract and bounded OpenSpec
  acceptance criteria.
- [x] Reproduce the Keycloak 26 default-key failure at the rendered-bootstrap
  seam before changing chart source.
- [x] Compare desired fields and configuration keys while ignoring provider
  extras.
- [x] Validate response shape, cardinality and ids on both reads, including
  no-write paths.
- [x] Complete bounded stage diagnostics and desired-key mismatch regressions.
- [x] Extend both fakes with Keycloak 26 default keys and converged no-write
  behavior.
- [x] Refresh the byte-identical rendered reconciliation fixture; explicitly
  confirm the payload hash remains unchanged at
  `ac1f9d1b1aea25cac73dcabc5ff854e07c235fb8420a86453dcc55f3ffadac99`.
- [x] Pass the rendered full-bootstrap regression file, JWT policy snapshots,
  flow-audit render goldens, strict chart lint and rendered shell syntax.
- [x] Attempt Keycloak 26 login-import and reuse-values contract 048; record
  sandbox limits below.
- [x] Attempt full charts discovery and the repository's scoped CI chart
  command; preserve the completed results and environment limits.
- [x] Validate this OpenSpec, lint its Markdown, check whitespace and commit
  only the bounded deployment changes locally.

## Validation limits and CI handoff

The rendered full-bootstrap regression file passes with malformed responses,
transport failures, unsafe ids, strict desired string values, targeted writes,
zero-write reruns, cleanup and marker assertions. No new values keys or image
changes are introduced. The rendered reconciliation fixture and shell syntax
were checked through Helm's published ConfigMap surface.

`node --test tests` is unsupported as a directory entry by this sandbox's
Node 22 runtime (`MODULE_NOT_FOUND`). Full discovery was attempted separately
and stopped after confirmed subprocess stdin stalls prevented a complete
verdict. The unchanged External Secrets adoption suite reproduces that limit:
its shell syntax subprocess returns null after its existing 30-second bound.
The same stdin limitation affected an ad hoc shell syntax check; checking the
rendered program from a file succeeds.

The Keycloak 26 contract's render checks run, but process-isolated runtime
checks cannot create bubblewrap namespaces. Reuse-values contract 048 reaches
historical archive extraction after Git ownership is configured, then tar
fails with `Function not implemented`. The pinned `yaml` 2.8.3 dependency was
reused locally from the companion worktree. Local Helm is v4.2.3; PR CI must
repeat with its pinned toolchain. No test gate is removed or bypassed.

- [ ] PR CI completes the full charts suite, process-isolated Keycloak 26
  login-import checks and reuse-values contract 048 without sandbox limits.
- [ ] PR CI and release gates complete network, container and image checks.

## Delivery owner and operator

- [ ] Reconcile R1/R3 before merge and obtain human approval and both providers
  if R3 applies.
- [ ] Verify desired configuration booleans remain strings in real Keycloak 26
  responses.
- [ ] After publication, verify the `falcone-staging` bootstrap Job completes
  and Argo CD sync succeeds.
- [ ] Verify exactly one console `in-falcone-audience` mapper carries the
  platform audience on staging.
