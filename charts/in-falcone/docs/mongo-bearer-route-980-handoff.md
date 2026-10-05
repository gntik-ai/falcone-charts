# Mongo bearer route #980 deployment repair handoff

## Validate repair on entry 74e073e (2026-10-02)

This continuation starts from clean assigned deployment HEAD
`74e073e156c710eea0e68ae5a9d6de8a31484810` on the branch recorded below,
paired with source HEAD `f047ce888da07c2f5aac2f9ab7fd9ef9209a405e`.
This section supersedes the entry identity and fresh validation claims below;
earlier evidence remains attributed to its preceding continuation.

The validate failure at `bbx-temporal-bootstrap-048` is caused by #980's new
required top-level `gateway` schema property. Helm `--reuse-values` retains
the stored chart defaults; revision `41922e9d` has neither `gateway` nor
`gatewayPolicy.issuerJwksAuth`. Its schema failure precedes template rendering.
Removing just that root requirement also exposes template accesses to the
absent verifier configuration, so both layers need compatibility handling.

The schema continues validating every explicit Mongo configuration block and
requiring both audience fields. The shared settings helper supplies defaults
only when **both** new blocks are absent: `falcone-data-api`, enforcement
`true`, the stored OIDC issuer/realm, the release-local Keycloak JWKS host,
and the existing bounded cache/timeouts. A malformed stored issuer fails
closed. Explicit or partially migrated configuration never receives these
defaults; absent/empty audiences, invalid flags and missing verifier settings
still fail rendering. The runtime policy and executor ConfigMap use the same
resolved settings. The existing historical upgrade test gains assertions for
the rendered executor configuration, and the Mongo suite now rejects either
missing block in an otherwise current configuration. No CI job or assertion
is removed or narrowed.

Fresh evidence:

- Mongo chart and flow-audit suites pass **22/22**, using
  `node --test --experimental-test-isolation=none` with their two existing
  repository test paths. No supplemental dependency loader is needed.
- Strict Helm lint passes for default, staging, prod and kind. Node syntax
  checks for both edited tests and `git diff --check` pass.
- The real `41922e9d` defaults, extracted from the assigned repository,
  reproduce the entry schema failure. Rendering the repaired chart with those
  defaults passes the upgrade backup/parity gates and produces audience
  `falcone-data-api` with enforcement `true`. A stored custom issuer is
  respected; a custom legacy Temporal image still fails closed with no output.
  These are supplemental deterministic Helm renders, not a claim of a live
  upgrade or of completing the original fake-API test.
- Default Helm output is byte-identical to entry `74e073e`; the umbrella and
  flow-audit baselines, APISIX identities, overlays, routes, images and all
  environment values stay unchanged. No re-baseline is needed.
- The original `bbx-temporal-bootstrap-048` command cannot complete here:
  the pinned `yaml` dependency is absent, GNU tar extraction returns
  `Function not implemented`, and a supplemental run using installed YAML
  2.9.1 and BusyBox tar times out at archive extraction within 60 seconds.
  The original test with frozen YAML 2.8.3 remains a required CI check.
- The revision-24/packaged-recovery group was attempted with a 90-second
  timeout; it could not complete in this sandbox. Archive extraction returns
  `Function not implemented`, and recovery stops at `REPAIR_PACKAGE_PULL_FAILED`
  before the expected assertions. These are unavailable sandbox prerequisites,
  not reproduced chart regressions. Full recovery, LuaJIT verifier
  tests (runtime absent), offline OCI/schema priming and full black-box CI,
  image builds/scans and live rollout checks remain CI/release checks.

Historical `--reuse-values` preserves historical component/route wiring.
Operators must apply the reviewed environment values for the #980 rollout;
the compatibility render does not prove installation of the new plugin mounts
or route on an old release. Staging enforcement remains false until the
documented reconciliation and later values revision. Prod hosts remain an
operator release gate. The control-plane tenant verifier remains a follow-up.
Addenda 14/15 defer the kind bearer round trip and integration PR trigger to
#1051; the source kind round-trip task must stay unchecked.

