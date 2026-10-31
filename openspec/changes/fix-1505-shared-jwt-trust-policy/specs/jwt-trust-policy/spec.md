# JWT deployment trust policy

## ADDED Requirements

### Requirement: Shared application configuration

Both application Deployments MUST reference the same keys in the existing
`executor-jwt-config` ConfigMap for issuer, JWKS URL, exact trusted realm bases,
platform realm/audiences, and tenant audience settings. Both MUST roll when that
effective configuration changes, including on historical stored-value upgrades.
No appended TLS JWT literal may override those references independently.

#### Scenario: Existing release upgrades

- GIVEN a release whose stored values predate the shared trust policy
- WHEN the current chart renders an upgrade using those values
- THEN both application Deployments reference the same complete verifier configuration
- AND both application checksums track that configuration while preserving TLS endpoints.

#### Scenario: Existing control-plane literal env transition

- GIVEN a control-plane Deployment with literal issuer/JWKS env or duplicate
  TLS JWKS entries
- WHEN both JWT consumers are paused and the migration selects control-plane
- THEN a resource-version-fenced atomic patch installs all nine shared references
- AND unrelated fields remain unchanged and repeated application is a no-op.

#### Scenario: Effective TLS trust base

- GIVEN TLS overrides configure the platform JWKS URL on HTTPS port 8443
- WHEN the chart renders the shared policy
- THEN its internal trusted realm base uses that effective HTTPS endpoint
- AND the pre-override HTTP port-8080 base is not implicitly trusted.

### Requirement: Platform console audience

Fresh provisioning and existing realms MUST receive an `oidc-audience-mapper`
on `in-falcone-console` adding the configured API audience to access tokens.
Reconciliation MUST run with a matching one-shot marker, preserve unrelated
mappers and verify persisted settings before success. Failed API writes or
readback drift MUST fail without logging tokens or provider response bodies.

#### Scenario: Existing console client reconciliation

- GIVEN an existing console client and a matching one-shot bootstrap marker
- WHEN its named audience mapper is missing or differs from the desired configuration
- THEN bootstrap creates or updates only that mapper and verifies readback
  before success.

#### Scenario: Failed mapper convergence

- GIVEN a mapper write fails or its persisted configuration differs from the
  desired payload
- WHEN bootstrap reconciles the client
- THEN bootstrap fails without writing a success marker or logging provider
  response bodies.

### Requirement: Rollout compatibility

The explicit platform audience list initially includes `in-falcone` and `account`
under the time box documented in design.md. Strict deployments MAY remove
`account`. Tenant audience enforcement MUST retain its existing configured
audience. Empty explicit policy lists MUST fail closed.

#### Scenario: Strict configuration after rollout

- GIVEN the configured platform audience list contains only `in-falcone`
- WHEN the chart renders either application Deployment
- THEN both verifiers receive that exact list from the shared ConfigMap.
