## Implementation tasks

- [x] Define `global.openshiftBuild.baseImages`, `global.openshiftBuild.buildArgs` and
      `global.openshiftBuild.env` in chart values and JSON schema, including type, C-identifier key,
      image-reference, qualified-registry, exact DNS Secret-name, and unknown-service validation.
- [x] Resolve each service's effective base image from service-specific and generic overrides,
      render `NODE_BASE_IMAGE` for all six source-build BuildConfigs, and reject a missing or
      non-private effective value in private source-build mode.
- [x] Render generic build arguments and environment deterministically with stable lexical ordering;
      preserve PR #4 contexts, triggers, ImageStreams and output tags.
- [x] Require every `global.privateRegistry.pullSecretNames` entry to be nonempty and wire the first
      entry to `spec.strategy.dockerStrategy.pullSecret.name` on all six BuildConfigs without
      copying data.
- [x] Add negative/template tests for malformed maps, invalid keys, unknown services, empty maps,
      missing/private/public/lookalike base references, later empty pull-secret entries, and absence
      of any per-BuildConfig CA field.
- [x] Add compatibility tests proving connected defaults and source mode with no overrides remain
      unchanged, plus rollback tests for removing overrides and failed upgrades.
- [x] Add documentation and NOTES covering disconnected mirroring, digest pinning, package mirrors,
      secret creation/rotation, and the required `global.privateRegistry.caBundleConfigMap` ConfigMap
      in `openshift-config` referenced by `image.config.openshift.io/cluster.spec.additionalTrustedCA`;
      render no per-BuildConfig CA field.
- [x] Execute live builds on the authorized remote OpenShift test project using private/internal
      registry images, verify all six BuildConfigs plus their ConfigChange/GitLab trigger definitions,
      then delete disposable resources and prove cleanup.
- [x] Run chart lint/schema/template tests and record evidence before opening the implementation PR.