Both source pins currently match entry `74e073e`: **pin pending deployment
repair** until this additional local commit is final. The next source maker
must update both `FALCONE_CHARTS_REF` pins to the resulting deployment head.
No source file, deployment, push, merge, credential or live cluster is touched.

This deployment review extends the supplied deployment head
`f8370ca13edd0117a70afa922278791964d29fb8` on assigned branch
`agent/falcone/980/5fcefe28-5a92-5e96-a3cd-6b1369cd20d6` and pairs with
source continuation `f1d90d8bd968b43ee00a9dfe6565ec0b2e653e79`
(the supplied source maker result). The entry worktree was
clean and its path, branch and Git metadata match the assigned lease. The supplied
implement-issue contract, OpenSpec, acceptance criteria and R2 policy bound this
review. This continuation corrects rollout guidance and records fresh evidence;
no runtime, chart values, images, migration contracts or fixtures change. The
existing route, policy, managed ConfigMap, mounts and API-key protections are preserved.

The previously repaired `APISIX_RENDER_CONVERGENCE_DRIFT reason=contract`
occurred because the preceding repair made the config-copy root filesystem
read-only without updating the migration's exact render expectation. Entry
commit `f8370ca13edd0117a70afa922278791964d29fb8` added that required field to
the revision-20 render contract and revision-23 synthetic render. Fresh scoped
checks retain that repair. The exact comparison remains fail-closed;
no chart values, images, numeric identities or baselines change here.

## Tenant audience enforcement

`gateway.mongoBearer.tenantAudience` defaults to `falcone-data-api`.
`gateway.mongoBearer.enforceTenantAudience` is true in default and kind;
prod inherits true. Staging explicitly sets false until reconciliation evidence
permits a follow-up values revision. The chart validates a nonempty audience and
a boolean flag, then feeds identical settings to bootstrap route 2006, managed
standalone route 2006 and the executor ConfigMap as `KEYCLOAK_TENANT_AUDIENCE`
and `KEYCLOAK_ENFORCE_TENANT_AUDIENCE`. Canonical kind routes match the source
file byte-for-byte and enforce the default audience.

The Lua verifier requires an exact string `aud` or array member for tenant
realms when enforcement is true. Missing/wrong audience and `azp` substitution
return 401 before JWKS lookup. Empty/absent configured audience cannot match
any token, including a token without `aud`; schema/render validation also
rejects this configuration. Explicit false supports the documented migration.
The platform audience rule, trusted issuer selection and bounded cache remain
unchanged. The Lua test matrix replaces the former wrong-audience acceptance
assertion and retains rejection/cache coverage.

Executor enforcement covers every tenant-token executor route. Default audiences
also align with both source provisioning paths and reconciliation. Source
`apps/control-plane/b-handlers.mjs` now ensures the audience mapper immediately
after creating a service-account client, before persisting the service account.
`scripts/backfill-tenant-realm-audience.mjs` reconciles clients marked
`in-falcone.kind=tenant-app` or `in-falcone.kind=service-account`, listing mappers
before adding a missing mapper. Service-account preparation is mandatory for
Mongo, events and functions because they share the executor verifier. Keep
`tenantAudience` at `falcone-data-api` for this ChangeSet. The source deployment
validation gate rejects overrides until the control-plane provisioner and kind's
external route ConfigMap consume the configured audience. Passing a custom value
only to the gateway and executor would break parity with those callers. Custom
audience support requires a later paired change; do not bypass the existing gate.

## Reviewed baseline changes

The preceding KSV-0014 repair updated only the two permitted render baselines;
this continuation retains those hashes:

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: deployment entry
  `5ca1986297dc0c39ebd98ce720d3d352ddb7b2bacc79555bc1c0c3eeb1d3579a`,
  repaired `9208d166e3276b32638e21d6a6e8ccf36495e01167a8d0c72368f9af9f21f45f`.
