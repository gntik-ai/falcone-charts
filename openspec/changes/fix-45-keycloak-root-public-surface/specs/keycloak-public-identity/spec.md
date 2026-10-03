## ADDED Requirements

### Requirement: Public identity SHALL match root-path Keycloak

The default chart and dev, sandbox, staging and prod profiles SHALL expose only `/realms`, `/resources` and `/js` on `iam.<domain>`, using Ingress `pathType: Prefix` or one OpenShift Route per path, backed by the Keycloak service's `http` port. The flows e2e overlay SHALL explicitly set these same paths while Keycloak continues serving at root. Chart values and rendered manifests SHALL contain no legacy `/auth/realms` URL or unused Keycloak inline public path.

#### Scenario: Default and environment profile identity routing

- **WHEN** the chart is rendered with defaults or any supported environment profile
- **THEN** the identity Ingress has exactly the Prefix paths `/realms`, `/resources` and `/js` with the Keycloak `http` backend
- **AND** selecting Route exposure renders one identity Route per path with the same backend
- **AND** neither Ingress Prefix semantics nor Route string-prefix semantics match `/`, `/admin` or `/admin/x`
- **AND** discovery under `/realms/in-falcone-platform/.well-known/openid-configuration`, `/resources/x` and `/js/keycloak.js` reach Keycloak

#### Scenario: APISIX forwards Keycloak root paths

- **WHEN** bootstrap or standalone APISIX routes are rendered
- **THEN** identity route 1002 matches `/realms/*` and forwards that path unchanged to Keycloak
- **AND** the native-admin passthrough rewrites `/_native/keycloak/admin/(.*)` to `/admin/$1`, retaining its authorization plugins
- **AND** no route upstreamed to Keycloak matches or rewrites a legacy `/auth` prefix

### Requirement: Public OIDC and internal JWKS SHALL remain consistent

Runtime `oidcIssuerUrl` and `oidcDiscoveryUrl`, gateway policy and bootstrap plugin discovery SHALL use `https://iam.<domain>/realms/in-falcone-platform` and its `.well-known/openid-configuration` URL. The verifier's issuer base SHALL be `https://iam.<domain>` while its internal JWKS base remains the existing root-path Keycloak service URL. Keycloak container args/env and image references SHALL remain unchanged from base `cdc7bfb`; removing the unused ConfigMap `envFrom` reference is the sole accepted pod-template rollout change, and existing fail-closed issuer suffix validation and External Secrets/OpenBao gates SHALL remain intact.

#### Scenario: Rendered runtime and bootstrap agree

- **WHEN** a supported profile is rendered
- **THEN** the runtime issuer/discovery, bootstrap discovery and verifier issuer base match that profile's public identity host without a legacy prefix
- **AND** internal JWKS continues to use the root service URL without configuring a Keycloak relative path

#### Scenario: A legacy prefix is reintroduced

- **WHEN** an override reintroduces `/auth` in an identity binding, issuer, discovery URL, verifier issuer base, or Keycloak upstream route match or rewrite while Keycloak serves at root
- **THEN** the render consistency test fails and identifies the inconsistent surface

#### Scenario: Public discovery is verified after deployment

- **WHEN** the human/control-plane verifies the deployed release
- **THEN** public discovery returns HTTP 200 JSON whose issuer equals the gateway's configured OIDC issuer
- **AND** internal APISIX bearer-token validation still succeeds

### Requirement: Multi-path bindings SHALL preserve compatibility and fail closed

Bindings SHALL accept optional nonempty unique `paths` lists, replacing scalar `path` when set. The schema SHALL require `path` unless `paths` is present. Bindings without `paths` SHALL render byte-identically to base. Multi-path Route names SHALL be deterministic, unique and DNS-1123 valid; any single-path binding SHALL retain its existing Route name. The standalone APISIX file SHALL remain byte-identical to the paired source copy, and this extension SHALL NOT change APISIX routes or image references.

#### Scenario: Optional paths replace the scalar binding

- **WHEN** a binding supplies `paths`, with or without `path`
- **THEN** each listed path is rendered and the scalar path is ignored
- **AND** reordering paths does not change the Route name associated with a path
- **AND** a single-path list uses the same Route name as its equivalent scalar binding

#### Scenario: Unsafe identity overrides are rejected

- **WHEN** identity or another Keycloak-backed public binding exposes `/`, `/admin`, a path under `/admin`, or any `/auth` prefix (including case variants), or contains a `.` or `..` path segment, repeated slashes or percent encoding, via scalar `path` or effective `paths`
- **THEN** Helm rendering fails with a diagnostic identifying `publicSurface.bindings.identity` or the offending Keycloak-backed binding
- **AND** all migration, External Secrets/OpenBao and supply-chain gates remain intact

#### Scenario: Historical reuse-values upgrades require an explicit identity migration

- **WHEN** the Temporal historical upgrade contract reuses the unchanged stored chart at `41922e9d`
- **THEN** its stale identity binding fails before post-render with a `publicSurface.bindings.identity` diagnostic
- **AND** explicitly setting the identity `paths` allowlist renders only `/realms`, `/resources` and `/js` with Keycloak's `http` backend
- **AND** the existing Temporal default-image, custom-image drift, executor verification and read-only API assertions remain intact

#### Scenario: LoadBalancer cannot filter HTTP paths

- **WHEN** LoadBalancer exposure is selected
- **THEN** NOTES warns that the complete Keycloak HTTP port, including `/admin`, is exposed
- **AND** this change does not claim L4 path filtering
