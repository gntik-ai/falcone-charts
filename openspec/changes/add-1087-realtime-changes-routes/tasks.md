# Tasks

- [x] Review the existing route implementation at the assigned worktree HEAD.
- [x] Confirm rendered default, staging and production routes use the dedicated
  family, GET/OPTIONS, the exact change-stream URI constraint, identity-header
  blanking, executor upstream, per-key 429 limits and long SSE timeouts.
- [x] Confirm stored pre-change route values render without the new family policy.
- [x] Confirm capture-management routes retain OIDC and request validation.
- [x] Run the paired source Mongo gateway parity suite with this chart path.
- [x] Add the deployment proposal, tasks and gateway spec delta.
- [ ] PR CI: rerun `bbx-temporal-bootstrap-048`, the real reuse-values upgrade
  test. The sandbox attempt cannot load the missing Node `yaml` package.
- [ ] PR CI: rerun the paired source gateway-policy validator. The sandbox
  attempt cannot load the missing Node `yaml` package.
- [ ] Hermes: converge the paired source workflow chart pins to the final charts
  commit, then rerun Mongo gateway parity in PR CI.
- [ ] Release verification: confirm access-log query-key redaction and paired
  executor authorization before staging exposure; verify positive streams,
  401/403 responses, CORS preflight, rejected methods and event isolation.