- `tests/flow-audit-chart.test.mjs`: deployment entry prior-object baseline
  `11bba368262a4c704b0d2ebc84d14f8d316632e1af53bf5c8718c11601247034`,
  repaired `8c7bcb9137c9ab34847dc54a1e845da6173737cfcff31a38769ef488bf76399d`.

A parsed default-render comparison confirms unchanged object inventory and
exactly one added field: the APISIX config-copy init container's
`securityContext.readOnlyRootFilesystem: true`. Removing that field reproduces
both entry hashes and the exact entry APISIX Deployment. The umbrella baseline
covers every rendered object; the flow-audit prior-object baseline includes this
Deployment too, so both hashes must change. Flow-audit objects, rules and
assertions remain unchanged. No other
fixture is re-baselined. The pre-980 route fixture and canonical hash stay
immutable; the snapshot check removes only the explicit audience fields,
previously reviewed API-key header removals and Mongo upstream comment fix.
The source maker must update its tasks/handoff baseline records to these final
hashes when refreshing the paired pins; all earlier baseline records are
superseded.

## Preserved safety and release gates

APISIX container UID/GID 636, inherited fsGroup 1001, staging pod identity and
OpenShift SCC behavior retain the main contracts. The previously reviewed
BusyBox overlay digest, registry handling and airgap mirror are unchanged;
release review still verifies mirror inventory. No image references change.
The BusyBox config-copy init container now uses a read-only root filesystem in
default (inherited by prod and kind), staging and airgap. Its only write remains
the existing writable emptyDir at `/apisix-config-overlay`; its ConfigMap source
stays read-only. OpenShift retains the new flag while stripping numeric IDs.
The main APISIX process's filesystem contract remains unchanged.

Staging issuer remains `https://iam.baas.musematic.ai` without `/auth`, with
JWKS at `http://falcone-keycloak:8080`. Other `gatewayPolicy.oidc` settings stay
unchanged. Prod hosts remain documented placeholders and must be supplied
before rollout: enabling executor verification against the placeholder would
reject prod bearer traffic. Tenant JWKS fetches require executor egress to the
public environment issuer host, including `iam.baas.musematic.ai` in staging.

Keep Secret-sourced gateway trust, External Secrets/OpenBao and all migration,
backup, ownership and evidence gates. API-key route 2006-key and its per-key
rate limits/scopes stay unchanged. Bearer limiting retains its shared-IP
fallback as a separate follow-up. Unknown-kid refresh remains out of scope.
Release review must confirm strictly named non-tenant realms cannot reach
tenant data through the existing issuer/workspace binding.

## Mandatory staging rollout order (operator execution only)

1. Keep staging enforcement false and `tenantAudience` at `falcone-data-api`.
   Validate every ordered values layer with source
   `node scripts/validate-deployment-chart.mjs --values <layer> ...`, preserving
   the custom-audience rejection gate. Capture a redacted live standalone ConfigMap
   SHA256/diff and rollback artifact; confirm the rendered routes omit
   `llmwiki-s2-mongo-jwt` and match the canonical table plus this repair.
2. With the existing Secret-backed kc-admin environment, run source
   `node scripts/backfill-tenant-realm-audience.mjs` (dry run), then the same
   command with `--apply`, then `--apply` again. Retain redacted reports proving
   all relevant tenant-app and service-account clients have the matching mapper
   and zero repairs on repeat. Verify freshly minted service-account tokens carry
   the audience and reach their Mongo, events and functions routes. Confirm both
   provisioning paths and service-account creation pass mapper retry tests.
   Review any additional executor callers, such as console clients, before
   enabling enforcement.
3. Only after successful reconciliation, make a follow-up staging values
   revision setting `gateway.mongoBearer.enforceTenantAudience: true`. Ensure
   both APISIX and executor pods reload the configuration during operator-gated
   sync: plugin/route subPath mounts and ConfigMap-backed executor environment
   do not automatically refresh running processes. Verify the rendered flags
   match and that new pods use them. Prod requires reconciliation and real
   hosts before its rollout because it inherits true.
