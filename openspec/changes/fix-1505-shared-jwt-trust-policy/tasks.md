# Deployment tasks

- [x] Reproduce missing shared configuration with a failing public render test.
- [x] Feed both verifiers from the shared ConfigMap with matching checksums.
- [x] Extend the guarded executor env migration for the new settings.
- [x] Cover the control-plane literal/reference transition with an atomic
  component-selectable migration and historical CLI regression.
- [x] Derive the trusted internal realm base after TLS overrides and assert HTTPS
  prod-TLS rendering.
- [x] Document both paused consumers, public endpoint effects and tenant audience
  prerequisites in the release runbook.
- [x] Provision and reconcile the console audience mapper on existing realms.
- [x] Cover mapper failures and repeated reconciliation with offline API fixtures.
- [ ] Complete independent review and normal PR CI checks.
- [ ] Obtain R3 operator approval for the temporary account audience and public
  endpoint changes; confirm mapper coverage for existing tenant app and console
  clients.
- [ ] Verify superadmin and tenant-owner flow/MCP routes after normal publication.
- [ ] Release follow-up for falcone #1505: remove the temporary account audience
  by 2026-11-14 after mapper reconciliation and token refresh/expiry; render with
  platformAudiences restricted to in-falcone.
