# Mongo bearer route #980 deployment repair handoff

This repair extends deployment head `ac1e66a401acc62e09337920980c39233b5eaad6`
on the assigned branch `agent/falcone/980/5fcefe28-5a92-5e96-a3cd-6b1369cd20d6`.
It mirrors source repair `0bef4812`: route 2006 strips `apikey` and `x-api-key`
before reaching the executor, so JWT requests cannot switch credentials and
bypass route 2006-key's per-key bucket. The standalone file equals the source
kind file byte-for-byte, including the corrected Mongo upstream comment. The
Helm bootstrap route removes the same headers. Route 2006-key is unchanged;
staging/kind render tests compare it to the immutable pre-980 fixture.
Deployment CI now runs the offline verifier tests with LuaJIT, matching APISIX
and the OpenSpec test plan.

## Preserved deployment decisions

The config-overlay init container retains the reviewed BusyBox digest
`sha256:9db7b59979c38555a39def84a31fb98b5296952f9e3afd4f6f11f05b07adfab0`
in default, prod, kind and staging. The existing staging registry handling is
preserved; airgap explicitly mirrors the same digest and retains the command,
mounts and security context. No image reference changes in this repair.
Release review must confirm the digest exists in the mirror inventory.

APISIX retains main-container UID/GID 636 and inherited fsGroup 1001, with
staging's existing pod UID/GID 636. The BusyBox init container uses UID/GID 636.
The OpenShift overlay removes fixed IDs for SCC assignment. These contracts
remain equal to base/main `433be510e84be3043ffa09ca354475184f0460f6`.

Staging's issuer base remains `https://iam.baas.musematic.ai` without `/auth`;
JWKS stays at `http://falcone-keycloak:8080`. Executor and verifier agree.
Other route families' `gatewayPolicy.oidc` settings remain unchanged. Prod
Keycloak hosts remain documented placeholders; the existing non-Keycloak
console/CORS dev hostname is outside this change.

## Reviewed baseline changes and gate adaptations

Only the umbrella default render hash and flow-audit baseline are re-baselined.
The original #980 render changes add verifier configuration, plugin mounts,
managed staging routes and the BusyBox overlay while preserving pod identity.

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: base/main
  `b18179ef33e096050c236aee0efc87c886f63ceaf06bc61269c4370225d5c15c`,
  previous deployment `b19843c58df41783469ca6655a5d160bc458488de4089dc4bb05839f29715588`,
  repaired render `f74e1c505429b9823f5a352488ffafa674aa4af0d48b85b88cead3154cdba4fa`. Against the previous deployment, only
  `route-2006.json` in the bootstrap ConfigMap changes: its removal list adds
  the two API-key headers. A complete parsed render comparison confirms this.
- `tests/flow-audit-chart.test.mjs`: base/main prior-object baseline
  `26c5dc19ecbb5054fc3a8565852c89def7f2456793010fe320d0fa046e56087b`,
  previous deployment `3abc15a2691fc8839c74640770b23771c2d27f001e663fb319ea0543ea7a8b08`,
  repaired baseline `362fb0be45c9d0cdbc6982367ce82a5319f4a43ae6c138e3aaf0a21069e38cca`.
  This hashes the same default render after removing only flow-audit additions,
  rule loading and the rollout marker. The same two header removals require
  this update; flow-audit behavior and its exact assertions are unchanged.

The earlier ChangeSet also adapts these existing contracts, which were omitted
from the old handoff's accounting:

- `tests/blackbox/fixtures/staging-infrastructure/revision23-partial-manual-recovery-tools.mjs`
  adds the exact read-only verifier mount and ConfigMap volume to its synthetic
  live Deployment and Helm-render representations. This models the reviewed
  plugin attachment; it does not capture or change a live cluster.
- `charts/in-falcone/migrations/revision-20-repair.sh` requires those same exact
  mount and volume entries in both fail-closed APISIX convergence checks.
  Ownership, identity, image, evidence and mutation gates remain intact.
- `tests/blackbox/staging-infrastructure/staging-infrastructure-contract.test.mjs`
  requires exactly one Helm-managed `falcone-apisix-standalone` ConfigMap,
  implementing the operator's adoption decision instead of referencing it only.

Those adaptations are preserved, not expanded by this repair. The pre-980
route fixture and canonical route hash remain unchanged. The staging equality
test removes only the explicit reviewed header-removal delta and comment fix
when checking the original canonical hash, then verifies the rendered routes
against the pre-980 table plus route 2006 and the corrected comment.

## Validation and sandbox limits

The new assertions first reproduced the missing API-key header removals.
Scoped chart checks cover bootstrap, staging render and canonical kind removal lists,
unchanged API-key routes, four-profile BusyBox, issuer/JWKS parity, managed
staging route equality, required-key failures, airgap and OpenShift identities.
The flow-audit suite checks both permitted baselines. Strict lint and renders
cover default, prod, staging, kind and airgap. Source gateway route tests check
byte parity and both credential paths against this chart.

Final bounded results: Mongo chart 11/11, flow-audit 7/7, source route/parity
5/5, source policy/API-key contracts 14/14 with the read-only dependency loader,
five-profile strict lint/render, five scoped numeric-identity/OpenShift/staging
contract checks and the managed-Knative default baseline all pass. JavaScript
syntax, workflow YAML/LuaJIT command checks, repair-script Bash syntax and
`git diff --check` pass. These tests render or use synthetic fixtures only.

The full staging-infrastructure contract, including its shell-syntax subprocess,
remains a PR CI gate: that subprocess previously timed out at its 30-second bound
locally. LuaJIT is absent here; the updated CI step must run verifier rejection
and cache tests. Kind/Docker and image scans require PR CI/release infrastructure.
The source integration repair now exercises workspace-bound tokens, cross-workspace
403/404 without disclosure, mixed credentials, data:write enforcement and per-key
429 with an independent fresh-key bucket; it must run against the public APISIX
endpoint in CI. Native source policy contracts need installed dependencies;
read-only dependency-shim results are supplemental evidence, not the CI gate.

## Paired-repository pin and release follow-up

At entry, both source workflow pins equal the previous deployment head
`ac1e66a401acc62e09337920980c39233b5eaad6`. Source repair `0bef4812`
correctly records **pin pending deployment repair** while these chart repairs
are outstanding. The commit containing this handoff completes deployment repair;
its `git rev-parse HEAD` is the final deployment head. The next source maker must
set both `FALCONE_CHARTS_REF` pins to that exact head and rerun parity. Source files
are outside this deployment-only assignment. No further deployment commit is
needed to record the source pin refresh. The paired checker remains pending
until the pins converge.

Release review must confirm platform-only audience rejection versus the literal
wrong-audience acceptance criterion: tenant tokens currently use trusted realm
issuers and executor workspace binding. Bearer limiting retains the existing
shared-IP fallback; a per-subject bucket is a separate follow-up. Bootstrap and
standalone body caps remain bounded and unchanged. Unknown `kid` fails closed
until the bounded 300-second cache expires; refresh is a separate review decision.

Before operator-gated sync, verify the live staging issuer without exposing tokens,
confirm prod hosts, mirror inventory and executor egress, and retain the live
standalone ConfigMap SHA256/diff and rollback content as an artifact. The route
fixture derives from base kind routes, not a live capture. The managed render
omits `llmwiki-s2-mongo-jwt`. Preserve Secret-sourced gateway trust and External
Secrets/OpenBao gates. Verify CRUD, isolation, rejected tokens, scope/429 and
plugin loading after rollout.

No deployment, push, merge, credential access or cluster mutation was performed.
