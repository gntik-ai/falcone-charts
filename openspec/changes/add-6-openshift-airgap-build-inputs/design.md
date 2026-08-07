## Context

Chart PR #4 already renders six GitLab/ConfigChange-triggered BuildConfigs and ImageStreams for
source mode. Falcone PR #930 (merged) makes service Dockerfiles consumable from private registries
through `ARG NODE_BASE_IMAGE`, with defaults `node:22-alpine` (or `node:22-slim` for the worker).
The chart must supply those values without changing the generated service names, contexts,
triggers or output ImageStreams.

## Decisions

1. **One explicit source-build contract.** Values are grouped under `global.openshiftBuild` and are rendered
   for every enabled source-built service. `baseImages` is a map keyed by the catalog service name;
   absent keys use the catalog default only in connected mode. `buildArgs` and `env` are maps with
   deterministic lexical key ordering. Map keys must be C identifiers and cannot alter chart-owned
   context, output, trigger or service identity fields because those fields are not exposed through
   either map.
2. **Falcone wire mapping.** Configured `baseImages[service]` emits `NODE_BASE_IMAGE`; when unset,
   no such argument is emitted and the Dockerfile default is used. Generic `buildArgs` and `env`
   render in lexical order; a generic `NODE_BASE_IMAGE` is ignored when a service-specific image is
   configured. Empty maps render no entries, not null placeholders. Private source-build mode
   requires every service to resolve an effective private/internal `NODE_BASE_IMAGE`; it rejects
   missing values, public registries and configured-registry prefix spoofing before submission.
3. **Private registry authentication.** When `global.privateRegistry.pullSecretNames` is enabled
   and every list entry is nonempty, its first entry is referenced as
   `spec.strategy.dockerStrategy.pullSecret.name` on all six BuildConfigs. The chart never embeds
   secret data or creates a Secret from a value. Every supplied entry is validated as an exact
   DNS-1123 subdomain; private-registry mode additionally requires at least one entry.
4. **CA truthfulness.** Private registry trust is documented and tested as a cluster prerequisite:
   an administrator must configure `image.config.openshift.io/cluster.spec.additionalTrustedCA`
   (and the associated ConfigMap) before builds. No unsupported per-BuildConfig CA knob is rendered.
5. **Compatibility and rollback.** With source mode disabled, or in connected source mode with no
   new values, rendered output remains byte-for-byte equivalent to the PR #4 behavior. Removing
   overrides while private source-build mode remains enabled is rejected before upgrade so the
   existing release remains intact; disabling private/source mode restores connected defaults.
6. **Exact private boundary.** Private source-build mode is the conjunction of the source-build and
   private-registry flags. Its registry authority must contain a dot or port, or be `localhost`;
   optional repository path segments and one trailing slash are supported. The allowlist comparison
   uses the normalized complete prefix plus `/`, alongside the exact OpenShift internal-registry
   prefix, so unqualified and lookalike values fail before rendering.

## Rejected alternatives

- A per-BuildConfig CA field: not an OpenShift API contract and would falsely imply registry trust;
  `global.privateRegistry.caBundleConfigMap` is a cluster-level prerequisite only.
- Secret data in Helm values: leaks credentials and bypasses namespace secret governance.
- Service-specific bespoke value keys: duplicate the Dockerfile catalog and make new services
  non-deterministic.
