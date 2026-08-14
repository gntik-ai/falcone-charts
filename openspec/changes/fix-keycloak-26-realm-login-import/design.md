## Context

The chart intentionally authors realm login policy as a nested values group, while Keycloak 26's `RealmRepresentation` accepts the same five booleans only as top-level properties. The implementation now normalizes both the realm-create and bounded login-reconciliation payloads at that chart-to-provider boundary. The one-shot hash remains derived from values rather than template output, so login reconciliation runs unconditionally in the upgrade-safe phase even when an existing matching marker skips realm creation.

Code-grounded boundaries:

- `charts/in-falcone/values.yaml::bootstrap.oneShot.keycloak.realm.login:434-469` authors the nested values API.
- `charts/in-falcone/values.schema.json::bootstrap.oneShot.keycloak.realm.login:1541-1590` requires the non-null nested object, requires all five booleans, and rejects additional nested keys.
- `charts/in-falcone/templates/bootstrap-payload-configmap.yaml::realm.json,login.json:1-35` omits both chart-only wrappers, lifts their provider fields, and emits the minimal login update payload.
- `charts/in-falcone/templates/validate.yaml::in-falcone.validate:10-16` rejects any duplicate nested/top-level login representation before rendering resources.
- `charts/in-falcone/templates/bootstrap-script-configmap.yaml::ensure_keycloak_realm,ensure_keycloak_login_settings:120-210` creates with the normalized payload, performs bounded login PUT/GET convergence, and never prints realm response bodies.
- `charts/in-falcone/templates/bootstrap-script-configmap.yaml::run_upgrade_reconciliation,main:572-650` performs reconciliation even when create-only work is skipped and writes the marker only after later verification succeeds.

## Goals / Non-Goals

**Goals:**

- Normalize the supported nested values representation into the exact Keycloak 26 wire representation at render time.
- Detect invalid or ambiguous input before the bootstrap Job can mutate Keycloak.
- Reconcile existing realms on every upgrade-safe run without destructive recreation and verify convergence before success.
- Preserve the current Secret-reference boundary and produce only secret-safe diagnostics and evidence.
- Make corrected retry, rollback, fail-forward, black-box testing, live verification, and cleanup behavior explicit.

**Non-Goals:**

- Changing the public values API from the nested `realm.login` group.
- Generalizing arbitrary nested realm groups or changing unrelated realm, client, role, user-profile, brute-force, or APISIX behavior.
- Migrating, deleting, exporting, or recreating an existing Keycloak realm.
- Adding a new Keycloak version or external dependency.

## Decisions

### 1. Normalize the five allowlisted properties at the chart-to-Keycloak boundary

Build `realm.json` from a deep copy of the authored realm after omitting both `login` and `bruteForce`. Restore the chart's historical non-overwriting precedence in two explicit phases: merge the nested brute-force partial into the base realm, then merge the five allowlisted login properties into that result. This preserves an existing non-zero top-level provider property such as `failureFactor: 99` instead of overwriting it with a nested partial value such as `10`. Also render a minimal login reconciliation payload containing the realm identifier plus exactly those five top-level booleans. Neither payload contains the `login` wrapper.

This keeps comments and grouping in values while producing the wire shape Keycloak owns. An allowlist prevents accidental promotion of an arbitrary nested key. `mergeOverwrite` was rejected after review because it reversed historical precedence and silently changed unrelated realm policy; a boolean `false` was not a sufficient oracle for the non-zero merge rule, so compatibility is proven with a distinct non-zero numeric value. Flattening the values API was also rejected because it would impose an unnecessary configuration migration and create upgrade ambiguity.

### 2. Combine schema validation with explicit conflict detection

Require the nested `login` object itself, retain its required-boolean and no-additional-property rules, and rely on object typing to reject explicit null. Independently inspect the realm object at render time and reject any of the five same-named top-level properties before manifests are emitted, even when `login` is absent or null and whether a direct value would match or conflict with a nested setting. The diagnostic names both configuration paths but not either value, and the nested API remains the single supported source of truth.

Schema validation alone cannot reject duplicate top-level properties because the surrounding realm object intentionally permits other Keycloak fields. Accepting even an equal duplicate was rejected because two authoring paths create future precedence ambiguity; silently preferring one side could hide drift and change authentication policy.

### 3. Separate create from idempotent login reconciliation

Keep the existing realm existence/create step for a fresh install. Add login reconciliation to the upgrade-safe phase so it runs even when a matching one-shot marker skips create-only work. The reconciliation obtains an admin token, applies the minimal top-level login payload to the existing realm, then reads the realm back and compares all five values. A concurrent-create response is not sufficient evidence by itself; the same reconciliation and read-after-write check must still converge.

