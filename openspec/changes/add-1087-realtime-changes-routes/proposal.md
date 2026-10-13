# Change: Publish the executor-authenticated realtime SSE gateway family

## Why

The console uses EventSource for collection and table change streams. The paired
source change for gntik-ai/falcone#1087 publishes those operations and keeps
credential verification and workspace authorization in the executor. The deployed
gateway must route them without requiring browser-supplied authentication headers.

## What Changes

- Publish the dedicated `realtime-changes` family for the collection and table
  `/changes` paths, with GET and gateway CORS preflight only.
- Preserve per-key rate limits, long SSE upstream timeouts, body limits, explicit
  identity-header blanking, and the gateway-auth header.
- Apply the same boundary to reconciled payloads, standalone configuration, and
  stored release values. Preserve authentication on capture-management routes.
- Cover the rendered gateway configurations with the existing blackbox suite.

## Scope and Release Review

The route implementation is already committed in `31e709ccf47ececb5e3e98126539aa8f7563b9fd`.
This follow-up records the required deployment OpenSpec and its validation limits.
Executor authorization, catalog and OpenAPI changes belong to the paired source
worktree. Image promotion is managed separately; no image reference changes here.

Before staging exposure, the release review must confirm the paired executor
authorization and #1118 access-log redaction changes, and run gateway event,
credential, method-rejection and preflight checks. Rate-limit sizing and connection
caps remain release-review concerns. No deployment is performed by this change.
