## Why

Falcone's values API groups five realm login booleans under `bootstrap.oneShot.keycloak.realm.login`, but the rendered `realm.json` leaves that wrapper intact even though Keycloak 26 expects those properties on the top-level `RealmRepresentation`. A clean install therefore receives HTTP 400 while creating the platform realm and cannot complete bootstrap; rendering the equivalent flattened representation imports successfully.

## What Changes

- Preserve the nested values API while lifting exactly `loginWithEmailAllowed`, `registrationAllowed`, `rememberMe`, `verifyEmail`, and `resetPasswordAllowed` into the rendered realm's top level and omitting the `login` wrapper.
- Reject malformed or conflicting nested/top-level login settings before any Keycloak mutation instead of silently choosing one representation.
- Keep fresh-install retry and upgrade behavior idempotent: a corrected retry may create a realm after the failed attempt left no completion marker, while an existing realm is reconciled without destructive recreation.
- Keep bootstrap failure output free of credentials and Kubernetes Secret values, and stop the remaining bootstrap phases when realm compatibility or convergence fails.
- Cover deterministic render/process tests, upgrade and recovery behavior, rollback/fail-forward guidance, and disposable live Keycloak 26 verification.

## Capabilities

### New Capabilities

- `keycloak-realm-bootstrap`: Defines the Keycloak 26-compatible realm login representation, validation, idempotent fresh-install and upgrade behavior, secure failure handling, recovery, and verification contract.

### Modified Capabilities

None.

## Impact

- Realm payload construction and bootstrap execution: `charts/in-falcone/templates/bootstrap-payload-configmap.yaml::realm.json:1-31`, `charts/in-falcone/templates/bootstrap-script-configmap.yaml::ensure_keycloak_realm:120-151`.
- Authored values and their validation contract: `charts/in-falcone/values.yaml::bootstrap.oneShot.keycloak.realm.login:434-469`, `charts/in-falcone/values.schema.json::bootstrap.oneShot.keycloak.realm.login:1541-1589`.
- Helm render and black-box bootstrap tests, disposable Keycloak 26 acceptance verification, and install/upgrade recovery documentation.
- No external API or credential-storage format changes; the chart's nested values API remains compatible.