A minimal realm update avoids carrying users, roles, clients, sessions, or unrelated policy into the write and never deletes or recreates the realm. Create-only flattening without an upgrade reconcile was rejected because it leaves existing or drifted realms untouched and a chart-only fix may not change the values-derived marker hash.

### 4. Treat realm compatibility as a phase gate with no automatic compensation

Any unexpected HTTP status, transport failure, or read-after-write mismatch terminates the Job before later bootstrap work, final verification, or marker creation. Every realm discovery, create, login PUT, login GET, and drift diagnostic identifies the target realm and tells the operator to correct or resolve the condition and retry to fail forward safely. The process never logs the Authorization header, token, credential-bearing environment, decoded Secret, or an untrusted response body that could echo sensitive material; it never issues DELETE or automatic rollback as remediation.

The controller does not delete a newly created realm or reverse an existing realm update after a later failure. A failed clean create leaves no realm and no marker, so a corrected retry safely re-enters the create-only path. If a realm was created or updated before a later gate failed, a fail-forward rerun uses the idempotent existence and reconciliation checks. Rollback is documented only for cases where the previous chart remains compatible with an already usable realm.

### 5. Bind executable evidence to the normative scenario names

Helm-render tests cover payload shape and validation. Process-isolated black-box tests execute the rendered public bootstrap program against a fake HTTP interface to prove request ordering, existing-realm preservation, failure gating, marker behavior, and secret-safe output for the first six scenarios. A separate disposable Keycloak 26 acceptance run proves the actual import and bootstrap-principal authentication behavior, records sanitized diagnostics and cleanup proof, and removes its credentials and persistent state.

This division keeps fast deterministic regression coverage while retaining one real compatibility check. Render-only coverage was rejected because it cannot demonstrate Keycloak acceptance, reconciliation convergence, authentication, or cleanup.

## Implementation Evidence

Evidence recorded on 2026-08-14 establishes the following completed scope:

