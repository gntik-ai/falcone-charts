# Deployment policy and upgrade design

## One configuration

`in-falcone.issuerJwksAuth` supplies the public issuer base, configured internal
JWKS base, platform realm, existing audience and tenant audience enforcement.
The shared ConfigMap adds exact `/realms/` bases, a JSON platform audience list,
the platform realm and the tenant-realm switch expected by the source policy.
Both workloads receive one `configMapKeyRef` per verifier setting. Historical
component env literals and appended TLS duplicates are replaced by those
references; TLS endpoint overrides are resolved once in the ConfigMap.

The legacy `controlPlane.keycloakIssuer` value no longer selects a separate
policy. Configure `gatewayPolicy.issuerJwksAuth` instead. Both application
checksums cover the effective ConfigMap data. APISIX continues to consume its
existing verifier settings. No image tags, digests or source workflow pins change.

## Audience rollout decision

Match the source OpenSpec decision: explicitly accept `in-falcone` and `account`
for platform tokens during rollout. `azp` is never an audience. This compatibility
entry admits other `account` tokens from the same trusted platform realm; source
role and workspace authorization remains mandatory. Tenant audience enforcement
retains the existing configured data-API audience and applies to both verifiers.

Remove `account` from `gatewayPolicy.issuerJwksAuth.platformAudiences` after mapper
reconciliation and existing access-token refresh/expiry, no later than
2026-11-14. Strict configuration is `platformAudiences: [in-falcone]`. The deadline
requires an operator configuration rollout; it is not an automatic timer.

## Existing releases and realms

Absent new values receive safe defaults under `helm upgrade --reuse-values`.
Explicit empty or malformed audience lists and non-boolean tenant-realm switches
fail closed. The executor env migration recognizes all nine shared keys and
replaces retained literals atomically using its existing resource-version guard.

The console client receives an `oidc-audience-mapper` adding the configured API
audience to access tokens. Stored client values acquire it at render time too.
Every bootstrap reconciliation checks the existing console client and creates or
updates only the named mapper, then verifies readback before the success marker.
This runs even when the one-shot marker matches. Unrelated client mappers remain
untouched. Failures emit bounded diagnostics without provider bodies or tokens.

## Validation and release follow-up

Public seams are rendered Deployments/ConfigMaps, the distributed bootstrap shell
program with offline Keycloak command boundaries, and the existing env migration.
Regression tests cover profile parity, exact bases, strict configuration, TLS,
mapper reconciliation and failure handling. Run the existing historical
reuse-values test and chart lint. PR CI owns live cluster/upgrade checks; an
operator verifies superadmin and tenant-owner flow/MCP lists after publication.
Independent review assesses the temporary audience policy before release.
