## Why

Keycloak 26 serves at root, but the public identity binding and advertised OIDC URLs use a legacy `/auth` prefix. The unused `keycloak.config.inline.publicPath` does not configure a relative path, so public discovery returns 404 while internal root-path consumers continue to work.

## What Changes

- Keep Keycloak serving at root and expose only `/realms`, `/resources` and `/js` on the identity host, backed by its `http` service port. Ingress has one Prefix rule per path; OpenShift has one Route per path. Neither exposes `/admin` or `/admin/*`.
- Add optional binding `paths`, replacing `path` when present, while retaining scalar `path` compatibility. Multi-path Route names use deterministic path hashes with DNS-1123 length bounds; single-path names remain unchanged.
- Fail render for root, admin and legacy `/auth` paths on identity or any other Keycloak-backed public binding, including case variants and paths with dot segments. Use portable allowlists: ingress-nginx deny snippets are disabled by default in recent controllers, and OpenShift Routes cannot express deny rules.
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

Upgrades using `--reuse-values` retain stale `/auth` configuration. Operators must pass the updated chart defaults and environment values, including the bootstrap APISIX routes, explicitly set `publicSurface.routePrefixes.identity=/`, `publicSurface.bindings.identity.paths=[/realms,/resources,/js]`, the public issuer base and OIDC issuer/discovery URLs, and clear the old `keycloak.config.inline` block. Use the project's deterministic Helm adapter and retain all migration, backup, parity and secret-management gates. Deliver the paired source identity-path and topology changes with this chart change to keep their contracts consistent.

Public `/admin` exposure is forbidden for Ingress and Route in this change. A leftover scalar `/` binding fails validation when no `paths` override is provided. LoadBalancer operates at L4 and still exposes the entire Keycloak HTTP port, including `/admin`; NOTES warns about this limitation. Failing closed for LoadBalancer is a follow-up release-review decision. Keycloak health and metrics use management port 9000 and are not exposed.

Release notes: the API-host `/auth/*` identity alias was removed; clients must use the advertised identity host and root realm URLs.

## Delivery and Release Review

Publish and deliver the chart root-path change before the paired source change. Both source CI workflows must pin the final published chart revision containing the allowlist commit `2801bd782c3e24cff70be7f0cd953bc6dd000fe0` and its review fixes; if delivery rewrites that history, update both pins to the resulting revision. The source kind standalone APISIX file must remain byte-identical to `charts/in-falcone/files/apisix/standalone/apisix.yaml`, and its deployment smoke contract must expect identity route `/realms/*`.

The supplied release-review decisions accept the one-time Keycloak rollout caused by removing the inline ConfigMap's `envFrom` reference and removal of the API-host `/auth/*` alias. They require blocking public admin exposure using the allowlist above. The control plane must authenticate these issue-body decisions before merge. These delivery checks belong to the control-plane and do not authorize deployment from this worktree.

Rollback restores the previous, already-broken public prefix; it does not restore working public OIDC. No deployment or rollback is executed by this ChangeSet.

## Verification

Run scoped Helm lint/renders, the root identity and staging infrastructure blackbox contracts, and the Keycloak 26 login/import contract. Compare pre/post-render Keycloak args/env and image references for every profile. Environment-dependent checks remain with PR CI and the release gate.

After deployment, the human/control-plane must fetch `https://iam.<domain>/realms/in-falcone-platform/.well-known/openid-configuration`, require HTTP 200 JSON with issuer matching `gatewayPolicy.oidc.issuerUrl`, verify that `/admin` and `/admin/x` on the identity host return default-backend 404, and verify internal APISIX bearer-token validation and the gated native-admin passthrough.