- The implemented schema requires `bootstrap.oneShot.keycloak.realm.login` to be present and non-null, requires all five boolean children, and rejects additional nested keys. The renderer preserves that nested source of truth and emits both `realm.json` and `login.json` with the five booleans at the Keycloak top level. Independent pre-render validation rejects any of those five names authored directly under `realm`, including when `login` is absent or explicitly null and whether the direct value matches or conflicts.
- The implemented upgrade-safe path unconditionally issues one bounded realm-login PUT, accepts Keycloak success statuses 200 or 204, follows with one GET, and uses an exact five-field comparison. Transport errors, PUT/GET status failures, and value drift stop the program before later authentication verification or marker creation; provider response bodies are not printed.
- The original focused black-box contract was green at 11/11. Reviewer-added tests bbx012 (`explicitly null nested login authoring fails before Helm emits a manifest`) and bbx013 (`top-level-only login authoring cannot replace the required nested source of truth`) established a tests-only RED phase before the correction: 19 total, 17 pass, 2 fail. After the schema and unconditional top-level rejection correction, the single expanded focal run passed 19/19 with fail/cancelled/skipped/todo all 0, exit 0, duration `14599.367914 ms`; three JavaScript syntax checks and the test diff check also passed.
- The expanded focal executes the fresh create paths rather than only inspecting rendered control flow: bbx014 proves GET 404 → POST 201 → mandatory login PUT/GET → verification → marker; bbx015 proves concurrent POST 409 is not convergence evidence and still requires the same PUT/GET gate. bbx016-bbx019 execute initial realm GET and create transport/status failures twice each, proving bounded secret-safe errors, no destructive action, no later phase or marker, and identical retry interactions while no marker exists.
- An earlier pre-blocker baseline render was repeated three times with digest `6aff492c5d342157e0205e259a2c62a8f7f2eb5ba4342174b56de95550a8b157`; the focal comparison passed 1/1. This is retained as historical evidence for that revision and is superseded by the post-blocker rendered digest recorded below.
- Before the reviewer correction, the authoritative full black-box gate ran exactly once and unfiltered as `bash tests/blackbox/run.sh`: 19 files and 418/418 tests passed; fail, cancelled, skipped, and todo were all zero; exit status was 0; duration was `1646120.800029 ms`. Worktree status was identical before and after the gate and the run left no artifacts. This remains valid historical evidence for that revision but is not the final full-suite gate for the corrected current diff.
- After the reviewer correction, the definitive global gate ran exactly once and unfiltered as `bash tests/blackbox/run.sh`: 19 files and 426/426 tests passed; fail, cancelled, skipped, and todo were all zero; exit status was 0; duration was `1661234.020453 ms`. The Keycloak focal contributed 19/19 passes, including bbx012 and bbx013. Branch and HEAD were identical before and after at `fix/keycloak-26-realm-login-import` / `8f6311741d137cb1f9a7571dd02073c8b0a89b67`; `git status --porcelain=v1 -z --untracked-files=all` was 964 bytes with SHA-256 `65b672eb8f5c14e48448960b358e90750ce79b9ef41183aa882a13ef0fc73d34` both before and after. The gate left no artifacts or edits and did not access a cluster.
- A later independent review returned `REQUEST_CHANGES` for two blockers. First, the initial `mergeOverwrite` normalization broke historical non-zero precedence: bbx020 demonstrated that a base top-level `failureFactor: 99` must survive a nested partial value of `10`, while a boolean `false` was not a valid merge oracle. Second, realm discovery/create and login reconciliation/drift diagnostics lacked both the target realm identifier and actionable recovery guidance.
- Reviewer tests bbx020-bbx027 established a tests-only RED phase before the blocker fixes: 27 total, 19 pass, 8 fail, exit 1, duration `18853.28513 ms`. The product correction restored historical merge behavior in two phases and added realm ID plus explicit correct/resolve/retry/fail-forward guidance to transport, status, and drift errors without printing response bodies or secrets and without DELETE or rollback behavior.
- The independent post-fix focal ran exactly once and passed 27/27 with exit 0 and duration `19027.946618 ms`. Three JavaScript syntax checks and the diff check passed, as did chart lint, rendered Bash validation, and strict OpenSpec validation. bbx020 proves non-zero precedence; bbx021-bbx027 prove bounded actionable diagnostics across realm GET/create transport and status failures plus login PUT/GET/drift failures.
- The first post-blocker global gate then ran exactly once and unfiltered: 19 files, 434 tests, 433 pass, 1 fail, fail-only `bbx-8-003`, cancelled/skipped/todo all 0, exit 1, duration `1670159.135008 ms`. Keycloak passed 27/27, including bbx020-bbx027. Pre/post NUL porcelain status was identical at 964 bytes with SHA-256 `65b672eb8f5c14e48448960b358e90750ce79b9ef41183aa882a13ef0fc73d34`. The only mismatch was the deterministic umbrella render baseline: fixture expected `6aff492c5d342157e0205e259a2c62a8f7f2eb5ba4342174b56de95550a8b157`, while the current corrected render produced `f2fa87f5785e25534ddb4c97013ece1464f2f8fd098a527834e6f178f5929cbf`.
- Before changing the fixture, three isolated baseline processes used an overlay candidate containing `f2fa87f5785e25534ddb4c97013ece1464f2f8fd098a527834e6f178f5929cbf`; each passed 1/1 with durations `15473.378687 ms`, `15476.613765 ms`, and `15461.298514 ms`. They proved the default render still equals the explicitly disabled render, emits zero optional wiring, and leaves source archives unchanged. Exactly one baseline fixture was then updated. The real post-update focal passed 1/1 with exit 0 and duration `15187.96846 ms`; JavaScript syntax, formatting, and diff checks passed.
- The definitive post-baseline global gate then ran exactly once, unfiltered, and without retry as `bash tests/blackbox/run.sh`: 19 files, 434/434 tests passed, fail/cancelled/skipped/todo all 0, exit 0, duration `1669954.154576 ms`, and the harness reported `black-box: PASS`. `bbx-8-003` passed against baseline `f2fa87f5785e25534ddb4c97013ece1464f2f8fd098a527834e6f178f5929cbf`; Keycloak passed 27/27 including bbx020-bbx027. Branch and HEAD were identical pre/post at `fix/keycloak-26-realm-login-import` / `8f6311741d137cb1f9a7571dd02073c8b0a89b67`; NUL porcelain status remained 964 bytes with SHA-256 `65b672eb8f5c14e48448960b358e90750ce79b9ef41183aa882a13ef0fc73d34`. The run produced no artifacts or edits and performed no cluster or Playwright activity.
- The final independent reviewer returned `VERDICT: APPROVE`, `BLOCKING: none`, and `CHAIN_STATUS: complete`. The review confirmed restoration of historical non-zero precedence (`failureFactor: 99` over nested `10`), bounded realm-specific correct/resolve/retry/fail-forward diagnostics, the independent 27/27 focal, and the authoritative 434/434 global gate. The reviewer sandbox could not rerun the process-isolated `bwrap` cases because user namespaces were unavailable; this was an environment restriction, not a product failure. Within that sandbox, chart lint, strict OpenSpec validation, rendered Bash, schema checks, JavaScript syntax, diff checks, and the baseline focal all passed.
- In the default K3s context, a disposable namespace reproduced the pre-fix defect: POSTing the current nested payload returned 400 with `unable to read contents from stream`, while the normalized control payload returned 201. The post-fix exact rendered payload returned POST 201, two idempotent PUT 204 responses, and an exact read-back that preserved realm identity, display name, enabled state, and brute-force policy; bootstrap-admin authentication returned 200.
- The disposable namespace, Secret, workload, and state were removed after live verification, and the shared staging installation remained unchanged. Operator and release guidance was updated for compatibility, recovery, verification, and cleanup.
- The complete disposable Helm clean-install gate is not complete. It is blocked by independently confirmed E6-high defect `P18:helm-clean-install:temporal-post-install-namespace-readiness-cycle`: chart `0.4.19` release revision 1 remains `pending-install` under `--wait` because `workflow-worker` is 0/2 while requiring `falcone-flows`, whose sole creator is a post-install Temporal hook that never starts during the wait cycle. Keycloak and Temporal frontend both reached 1/1, but the Keycloak bootstrap hook and success marker were never reached. This blocker is independent of the Keycloak realm-login patch and is assigned to separate remediation.