4. Verify public-gateway CRUD, wrong/missing/azp-only audience 401s, direct
   executor 401s, unknown issuer and unauthenticated 401s, workspace A/B 403,
   API-key scope/rate-limit behavior and plugin loading. Roll back enforcement
   to false with pod reloads if needed; audience mappers may remain.

## Mandatory prod checklist: executor env transition (#1053)

1. Complete tenant-app/service-account audience reconciliation, fresh-token checks
   and a zero-repair repeat **before enforcement**. Prod inherits true; retain
   every existing backup, parity, migration and ESO/OpenBao gate.
2. Confirm **real production issuer/JWKS hosts** in the exact reviewed values.
   `https://iam.in-falcone.example.com` is a placeholder; `https://iam.baas.musematic.ai`
   is staging only. Prod hosts are not changed by this repair. Shared TLS JWT
   literals now populate the executor ConfigMap instead of duplicate env names:
   the transport overlay retains its effective HTTPS JWKS endpoint on port 8443,
   replacing the stored HTTP default. Verify the resolved executor scheme, host,
   port and path for the exact ordered values. Release review must acknowledge
   the ConfigMap representation change while retaining the effective TLS endpoint.
   The gateway verifier is unchanged.
3. From the clean exact target revision, use the one-time atomic executor JWT
   env step in [0.4.20 release notes](../RELEASE-NOTES-0.4.20.md). Run its dry-run
   and `--apply` with explicit context/release namespace and every ordered values
   layer after normal gated delivery reconciles the target executor ConfigMap.
   The helper cannot prepare a pre-#980 release before that ConfigMap exists.
   It checks all five keys without printing payloads, removes literals while
   adding references atomically, and preserves replicas/annotations/Service/
   ConfigMap. It is a no-op on migrated staging. Use the same step for affected
   Helm and Argo paths, then retry normal delivery. Never force the whole release.
4. Verify Available, five unique reference-only entries, resolved pod config,
   preserved replicas/annotations and an unchanged repeat. Complete the existing
   bearer CRUD/negative/isolation/API-key checks. Correct/retry forward, or use
   an operator-reviewed reapply of **only** the protected `433be51` executor render
   with actual old values and retained actor-managed fields. Keep JWT changes
   atomic and retain the Service and ConfigMap.

The dedicated CI `executor-env-upgrade-evidence` artifact records independent
Helm 3 client, Argo client and Helm 4 server results, atomic-step/retry outcomes
and revision/fixture hashes. Live evidence is required before release and not
claimed locally. Untouched `433be51` defaults lack direct issuer/audience env;
the reported-state regression explicitly layers the credential-free
`tests/blackbox/fixtures/executor-env-before-980.yaml` over that historical chart.
The live test isolates JWT env in a disposable readiness probe; it does not claim
a full platform install. No default fixture is re-baselined: the template change
filters shared TLS JWT literals only when the executor component env already
has same-name references, moving their effective values into its ConfigMap source.
Historical `--reuse-values` without those references retains its literals; it does
not install the new #980 wiring. Regression cases coalesce `433be51` prod-TLS and
kind-TLS values and verify JWKS plus any installed issuer/audience remain wired,
unique and unchanged. The helper and delivery still use reviewed target layers.
Prod-TLS and kind-TLS resolved endpoint comparisons
against deployment base `93ee9371` preserve HTTPS/8443 and gateway configuration.
Published notes are intact; shipping version and actual prod JWKS endpoint
remain release-review questions.
Hermes must set both source workflow pins to the final local deployment HEAD and
rerun `tests/blackbox/mongo-gateway-route.test.mjs` after this commit.

