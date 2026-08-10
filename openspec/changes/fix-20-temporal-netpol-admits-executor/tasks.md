# Tasks

- [x] Establish which component holds a Temporal client: only `apps/control-plane-executor`
  (five call sites). `apps/control-plane` has none — it reaches flows over HTTP.
- [x] Read the rendered pod-template component labels rather than trusting the issue:
  executor `control-plane-executor`, worker `flows-worker`, control plane none, `flows-api` absent
  from every artifact.
- [x] Find why it shipped: `tests/e2e/values-flows-e2e.yaml` stamped `flows-api` on the control
  plane, so the only suite exercising the path patched the label. Confirmed the stamp never made
  execution work, and that the e2e topology renders a real executor which was denied there too.
- [x] Add `tests/networkpolicy-selector-reality.test.mjs` and verify it fails against the unfixed
  values in **all five** profiles, naming policy, profile and selector.
- [x] Set `allowedComponents` to `[control-plane-executor, flows-worker]`; rewrite the
  label-contract comments that documented the contract that broke.
- [x] Remove the e2e pod-label workaround so that suite exercises the default policy.
- [x] Confirm the only unresolved selector left is `mcp-server`, verify it is genuinely runtime
  created and that `mcp-custom-hosting.mjs` pins the label on `spec.template.metadata.labels`
  (asserted by its own test), and record it as the single justified exemption.
- [x] Wire the suite into `tests/webhook-database-chart-ci.test.sh`. Chart CI green
  (`C25_CHART_CI_PASS helm_lint_profiles=4 kubeconform_matrices=12`);
  `revision23-numeric-user-forward-recovery-contract` 42/42; `legacy-custody-contract` 29/29.
- [x] No chart version bump — `0.4.11` is the pinned staging-recovery target.
- [ ] Human review before merge — NetworkPolicy is tenant-isolation surface (CLAUDE.md rule 7).
- [ ] Live verification is blocked until the staging forward recovery runs: `in-falcone-staging` is
  at revision 23 `failed`, so no chart fix is adopted yet. First honest proof is a flow execution
  returning something other than 503 after that recovery.
- [ ] Then close `gntik-ai/falcone#997` against that evidence, not against this merge.
