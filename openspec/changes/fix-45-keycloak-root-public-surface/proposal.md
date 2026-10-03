## Why

Keycloak 26 serves at root, but the public identity binding and advertised OIDC URLs use a legacy `/auth` prefix. The unused `keycloak.config.inline.publicPath` does not configure a relative path, so public discovery returns 404 while internal root-path consumers continue to work.

## What Changes

- Serve the identity Ingress and OpenShift Route at `/`, backed by Keycloak's `http` service port.
- Remove the unused inline public path and the legacy prefix from default and environment-profile issuer/discovery URLs.
- Explicitly set the sandbox issuer base to its identity host instead of inheriting the development host.
- Align bootstrap and standalone APISIX identity route 1002 with `/realms/*`, forwarding the path unchanged to root-serving Keycloak. Keep the native-admin binding and its authorization plugins, but rewrite its upstream target to `/admin/$1`.
- Update the flows e2e identity binding and add blackbox render contracts for default, dev, sandbox, staging and prod, including negative overrides.
- Preserve Keycloak args/env, image references, internal service URLs, External Secrets/OpenBao and existing fail-closed checks.

## Capabilities

### New Capabilities

- `keycloak-public-identity`: Consistent root-path public identity routing, issuer/discovery and internal JWKS verification.

### Modified Capabilities

None.

## Impact and Upgrade Guidance

No data, schema, realm-import, persistence or image changes are required. Removing the unused generated ConfigMap also removes its `envFrom` reference from the Keycloak pod template; this can trigger a rollout even though the container args and env are unchanged.

Upgrades using `--reuse-values` retain stale `/auth` configuration. Operators must pass the updated chart defaults and environment values, including the bootstrap APISIX routes, explicitly set `publicSurface.routePrefixes.identity=/`, `publicSurface.bindings.identity.path=/`, the public issuer base and OIDC issuer/discovery URLs, and clear the old `keycloak.config.inline` block. Use the project's deterministic Helm adapter and retain all migration, backup, parity and secret-management gates. Deliver the paired source identity-path and topology changes with this chart change to keep their contracts consistent.

The root identity host also makes Keycloak's credential-protected `/admin` surface reachable. Limiting public paths to `/realms` and `/resources` requires a separate change to support multiple paths per binding.

## Delivery and Release Review

Publish and deliver the chart root-path change before the paired source change. Both source CI workflows must pin a published chart revision containing chart commit `85c4435c73fdb5e21ecc7f4392183fb86670f681`; if delivery rewrites that commit, update both pins to the resulting revision. The source kind standalone APISIX file must remain byte-identical to `charts/in-falcone/files/apisix/standalone/apisix.yaml`, and its deployment smoke contract must expect identity route `/realms/*`.

Release review must explicitly accept the Keycloak rollout caused by removing the inline ConfigMap's `envFrom` reference and the public admin exposure described above. The API-host identity alias changes from `/auth/*` with prefix stripping to `/realms/*` passthrough; clients using the old alias must use the advertised root-path identity URL. These delivery checks belong to the control-plane and do not authorize deployment from this worktree.

Rollback restores the previous, already-broken public prefix; it does not restore working public OIDC. No deployment or rollback is executed by this ChangeSet.

## Verification

Run scoped Helm lint/renders, the root identity and staging infrastructure blackbox contracts, and the Keycloak 26 login/import contract. Compare pre/post-render Keycloak args/env and image references for every profile. Environment-dependent checks remain with PR CI and the release gate.

After deployment, the human/control-plane must fetch `https://iam.<domain>/realms/in-falcone-platform/.well-known/openid-configuration`, require HTTP 200 JSON with issuer matching `gatewayPolicy.oidc.issuerUrl`, and verify internal APISIX bearer-token validation.