Bounded local #1053 checker repair evidence: all seven offline upgrade contracts pass,
including historical/default/staging/prod/prod-TLS/kind-TLS renders, base-to-target
resolved TLS JWT equality, HTTPS/8443, unchanged gateway/control-plane resources,
invalid TLS JWT source rejection and fake-client atomic/precondition checks. The
new reuse-values contract passes all four prod-TLS/kind-TLS cases with and without
installed issuer/audience literals; it rejects entry `f6a3d92` in all four cases
because effective JWT env disappears. It replaces the temporary chart's umbrella
defaults with coalesced historical values, retaining the existing required
identity-path migration to `/realms`, `/resources`, `/js` rather than bypassing
that validation gate.
The existing Mongo chart suite passes 15/15, strict Helm lint passes all six
default/staging/prod/kind/prod-TLS/kind-TLS profiles, and the unchanged Argo
equivalence command prints `OK`. Source Mongo route parity passes 6/6 at the
entry deployment HEAD `f6a3d92`; Hermes must refresh pins and rerun it against
the final follow-up commit. Diff hygiene passes. The required
`bbx-temporal-bootstrap-048` command was attempted but cannot import the pinned
Node `yaml` package; frozen dependency installation and that check remain PR CI
requirements. Kind is absent locally, so live outcomes remain the dedicated CI
gate. These sandbox limitations do not replace any existing release evidence.

## Validation and paired handoff

Fresh scoped evidence covers chart profiles, audience/flag parity and render overrides,
invalid configuration rejection, unchanged API-key routes, managed staging
route equality, BusyBox and APISIX/OpenShift identities. The two permitted
baseline suites were rerun for this continuation.
The Mongo chart, flow-audit and APISIX metrics suites pass all 22 tests,
including both retained baselines. Strict Helm lint passes for default, prod,
staging and kind. Bash and Node syntax checks pass for the existing repaired
migration and fixture respectively. Both checker-targeted revision-20 tests
pass again using isolated fake cluster clients (read-only dry run and confirmed
Phase B). Four selected revision-23 checks pass: exact apply, rejection of an
inexact confirmation before mutation, OpenShift identity behavior and recovery
dry-run admission. All recovery clients are isolated fakes, never live cluster
clients. The broader staging and revision-24 suites remain CI gates; this
continuation does not claim a fresh full-suite result or change their fixtures.

The fresh render run used a 90-second bound with
`node --test --experimental-test-isolation=none` and the Mongo chart, flow-audit
and APISIX metrics files. The two revision-20 and four revision-23 checks used
the same bound and runner with name filters in their existing contract files.
`git diff --check` passes. No supplemental dependency loader was used.

The preceding repair's offline Trivy evidence used embedded checks and confirmed no KSV-0014
on the config-copy init container in default, prod, staging, kind and airgap;
the default scan removed exactly that finding and introduced none. Existing
findings on other containers remain platform baseline concerns. The chart
suite also covers airgap and APISIX/OpenShift identities. The separate
Node numeric-identity suite requires the absent `yaml` package; its native run
is deferred to CI. Mongo chart identity assertions pass without that dependency.
LuaJIT is absent; its verifier matrix remains a required PR CI gate. Live kind
CRUD/isolation/API-key/429, frozen-dependency gateway-policy contracts, full
staging-infrastructure contracts and image builds/scans remain PR CI/release
gates. Supplemental local checks never replace those gates.

Both source `FALCONE_CHARTS_REF` pins match the entry deployment head
`f8370ca13edd0117a70afa922278791964d29fb8`. The supplied source maker already
verified route parity there. This required rollout-documentation commit advances
the deployment head: **pin refresh required against the final deployment head**.
The next source maker must set both workflow pins to that exact head and rerun
parity. The paired ChangeSet remains incomplete until that check passes. This
deployment-only work does not edit source files; no extra deployment commit is
needed to record the source pin refresh. Both permitted render baseline hashes
above remain unchanged.
The supplied addendum is truncated; release review retains that open question.

No deployment, push, merge, credential access or cluster mutation was performed.
