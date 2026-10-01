# Mongo bearer route #980 deployment repair handoff

This repair builds on `bb3284bf992a05d1c85149a1115982321fc2f2e5` in the
assigned issue-980 deployment worktree. The config-overlay init container uses
the separately pinned BusyBox digest
`sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0`
from staging in default, prod, kind and staging. It never uses the APISIX image.
Like the existing staging literal, its `docker.io/library/busybox` reference
is not rewritten by `global.imageRegistry`. Airgap/mirror installs must provide
an explicit init-image override with the same digest; release review must decide
whether to add it to `values/airgap.yaml` and the mirror manifest.

The prior attempt's default pod-level UID/GID/fsGroup overrides are restored to
main's empty component override. APISIX keeps container UID/GID 636 and inherited
fsGroup 1001; staging retains its existing pod UID/GID 636. The new default
BusyBox init container itself runs as UID/GID 636 with non-root hardening, so it
can copy the config without changing the pod identity. The unchanged OpenShift
wrapper removes those init IDs for SCC assignment. All pod and main-container
identity inputs and the wrapper equal base/main `433be510` in all four profiles.

Staging's Mongo issuer base is `https://iam.baas.musematic.ai` without `/auth`,
and its JWKS base remains `http://falcone-keycloak:8080`. Executor and verifier
settings agree. Other families' `gatewayPolicy.oidc` settings are unchanged.
Prod hosts remain explicitly documented placeholders pending operator input.
Standalone routes and the verifier implementation are unchanged by this repair.

## Reviewed fixture re-baselines

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: from
  `8abf83afb239aea9911bb1d3ad7b88d315255766ee1f7354fdd5d1f4f259140e`
  to `b19843c58df41783469ca6655a5d160bc458488de4089dc4bb05839f29715588`.
  The canonical default render now includes the reviewed BusyBox digest,
  explicit pull policy and init identity, with the APISIX pod identity restored
  to main. Existing #980 verifier configuration and mounts remain in the render.
- `tests/flow-audit-chart.test.mjs` prior baseline: from
  `eaeef43016cb21a01378e6a6dee23e361bdce072b25c1ac97ecb2dffec86badb`
  to `3abc15a2691fc8839c74640770b23771c2d27f001e663fb319ea0543ea7a8b08`.
  This hashes the same reviewed default after removing only flow-audit objects,
  bundled rule loading and the rollout marker. Flow-audit behavior is unchanged;
  its exact object, rule and migration assertions still pass. No other fixture
  is re-baselined, including the pre-980 routes and canonical route hashes.

## Bounded validation

- Mongo bearer chart checks: 9/9 pass, including four-profile BusyBox checks,
  staging issuer/JWKS, route equality without `llmwiki-s2-mongo-jwt`, kind mounts,
  required verifier failures and OpenShift identities.
- Source Mongo route/parity checks against this chart: 4/4 pass.
- Strict Helm lint and renders: default, staging, prod and kind pass.
- Flow-audit chart checks: 7/7 pass; managed-Knative default baseline passes.
- Both existing revision23 numeric-user/OpenShift render regressions pass.
- Identity values and wrapper comparison against main/base passes.
- Full staging-infrastructure contract: 13/14 pass; the existing shell-syntax
  subprocess at `staging-infrastructure-contract.test.mjs:248` times out at its
  30-second bound with Node pipe input. The same rendered script passes
  `/bin/sh -n` with file input; no script is executed. Rerun the full gate in CI.
- Source gateway-policy unit/contracts cannot start without the existing `yaml`
  dependency. Lua/LuaJIT and kind are absent. Dependency installation, Lua
  verification and the live bearer CRUD/isolation/API-key round trip remain
  PR CI/release checks; no network or container/image checks were attempted.

## Paired-repository pin and release follow-up

Pin state: **pin pending deployment repair** from the preceding source-maker
handoff. Both source workflow pins currently name `bb3284bf992a05d1c85149a1115982321fc2f2e5`.
This commit completes the deployment repairs; the next source maker must set
both `FALCONE_CHARTS_REF` pins to the final deployment HEAD (the commit containing
this handoff, obtained with `git rev-parse HEAD`) and repeat parity. Source files
are outside this assignment. The paired checker gate remains pending until the
pins converge; no additional deployment follow-up commit is needed for the pin.

Before operator-gated sync, verify the staging token issuer without exposing the
token, confirm prod hosts and executor egress to public issuer hosts, and record
the live standalone ConfigMap SHA256/diff plus rollback content as an artifact.
The route fixture is derived from base kind routes, not a live capture; adoption
must remove the workaround through the managed render. Preserve Secret-sourced
gateway trust and External Secrets/OpenBao gates. After rollout, verify bearer
CRUD, workspace isolation, rejected tokens, API-key scope/429 and plugin loading.
Unknown `kid` remains rejected until the bounded 300-second cache expires;
refresh-on-unknown-key is a separate release-review decision.

No deployment, push, merge, credential access or cluster mutation was performed.
