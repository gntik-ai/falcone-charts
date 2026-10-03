## 1. Align Public Identity Configuration

- [x] 1.1 Set the default identity route prefix and binding, and the flows e2e binding, to `/`.
- [x] 1.2 Remove the unused Keycloak inline public path and legacy prefixes from default/profile OIDC values.
- [x] 1.3 Align each profile's issuer base with its public identity host while preserving internal JWKS URLs and image references.

## 2. Add Render Contracts

- [x] 2.1 Assert root Ingress/Route bindings and exact runtime, bootstrap discovery and verifier URLs across all profiles.
- [x] 2.2 Reject legacy binding, issuer, discovery and verifier overrides in the consistency contract.
- [x] 2.3 Update the staging musematic-host contract and document explicit upgrade values and public admin exposure.

## 3. Verify the Bounded Change

- [x] 3.1 Default and all four profiles pass Helm lint/template; baseline comparisons preserve Keycloak args/env and rendered image references for all profiles. The raw flows e2e overlay retains a pre-existing schema error (`global.environment: e2e`); lint/render and the root identity backend check pass with the test-only `global.environment=dev` override. No schema gate was bypassed.
- [x] 3.2 Root identity contracts (all five Ingress/Route profiles and five negative overrides), staging public-host contracts and the available Keycloak 26 login/import render subset pass. Seven staging infrastructure render contracts pass. Rendered OpenBao reconciler shell syntax passes via a temporary file. CI must rerun process contracts: `bwrap` cannot create namespaces; Node-to-shell stdin operations time out even for a trivial syntax check; packaged tests hit sandbox `tar` extraction errors (`Function not implemented`). The broader staging run was stopped after these environment limits were reproduced, with metrics, legacy-custody, mongo-bearer and public-host files passing. No test-tool changes were made.
- [x] 3.3 Validate OpenSpec, JavaScript syntax and diff formatting. Strict OpenSpec validation and both changed JavaScript syntax checks pass; the scoped chart/e2e scan contains no legacy realm URL, unused public path or legacy identity prefix.
- [ ] 3.4 Human/control-plane: verify public discovery HTTP 200/matching issuer and internal APISIX token validation after deployment.
