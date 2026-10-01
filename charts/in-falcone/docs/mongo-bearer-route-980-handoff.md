# Mongo bearer route #980 deployment repair handoff

This rollout handoff repair extends deployment head
`13fcbfee738d2dd49da3928831871fa0da469ace` on assigned branch
`agent/falcone/980/5fcefe28-5a92-5e96-a3cd-6b1369cd20d6` and pairs with
source repair `69337587783f5d706f5965882a554dcf1397a7c0`. The entry worktree was
clean. The existing route,
policy, managed ConfigMap, mounts and API-key protections are preserved.

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
Mongo, events and functions because they share the executor verifier. For a custom
audience, release review must supply the same `KEYCLOAK_TENANT_AUDIENCE` to the
control-plane provisioner and reconciliation environment. Kind's external route
ConfigMap must also use the custom value if kind overrides the default.

## Reviewed baseline changes

The preceding addendum-12 commit changed only the two permitted render baselines;
this handoff repair changes neither:

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: deployment entry
  `f74e1c505429b9823f5a352488ffafa674aa4af0d48b85b88cead3154cdba4fa`,
  repaired `5ca1986297dc0c39ebd98ce720d3d352ddb7b2bacc79555bc1c0c3eeb1d3579a`.
- `tests/flow-audit-chart.test.mjs`: deployment entry prior-object baseline
  `362fb0be45c9d0cdbc6982367ce82a5319f4a43ae6c138e3aaf0a21069e38cca`,
  repaired `11bba368262a4c704b0d2ebc84d14f8d316632e1af53bf5c8718c11601247034`.

A parsed default-render comparison in the preceding repair confirmed unchanged
object inventory and exactly four changed objects: the Lua plugin ConfigMap,
bootstrap route payload, executor JWT ConfigMap and executor Deployment.
Their tenant-audience verifier/configuration additions require both hashes to
change. Flow-audit objects, rules and assertions remain unchanged. No other
fixture is re-baselined. The pre-980 route fixture and canonical hash stay
immutable; the snapshot check removes only the explicit audience fields,
previously reviewed API-key header removals and Mongo upstream comment fix.
The source maker must update its tasks/handoff baseline records to these final
hashes when refreshing the paired pins; the earlier b19843c5/3abc15a2 records
are superseded.

## Preserved safety and release gates

APISIX container UID/GID 636, inherited fsGroup 1001, staging pod identity and
OpenShift SCC behavior retain the main contracts. The previously reviewed
BusyBox overlay digest, registry handling and airgap mirror are unchanged;
release review still verifies mirror inventory. No image references change.

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

1. Keep staging enforcement false. Capture a redacted live standalone ConfigMap
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

## Validation and paired handoff

Scoped evidence covers chart profiles, audience/flag parity and overrides,
invalid configuration rejection, unchanged API-key routes, managed staging
route equality, BusyBox and APISIX/OpenShift identities. The two permitted
baseline suites and source route/parity checks are rerun for this repair.
For this handoff repair, the Mongo chart and flow-audit suites pass, including
the unchanged default umbrella and flow-audit baselines. Source route/parity
passes 6/6 against the entry deployment head. Strict Helm lint passes for
default, prod, staging and kind. The chart suite also covers airgap and
APISIX/OpenShift identities. The separate
Node numeric-identity suite requires the absent `yaml` package; its native run
is deferred to CI. Mongo chart identity assertions pass without that dependency.
LuaJIT is absent; its verifier matrix remains a required PR CI gate. Live kind
CRUD/isolation/API-key/429, frozen-dependency gateway-policy contracts, full
staging-infrastructure contracts and image builds/scans remain PR CI/release
gates. Supplemental local checks never replace those gates.

Both source `FALCONE_CHARTS_REF` pins equal the entry deployment head
`13fcbfee738d2dd49da3928831871fa0da469ace`.
Current state: **pin pending deployment repair**.
After the single additional deployment commit, the next
source maker must set both pins to that exact final head, update its baseline
records and rerun parity. This deployment-only work does not edit source files;
no extra deployment commit is needed to record the source pin refresh.
The supplied addendum is truncated; release review retains that open question.

No deployment, push, merge, credential access or cluster mutation was performed.
