# Mongo bearer route #980 deployment handoff

This follow-up builds on charts commit `89461b2d0b2ce41684e9199317268912b71e2d7a`
in the assigned issue-980 worktree. The default APISIX config-overlay init
container now reuses the APISIX workload image through
`component-wrapper.image`, including its promoted digest and registry mirror.
It no longer introduces a separate BusyBox image in default, prod, or kind.
No image tag or digest was changed. The existing staging overlay image and
the route tables remain unchanged. The Mongo policy comment now describes
trusting valid realms on the configured Keycloak host.

## Bounded validation

- Mongo bearer chart checks: 8/8 pass, including staging route equality,
  environment configuration, kind mounts, and overlay image promotion.
- Source Mongo route/parity checks against this worktree: 4/4 pass.
- Strict Helm lint: default, staging, prod, and kind all pass.
- Staging infrastructure contract: 13/14 pass. The shell-syntax subprocess
  at `tests/blackbox/staging-infrastructure/staging-infrastructure-contract.test.mjs:248`
  times out at its existing 30-second bound when its script is piped through
  Node. Checking the same rendered script with `/bin/sh -n` and file input
  passes; no script was executed. Rerun the full contract in PR CI.
- Lua verifier tests are skipped because Lua/LuaJIT is not installed.
- The live kind bearer round trip is skipped because it requires container
  images and a cluster; kind is not installed. These remain CI/release gates.

## Release follow-up

- Update both source workflow `FALCONE_CHARTS_REF` pins to the final charts
  commit containing this follow-up, then repeat parity and the CI gates.
  Both currently pin the prior charts HEAD above. Source files are outside
  this deployment worktree assignment.
- Confirm the staging/prod public issuer and in-cluster JWKS URLs and executor
  egress to the public issuer hosts with the deployment owner.
- Record the live staging standalone ConfigMap SHA256 and diff it against
  the render before the operator-gated sync. The repository baseline is
  derived from base kind routes, not a captured live ConfigMap, and contains
  no staging workaround route. Do not remove the live workaround separately.
- Verify plugin loading, bearer CRUD, unauthenticated/foreign-issuer 401s,
  APISIX metrics, and another executor-served family after rollout. The Lua
  suite covers the remaining token rejection cases; real RSA verification
  still requires the live kind test.
- The verifier currently rejects an unknown `kid` until cached JWKS expires
  (default 300 seconds). A refresh on unknown `kid` needs a per-realm cooldown
  as well as the existing worker fetch limit to avoid repeated refreshes
  displacing valid keys. Treat this optional rotation improvement as a
  separately tested release-review decision; this follow-up preserves the
  existing bounded cache and fail-closed behavior.

No deployment, push, merge, or cluster access was performed.
