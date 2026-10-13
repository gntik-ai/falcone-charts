# Tasks

- [x] Review the existing route implementation at the assigned worktree HEAD.
- [x] Confirm rendered default, staging and production routes use the dedicated
  family, GET/OPTIONS, the exact change-stream URI constraint, identity-header
  blanking, executor upstream, per-key 429 limits and long SSE timeouts.
- [x] Confirm stored pre-change route values render without the new family policy.
- [x] Confirm capture-management routes retain OIDC and request validation.
- [x] Run the paired source Mongo gateway parity suite with this chart path.
- [x] Add the deployment proposal, tasks and gateway spec delta.
- [x] Repair the flow-audit and managed-Knative historical render checks by
  validating and subtracting only the exact reviewed realtime route and policy
  delta. Retain both approved hashes and all existing assertions.
- [x] Reproduce the reported flow-audit hash mismatch before the repair, then
  pass the matching CI command, realtime route suite, managed-Knative baseline
  check and strict chart lint. Missing header blanking and URI constraints still
  fail the reviewed route fingerprint.
- [ ] PR CI: rerun `bbx-temporal-bootstrap-048`, the real reuse-values upgrade
  test. With the existing tooling YAML package linked, the sandbox attempt stops
  at historical archive extraction: `tar` reports `Function not implemented`.
- [x] Rerun the paired source gateway-policy validator using a temporary sibling
  chart layout and the existing tooling YAML package.
- [x] Reproduce the executor-env-upgrade TLS gateway comparison failure. Validate
  only the exact reviewed family policy and enabled-route URI delta before
  comparing the remaining gateway configuration with the immutable baseline.
  The offline upgrade suite passes; the live matrix requires PR CI's kind cluster.
- [ ] Hermes: converge the paired source workflow chart pins to the final charts
  commit, then rerun Mongo gateway parity in PR CI.
- [ ] Release verification: confirm access-log query-key redaction and paired
  executor authorization before staging exposure; verify positive streams,
  401/403 responses, CORS preflight, rejected methods and event isolation.
