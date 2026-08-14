## Purpose

Define a Keycloak 26-compatible, idempotent, and secret-safe contract for rendering, creating, reconciling, recovering, and verifying Falcone's platform realm.

## ADDED Requirements

### Requirement: Render a Keycloak 26-compatible realm login representation
Falcone SHALL require a present, non-null `bootstrap.oneShot.keycloak.realm.login` object containing exactly the required boolean properties `loginWithEmailAllowed`, `registrationAllowed`, `rememberMe`, `verifyEmail`, and `resetPasswordAllowed`. Falcone SHALL preserve that nested values API while rendering those five booleans at the top level of the Keycloak `RealmRepresentation`. The rendered create payload MUST omit the non-Keycloak `login` wrapper, MUST preserve the other supported top-level realm properties, and MUST preserve the chart's historical precedence for an existing non-zero top-level realm value when a nested partial settings group contains the same provider property.

#### Scenario: Fresh install sends Keycloak 26 login settings as top-level realm fields
- **WHEN** a fresh install supplies all five valid booleans under `bootstrap.oneShot.keycloak.realm.login` and the platform realm does not exist
- **THEN** the rendered `realm.json` contains the five configured booleans at its top level and contains no `login` property
- **AND** an unrelated non-zero realm property already authored at the top level retains its historical value instead of being overwritten by a nested partial settings value
- **AND** Keycloak 26 accepts the realm-create request and bootstrap proceeds only after the created realm converges to those values

### Requirement: Validate and reconcile realm login settings without destructive recreation
Falcone SHALL validate the required, non-null nested realm login contract before issuing an authenticated Keycloak request. Falcone SHALL reject any of the five login property names authored directly under `bootstrap.oneShot.keycloak.realm`, regardless of whether the nested `login` object is valid, absent, or null and regardless of whether a direct value would equal or conflict with a nested value. When a platform realm already exists, Falcone SHALL reconcile and verify all five configured login values without deleting or recreating the realm, its users, roles, clients, or sessions. Repeated executions with the same desired values MUST be idempotent, including when the one-shot completion marker already matches.

#### Scenario: Existing realms are preserved while Keycloak 26 login settings are reconciled on upgrade
- **WHEN** an operator upgrades an installation whose platform realm already exists and whose values use the supported nested login configuration
- **THEN** the upgrade reconciliation converges and verifies the five top-level Keycloak realm login properties even if the create-only phase is skipped
- **AND** the existing realm identity, users, roles, clients, and sessions are preserved without a delete-and-recreate operation
- **AND** rerunning the same reconciliation produces no destructive or divergent result

#### Scenario: Malformed realm login configuration fails before any Keycloak mutation
- **WHEN** the nested `login` object is absent or null, any required nested property is absent or not boolean, or an unsupported nested property is present
- **THEN** chart validation or rendering fails before the bootstrap Job can issue a Keycloak mutation
- **AND** direct top-level login properties, if present, cannot replace the required nested source of truth
- **AND** the error identifies the invalid configuration path without printing a credential or Kubernetes Secret value

#### Scenario: Conflicting nested and top-level realm login settings fail closed
- **WHEN** any one of the five login property names is authored directly under `realm` in addition to a valid nested `login` object, whether its value matches or conflicts with the nested value
- **THEN** rendering fails with a duplicate-path diagnostic before any Keycloak mutation
- **AND** Falcone does not silently choose, merge, or overwrite either authoring path

### Requirement: Fail atomically at the bootstrap phase and provide safe recovery
When Keycloak rejects a realm discovery, create, or reconciliation request, or a read-after-write check detects drift, Falcone SHALL exit the bootstrap Job non-zero, SHALL NOT run later bootstrap phases, and SHALL NOT write the successful one-shot marker. Each such diagnostic SHALL identify the target realm and provide bounded actionable guidance to correct or resolve the condition and retry to fail forward safely. Diagnostics and rendered non-Secret resources MUST NOT expose provider response bodies, bearer tokens, passwords, API keys, credential values, or Kubernetes Secret values. Recovery guidance SHALL distinguish safe rollback from fail-forward retry, state that no automatic destructive realm rollback occurs, and provide post-recovery verification steps.

#### Scenario: Realm bootstrap failures do not expose credentials or Secret values
- **WHEN** realm creation, reconciliation, or convergence verification fails while the Job uses sentinel Secret-sourced credentials
- **THEN** the rendered non-Secret resources and captured standard output and error contain none of the sentinel values, bearer token, password, API key, or decoded Kubernetes Secret data
- **AND** the diagnostic reports only the failed phase, target realm, safe status information, and bounded correct-or-resolve and retry-to-fail-forward guidance without printing the provider response body

#### Scenario: Realm compatibility failure does not roll back or continue a partial bootstrap
- **WHEN** Keycloak 26 returns a non-success response for the compatible realm representation or the read-after-write values do not match
- **THEN** Falcone stops before later bootstrap phases and before writing the successful one-shot marker
- **AND** the failure identifies the target realm and directs the operator to correct or resolve the condition and retry to fail forward safely
- **AND** Falcone preserves any pre-existing realm and does not attempt delete/recreate or an automatic compensating rollback
- **AND** operator guidance directs a failed fresh install to correct the configuration and fail forward, permits rollback only when the documented preconditions preserve an existing usable realm, and requires the retry or rollback result to be verified

### Requirement: Provide automated and disposable Keycloak 26 acceptance evidence
The change SHALL include deterministic Helm-render and process-isolated black-box coverage for the six non-live scenarios in this specification, using the literal scenario headers as test traceability labels. It SHALL also include a disposable live Keycloak 26 acceptance run that uses Secret-sourced unique credentials, verifies the rendered realm and bootstrap authentication behavior, records secret-safe evidence, and cleans up all resources. The operator documentation SHALL describe how to run the relevant checks and interpret their safe success and failure signals.

#### Scenario: Disposable Keycloak 26 verification imports the rendered realm and authenticates the bootstrap principal
- **WHEN** the chart is installed against the supported Keycloak 26 image in a disposable isolated environment with unique Secret-sourced credentials
- **THEN** Keycloak imports the rendered realm, reports all five configured login properties at the realm top level, and successfully authenticates the bootstrap principal
- **AND** the bootstrap Job completes, its success marker is written only after convergence checks pass, and no sensitive value appears in collected evidence
- **AND** the verification removes the disposable workload, credentials, and persistent state and records cleanup proof
