## 1. Align Public Identity Configuration

- [x] 1.1 Set the default identity route prefix and binding, and the flows e2e binding, to `/`.
- [x] 1.2 Remove the unused Keycloak inline public path and legacy prefixes from default/profile OIDC values.
- [x] 1.3 Align each profile's issuer base with its public identity host while preserving internal JWKS URLs and image references.
- [x] 1.4 Align bootstrap and standalone identity route 1002 with `/realms/*` and native-admin upstream rewrite with `/admin/$1`; retain the native-admin authorization plugins.

## 2. Add Render Contracts

- [x] 2.1 Assert root Ingress/Route bindings and exact runtime, bootstrap discovery and verifier URLs across all profiles.
- [x] 2.2 Reject legacy binding, issuer, discovery and verifier overrides in the consistency contract.
- [x] 2.3 Update the staging musematic-host contract and document explicit upgrade values and public admin exposure.
- [x] 2.4 Assert no Keycloak upstream route matches or rewrites `/auth`, including negative route overrides; bound the standalone snapshot exception to the reviewed identity route without changing immutable fixtures.

## 3. Verify the Bounded Change

- [x] 3.1 Default and all four profiles pass Helm lint/template; baseline comparisons preserve Keycloak args/env and rendered image references for all profiles. The raw flows e2e overlay retains a pre-existing schema error (`global.environment: e2e`); lint/render and the root identity backend check pass with the test-only `global.environment=dev` override. No schema gate was bypassed.
- [x] 3.2 Root identity contracts (all five Ingress/Route profiles and five negative overrides), staging public-host contracts and the available Keycloak 26 login/import render subset pass. Seven staging infrastructure render contracts pass. Rendered OpenBao reconciler shell syntax passes via a temporary file. CI must rerun process contracts: `bwrap` cannot create namespaces; Node-to-shell stdin operations time out even for a trivial syntax check; packaged tests hit sandbox `tar` extraction errors (`Function not implemented`). The broader staging run was stopped after these environment limits were reproduced, with metrics, legacy-custody, mongo-bearer and public-host files passing. No test-tool changes were made.
- [x] 3.3 Validate OpenSpec, JavaScript syntax and diff formatting after the route repair. The previous attempt's scan missed the bootstrap identity and native-admin prefixes. The corrected chart/e2e scan, including standalone routes, finds no legacy realm URL, unused public path or legacy identity prefix; unrelated product API `/v1/auth` and OpenBao auth paths remain intact. Strict OpenSpec validation, both changed JavaScript syntax checks and diff formatting pass.
- [ ] 3.4 Human/control-plane: verify public discovery HTTP 200/matching issuer and internal APISIX token validation after deployment.
- [x] 3.5 Route repair verification: all 19 root identity contracts pass, including eight negative overrides. Staging public-host, Mongo route/snapshot and metrics contracts pass; the Keycloak login/import render subset and seven staging infrastructure render contracts pass. Default and four profiles pass Helm lint/template and base comparisons of Keycloak args/env and all rendered images. Raw e2e lint/template retain the base environment-schema rejection; the permitted test-only `global.environment=dev` overlay passes both checks and exposes the root identity backend. Full process suites remain with CI because sandbox namespace/process limitations are unchanged.
