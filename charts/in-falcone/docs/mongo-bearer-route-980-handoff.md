# Mongo bearer route #980 deployment repair handoff

This addendum-12 repair extends deployment head
`ef5a926bcfadf3a2e6d9136dd44bda1db221eca6` on assigned branch
`agent/falcone/980/5fcefe28-5a92-5e96-a3cd-6b1369cd20d6` and pairs with
source repair `49d18d6a`. The entry worktree was clean. The existing route,
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
also align with both source provisioning paths and reconciliation. For a custom
audience, release review must supply the same `KEYCLOAK_TENANT_AUDIENCE` to the
control-plane provisioner and reconciliation environment. Kind's external route
ConfigMap must also use the custom value if kind overrides the default.

## Reviewed baseline changes

Only the two permitted render baselines change:

- `tests/blackbox/fixtures/umbrella-default-render.sha256`: deployment entry
  `f74e1c505429b9823f5a352488ffafa674aa4af0d48b85b88cead3154cdba4fa`,
  repaired `5ca1986297dc0c39ebd98ce720d3d352ddb7b2bacc79555bc1c0c3eeb1d3579a`.
- `tests/flow-audit-chart.test.mjs`: deployment entry prior-object baseline
  `362fb0be45c9d0cdbc6982367ce82a5319f4a43ae6c138e3aaf0a21069e38cca`,
  repaired `11bba368262a4c704b0d2ebc84d14f8d316632e1af53bf5c8718c11601247034`.

A parsed default-render comparison against the entry commit confirms unchanged
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
   all relevant tenant-app clients have the matching mapper and zero repairs
   on repeat. Confirm provisioning retry tests and required additional callers
   such as console/service-account clients have audience preparation.
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
Local results: Mongo chart 13/13, flow-audit 7/7, default umbrella baseline 1/1,
source route/parity 5/5, staging/OpenShift scoped checks 2/2, and strict Helm
lint for default, prod, staging, kind, airgap and OpenShift pass. The separate
Node numeric-identity suite requires the absent `yaml` package; its native run
is deferred to CI. Mongo chart identity assertions pass without that dependency.
LuaJIT is absent; its verifier matrix remains a required PR CI gate. Live kind
CRUD/isolation/API-key/429, frozen-dependency gateway-policy contracts, full
staging-infrastructure contracts and image builds/scans remain PR CI/release
gates. Supplemental local checks never replace those gates.

Both source `FALCONE_CHARTS_REF` pins equal the entry deployment head
`ef5a926bcfadf3a2e6d9136dd44bda1db221eca6`.
Current state: **pin pending deployment repair**.
After the single additional deployment commit, the next
source maker must set both pins to that exact final head, update its baseline
records and rerun parity. This deployment-only work does not edit source files;
no extra deployment commit is needed to record the source pin refresh.
The supplied addendum is truncated; release review retains that open question.

No deployment, push, merge, credential access or cluster mutation was performed.