The evidence boundary is deliberate: the corrected schema/validation contract, historical non-zero realm precedence, exact rendered Keycloak representations, authentication contract, actionable bounded failures, independent 27/27 focused suite, updated deterministic baseline, definitive 434/434 unfiltered post-baseline gate, and final independent reviewer approval are proven. The first failed post-blocker gate remains recorded because it isolated the stale baseline oracle and led to the independently validated fixture update. The complete Helm clean-install bootstrap Job and marker remain blocked only by the independent Temporal hook/readiness defect; this is an archive/release gate and not a blocker for opening the draft PR. That single gate stays open in `tasks.md`.

## Risks / Trade-offs

- [Risk] A minimal realm update could behave differently across Keycloak patch releases. → Pin the supported Keycloak 26 image in live acceptance, verify with a read-after-write GET, and fail closed on any mismatch.
- [Risk] A realm may be created before a later reconciliation or bootstrap phase fails. → Never write the completion marker on failure; preserve the realm and make the next run converge idempotently instead of deleting state.
- [Risk] A raw Keycloak error body could include sensitive or attacker-controlled text. → Do not print untrusted response bodies from authenticated realm operations; emit bounded operation and status diagnostics.
- [Risk] Changing merge primitives while lifting nested partial settings can silently alter unrelated realm policy. → Preserve the historical non-zero base-realm precedence in two phases and retain a numeric non-zero compatibility oracle in black-box coverage.
- [Risk] Strict duplicate detection can reject previously tolerated top-level overrides, including equal duplicates. → Report the exact configuration paths without their values and direct operators to keep only the nested source of truth.
- [Risk] The independent Temporal post-install namespace-readiness cycle prevents the disposable Helm install from reaching the Keycloak bootstrap hook. → Keep the Keycloak clean-install gate open, remediate `P18:helm-clean-install:temporal-post-install-namespace-readiness-cycle` separately, then rerun the same clean-install acceptance without attributing this blocker to the realm-login patch.
- [Trade-off] Reconciliation adds an authenticated update and read on each upgrade-safe bootstrap. → Accept the small control-plane cost to guarantee observable convergence even when create-only work is skipped.

## Migration Plan

1. Add render-time normalization and conflict checks while retaining the nested values schema and defaults.
2. Add the minimal top-level login reconciliation payload and the upgrade-safe reconcile/read-back gate.
3. Add Helm and process-isolated black-box tests named for scenarios 1-6, including sentinel-secret output scans and retry/marker assertions.
4. Add operator guidance for detection, safe retry, conditional rollback, fail-forward verification, and cleanup without example secret values.
5. Run the disposable Keycloak 26 scenario with unique Secret-sourced credentials; retain only sanitized results and cleanup proof.
6. Release normally. Failed fresh installs fail forward by correcting values and rerunning. Existing installations may roll back only when their realm is already usable by the previous chart; otherwise they fail forward so reconciliation can converge.

Rollback does not delete or revert Keycloak state. After either path, verify the five realm login properties, bootstrap-principal authentication, Job result, and marker state before declaring recovery complete.
