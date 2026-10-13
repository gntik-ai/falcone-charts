## ADDED Requirements

### Requirement: Dedicated executor-authenticated change-stream family

The deployed gateway SHALL publish a `realtime-changes` family for
`/v1/realtime/workspaces/{workspaceId}/data/{databaseName}/collections/{collectionName}/changes`
and
`/v1/realtime/workspaces/{workspaceId}/data/{databaseName}/schemas/{schemaName}/tables/{tableName}/changes`.
Only GET and OPTIONS SHALL match. CORS SHALL answer preflight before the executor.
Credential verification and workspace authorization SHALL remain in the executor.

#### Scenario: Render the stream safety boundary

- **WHEN** default, staging or production gateway routes are rendered
- **THEN** the routes use the `realtime-changes` family and a URI constraint ending
  in `/changes$` that matches only the collection and table stream shapes
- **AND** the routes enable CORS, positive client-control body limits, and
  limit-count with HTTP 429, header/query API-key coverage and no degradation
- **AND** proxy-rewrite blanks `x-tenant-id`, `x-workspace-id`, `x-auth-subject`
  and `x-actor-roles`, and sets `x-gateway-auth`
- **AND** the executor upstream has long read and send timeouts
- **AND** the stream routes omit OIDC and request-validation.

#### Scenario: Reject other paths and methods

- **WHEN** a request uses POST, PUT, PATCH, DELETE or HEAD on a change-stream path,
  or uses a capture-management path
- **THEN** it does not match the change-stream route
- **AND** capture-management routes retain their existing authentication and
  request-validation plugins.

#### Scenario: Stored values retain the stream boundary

- **WHEN** an existing release stores the old realtime stream family and lacks
  the new family-policy entry
- **THEN** gateway rendering retains the dedicated stream safety boundary without
  requiring a new values key
- **AND** existing upgrade and migration safety gates remain in force.
