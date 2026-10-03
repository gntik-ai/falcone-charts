## ADDED Requirements

### Requirement: Public identity SHALL match root-path Keycloak

The default chart and dev, sandbox, staging and prod profiles SHALL expose `iam.<domain>` at path `/`, using Ingress `pathType: Prefix` or an OpenShift Route, backed by the Keycloak service's `http` port. The flows e2e binding SHALL use the same root path. Chart values and rendered manifests SHALL contain no legacy `/auth/realms` URL or unused Keycloak inline public path.

#### Scenario: Default and environment profile identity routing

- **WHEN** the chart is rendered with defaults or any supported environment profile
- **THEN** the identity Ingress has path `/`, pathType `Prefix` and the Keycloak `http` backend
- **AND** selecting Route exposure renders the identity Route with path `/` and the same backend

### Requirement: Public OIDC and internal JWKS SHALL remain consistent

Runtime `oidcIssuerUrl` and `oidcDiscoveryUrl`, gateway policy and bootstrap plugin discovery SHALL use `https://iam.<domain>/realms/in-falcone-platform` and its `.well-known/openid-configuration` URL. The verifier's issuer base SHALL be `https://iam.<domain>` while its internal JWKS base remains the existing root-path Keycloak service URL. Keycloak container args/env and image references SHALL remain unchanged, and existing fail-closed issuer suffix validation and External Secrets/OpenBao gates SHALL remain intact.

#### Scenario: Rendered runtime and bootstrap agree

- **WHEN** a supported profile is rendered
- **THEN** the runtime issuer/discovery, bootstrap discovery and verifier issuer base match that profile's public identity host without a legacy prefix
- **AND** internal JWKS continues to use the root service URL without configuring a Keycloak relative path

#### Scenario: A legacy prefix is reintroduced

- **WHEN** an override reintroduces `/auth` in an identity binding, issuer, discovery URL or verifier issuer base while Keycloak serves at root
- **THEN** the render consistency test fails and identifies the inconsistent surface

#### Scenario: Public discovery is verified after deployment

- **WHEN** the human/control-plane verifies the deployed release
- **THEN** public discovery returns HTTP 200 JSON whose issuer equals the gateway's configured OIDC issuer
- **AND** internal APISIX bearer-token validation still succeeds
