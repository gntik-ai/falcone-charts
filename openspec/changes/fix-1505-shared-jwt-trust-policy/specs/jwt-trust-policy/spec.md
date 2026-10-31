# JWT deployment trust policy

## Shared application configuration

Both application Deployments MUST reference the same keys in the existing
`executor-jwt-config` ConfigMap for issuer, JWKS URL, exact trusted realm bases,
platform realm/audiences, and tenant audience settings. Both MUST roll when that
effective configuration changes, including on historical stored-value upgrades.
No appended TLS JWT literal may override those references independently.

## Platform console audience

Fresh provisioning and existing realms MUST receive an `oidc-audience-mapper`
on `in-falcone-console` adding the configured API audience to access tokens.
Reconciliation MUST run with a matching one-shot marker, preserve unrelated
mappers and verify persisted settings before success. Failed API writes or
readback drift MUST fail without logging tokens or provider response bodies.

## Rollout compatibility

The explicit platform audience list initially includes `in-falcone` and `account`
under the time box documented in design.md. Strict deployments MAY remove
`account`. Tenant audience enforcement MUST retain its existing configured
audience. Empty explicit policy lists MUST fail closed.
