# Mongo bearer route #980 deployment repair handoff

This repair extends deployment head
`a37661b424c37f5979ab54415e2ed6dc9d00b569` in the clean assigned issue-980
worktree and branch `agent/falcone/980/5fcefe28-5a92-5e96-a3cd-6b1369cd20d6`.
It fixes the checker's airgap regression with an explicit mirrored init-container
override in `values/airgap.yaml` and adds a render regression test. The
config-overlay init container uses
the separately pinned BusyBox digest
`sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0`
from staging in default, prod, kind and staging. It never uses the APISIX image.
Like the existing staging literal, its `docker.io/library/busybox` reference
is not rewritten by `global.imageRegistry` in those four profiles. The airgap
profile now overrides it with `registry.airgap.in-falcone.local/library/busybox`
at the identical digest. Because Helm replaces lists, the override retains the
complete copy command, mounts, pull policy and security context. The regression
test checks all rendered workload images use the airgap registry and that the
OpenShift overlay still removes the init container's numeric IDs. Release review
must confirm the BusyBox digest is present in the mirror's image inventory;
this repository change does not populate that registry.

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

All "from" hashes below are relative to base/main
`433be510e84be3043ffa09ca354475184f0460f6`, rather than an intermediate
ChangeSet commit.

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: from
  `b18179ef33e096050c236aee0efc87c886f63ceaf06bc61269c4370225d5c15c`
  to `b19843c58df41783469ca6655a5d160bc458488de4089dc4bb05839f29715588`.
  The canonical default render now includes the reviewed BusyBox digest,
  explicit pull policy and init identity, with the APISIX pod identity restored
  to main. Existing #980 verifier configuration and mounts remain in the render.
- `tests/flow-audit-chart.test.mjs` prior baseline: from
  `26c5dc19ecbb5054fc3a8565852c89def7f2456793010fe320d0fa046e56087b`
  to `3abc15a2691fc8839c74640770b23771c2d27f001e663fb319ea0543ea7a8b08`.
  This hashes the same reviewed default after removing only flow-audit objects,
  bundled rule loading and the rollout marker. Flow-audit behavior is unchanged;
  its exact object, rule and migration assertions still pass. No other fixture
  is re-baselined, including the pre-980 routes and canonical route hashes.

## Bounded validation

This airgap follow-up ran the following bounded checks:

- Mongo bearer chart checks: 10/10 pass, including four-profile BusyBox checks,
  staging issuer/JWKS, route equality without `llmwiki-s2-mongo-jwt`, kind mounts,
  required verifier failures, OpenShift identities and the new airgap mirror
  check. The new check first reproduced the public-image regression before the
  override was added.
- Source Mongo route/parity checks against this chart: 4/4 pass.
- Strict Helm lint and renders: default, staging, prod, kind and airgap pass.
- Complete airgap render comparison against the preceding deployment head:
  only the overlay image registry changes; the digest and all other bytes agree.
- Flow-audit chart checks: 7/7 pass, including the default render and flow-audit
  baseline hashes. No fixtures are re-baselined by this follow-up; the reviewed
  base-relative justifications above remain valid.

The prior runtime repair also passed the managed-Knative default baseline,
both revision23 numeric-user/OpenShift render regressions and the identity
values/wrapper comparison against base. Its remaining CI limits are:

- Full staging-infrastructure contract previously passed 13/14; the shell-syntax
  subprocess at `staging-infrastructure-contract.test.mjs:248` times out at its
  30-second bound with Node pipe input. The same rendered script passes
  `/bin/sh -n` with file input; no script is executed. Rerun the full gate in CI.
- Source gateway-policy unit/contracts cannot start without the existing `yaml`
  dependency. Lua/LuaJIT and kind are absent. Dependency installation, Lua
  verification and the live bearer CRUD/isolation/API-key round trip remain
  PR CI/release checks; no network or container/image checks were attempted.

## Paired-repository pin and release follow-up

The preceding source maker at
`a7b9994fc8bb32cda973b57320b3eeb83cbd1909` records
**pin pending deployment repair** and preserves both `FALCONE_CHARTS_REF` pins at
`05bfc41d9095717cff1e33a5c16f2bc3cfe2d855`, as required by operator addendum 9
while this airgap repair was outstanding. The airgap repair is complete in the
commit containing this handoff. That commit is the final deployment ChangeSet
head, obtained with `git rev-parse HEAD`, and is the exact revision both source
workflow pins must select. Pin state after this commit: **source pin refresh
pending final deployment head**. The next source maker must update
`.github/workflows/ci.yml` and `.github/workflows/integration.yml`, refresh the
source OpenSpec record and rerun parity. Source files are outside this assignment.
The paired checker gate remains pending until the pins converge; no deployment
follow-up commit is needed to record the pin.

Release review must confirm that wrong-audience rejection is required only for
the platform realm; tenant tokens currently use the trusted realm issuer and
executor workspace binding. Bearer rate limiting retains its existing shared-IP
fallback because identity headers must be empty; a per-subject bucket is a
separate follow-up. The bootstrap Mongo body cap remains 262144 bytes and the
standalone/kind cap remains 1048576 bytes; both are bounded and unchanged here.

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
