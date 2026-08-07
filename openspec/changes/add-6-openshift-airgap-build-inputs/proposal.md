## Why

The source-build mode added by PR #4 can build Falcone services on OpenShift, but it cannot
reproduce a fully disconnected build. Falcone PR #930 now exposes per-service `NODE_BASE_IMAGE`
inputs; the chart must map those inputs, generic build arguments and environment variables into
each BuildConfig while preserving connected-install defaults. Operators also need a supported
private-registry pull secret and an accurate cluster-wide CA prerequisite.

## What Changes

- Add a typed, schema-validated `global.openshiftBuild` input contract for per-service `baseImages`,
  deterministic generic `buildArgs` and `env`.
- Map the existing `global.privateRegistry.pullSecretNames` contract deterministically to the
  BuildConfig pull-secret reference.
- Render the contract identically for every source-built service, including the
  `NODE_BASE_IMAGE` mapping required by Falcone release Dockerfiles.
- Document that private registry CA trust is configured through OpenShift's
  `image.config.openshift.io/cluster` `additionalTrustedCA`; no per-BuildConfig CA field is
  invented.
- Add render, schema, source-build, live remote OpenShift, rollback and compatibility coverage.
