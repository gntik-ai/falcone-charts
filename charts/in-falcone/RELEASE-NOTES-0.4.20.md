# in-falcone 0.4.20 (next unpublished release)

## Executor JWT environment upgrade (#980, #1053)

#980 moved the executor JWT configuration to five reference-only entries in
`{release}-executor-jwt-config`. An existing Deployment with literal JWT env
can reject an apply that retains both `value` and `valueFrom`. Use the one-time
atomic env patch below **before delivering the target executor Deployment**.
Pause only the executor Deployment, then reconcile only the target executor JWT
ConfigMap through the gated Helm adapter, holding the installed executor pod
template unchanged. Dry-run and apply the atomic step before target delivery.
Keep the Deployment paused across delivery, rerun the atomic step to verify or
repair its merged env, then resume and wait for Available. This also protects
against a client merge driven by Helm's stored duplicate-name manifest. This
order applies to pre-#980 literals and to existing #980
prod-TLS/kind-TLS releases with duplicate `KEYCLOAK_JWKS_URL` entries. A successful
untreated delivery can still drop JWKS; do not deliver first and repair afterwards.
On migrated staging the step is a no-op after ConfigMap verification. Fresh
installs need no transition.

The chosen mechanism changes only the five executor JWT env entries in one
resourceVersion-fenced JSON Patch. It preserves non-JWT env, HPA-managed replicas,
other-manager annotations, the Service and ConfigMap. Removing the old value
and adding its reference happen atomically. The rollout pause prevents any later
client merge from creating a pod or ReplicaSet template without JWKS URL, issuer
or audience; the env is verified again before resume. This avoids whole-object replace's
field-loss risk. There is no permanent Argo replacement option; Helm remains the
deployment adapter and the helper renders the exact target chart checkout.
All migration, backup/parity, immutable-image and ESO/OpenBao gates still apply.

## Path evidence and limits

The mandatory `executor-env-upgrade` PR CI job records separate observed outcomes
for Helm 3.17.3 client upgrade, Argo-style client apply of a Helm-created Deployment
without a last-applied annotation, and Helm 4.1.4 upgrade with `--server-side=true`.
The `executor-env-upgrade-evidence` artifact records both revisions, client versions,
legacy values layer SHA256, each isolated untreated result, atomic-step result
and subsequent delivery. The test prints its SHA256. Consult those results to
decide which path needs the step; do not infer Helm's behavior from Argo's failure. Publication requires
the job. At least one untreated path must reproduce the reported API rejection;
all positive sequences must become Available, resolve all five references, preserve
replicas/annotations/Service/ConfigMap and be unchanged on a repeat step.
The matrix also exercises all three paths from the existing #980 deployment base
`93ee9371fdbd029ff49909ff1fb5c03eeff0ddae` with the prod-TLS layers and its actual
duplicate JWKS entries, without the pre-#980 literal fixture. It records accepted
but invalid JWT env separately from API rejections. The evidence's `justification`
ties the step requirement to each isolated untreated result and successful delivery.
Negative experiments use separate disposable namespaces. In the positive sequence,
the test captures historical ReplicaSets before preparation and checks every new
executor ReplicaSet, including superseded templates, after preparation, migration
and delivery/resume. Delivery must retain the pause, and the env must pass
verification before resume. Missing/duplicate JWT names or dual-field env in any
new ReplicaSet fail that sequence. An accepted invalid env result is defect
evidence only in a negative experiment.
Before release, record the six observed outcomes and artifact SHA256 in these
unpublished notes and the prod handoff; pending CI is not a successful outcome.

Untouched `433be51` executor defaults do **not** define direct issuer/audience env
(the TLS overlay adds literal JWKS only). The test renders that real chart with
`tests/blackbox/fixtures/executor-env-before-980.yaml`, an explicit credential-free
installed-values layer modeling the reported three literals. It does not claim
untouched historical defaults reproduce that installation. The disposable live
probe preserves rendered selectors, metadata and JWT env, substituting BusyBox
readiness/env checks for the application. It does not claim a full platform install
or bearer round trip. Live outcomes are pending CI, not claimed from this sandbox.
The probe manifests omit replicas so the simulated HPA retains ownership across
Helm 4 delivery without `--force-conflicts`. Replicas and other-manager annotations
are checked after both the atomic step and target delivery. This isolates JWT env
migration; it does not prove the full chart avoids unrelated SSA ownership conflicts.

## Operator order and step

Prerequisites: `python3` with **PyYAML**, `helm`, `kubectl`, and the clean target
checkout. Use the reviewed client versions and the same values as gated delivery.

1. Complete tenant-app and service-account audience reconciliation, idempotent
   rerun and fresh-token checks **before enforcement**. Prod inherits true.
   Retain every existing backup, migration, ownership, parity and validation gate.
2. Confirm **real production issuer/JWKS hosts** in the exact ordered values.
   `https://iam.in-falcone.example.com` is a placeholder; staging's
   `https://iam.baas.musematic.ai` is not a prod host. With executor transport TLS
   enabled, shared TLS JWT literals now populate the executor ConfigMap instead
   of appending duplicate env names. The production transport overlay's effective
   HTTPS JWKS endpoint on port 8443 is preserved; its stored ConfigMap value changes
   from the verifier's HTTP default to the previously effective TLS literal.
   Release review must explicitly acknowledge this ConfigMap representation change;
   the effective runtime endpoint is unchanged.
   Verify the resolved executor endpoint (scheme, host, port and path) for the exact
   ordered values before rollout. Gateway verifier settings and other components'
   TLS env remain unchanged. Without executor transport TLS, verifier values still
   supply the executor ConfigMap defaults.
3. Use a clean checkout of the full target deployment Git revision and the same
   tracked values layers in the same order as the gated delivery. Include reviewed
   host/evidence overrides in that revision. Historical `--reuse-values` remains
   supported: shared TLS JWT literals are retained unless the component already
   supplies a same-name `valueFrom` entry. Offline regression cases coalesce
   `433be51` prod-TLS and kind-TLS values, including installed issuer/audience
   literals, and verify their effective JWT env remains present and unique.
   Reusing those values preserves historical wiring; installing all five #980
   references still requires the reviewed target values. Render those exact layers
   for the helper and delivery. Retain a protected rollback
   render from `433be51` with the actual old release values and live replicas/
   annotations; never copy configuration/env payloads into release evidence.
4. Before target executor delivery, have the operator reconcile **only**
   `{release}-executor-jwt-config` through the gated Helm adapter from that exact
   target render. First pause only the executor Deployment, keeping serving
   pods running. Keep that pause through target delivery and verification:

   ```sh
   kubectl --context "$CONTEXT" --namespace "$NAMESPACE" \
     rollout pause "deployment/$RELEASE-control-plane-executor"
   ```

   The reviewed preparation plan must hold the installed executor
   pod template unchanged, and must not deliver other target resources. For a
   pre-#980 release this creates the ConfigMap; for existing #980 TLS it updates
   the stale HTTP default to the already effective HTTPS endpoint. Do not use a
   normal full-release upgrade/sync as preparation: that could deliver an invalid
   executor template before the step. If the adapter cannot isolate preparation,
   stop for release review rather than delivering the executor first.
   The helper never creates/changes the ConfigMap or reads a Secret. It compares
   all live data with the exact target render in-process, requires all five keys
   to be nonempty, and fails before dry-run, mutation or rollout on any mismatch,
   even when the env is already migrated. Only statuses are printed.
5. From that checkout run a server-side dry-run, then `--apply`, with an explicit
   context and release namespace. This **prod example** must include every actual
   additional values layer; prod.yaml alone has placeholder hosts and is insufficient.

   ```sh
   TARGET_REVISION="$(git rev-parse HEAD)"
   python3 charts/in-falcone/migrations/executor-jwt-env-upgrade.py \
     --revision "$TARGET_REVISION" --context "$CONTEXT" \
     --release "$RELEASE" --namespace "$NAMESPACE" \
     --values charts/in-falcone/values/prod.yaml \
     --values "$REVIEWED_PROD_VALUES_LAYER"
   python3 charts/in-falcone/migrations/executor-jwt-env-upgrade.py \
     --revision "$TARGET_REVISION" --context "$CONTEXT" \
     --release "$RELEASE" --namespace "$NAMESPACE" \
     --values charts/in-falcone/values/prod.yaml \
     --values "$REVIEWED_PROD_VALUES_LAYER" --apply
   ```

   For staging use its three Argo layers in README order; for Helm use that release's
   exact ordered layers. The same helper completes before target executor delivery
   through the gated adapter, including on existing TLS releases. It mutates only
   `{release}-control-plane-executor`, checks reference-only env and retained
   replicas/annotations. While paused, `--apply` verifies env without waiting for
   a rollout and prints `EXECUTOR_UPGRADE_APPLIED_PAUSED` or
   `EXECUTOR_UPGRADE_UNCHANGED_PAUSED`; it never resumes the Deployment.
   Kubernetes' controller-owned Deployment revision annotation may advance. A concurrent change fails the
   resourceVersion test: recheck live state and retry instead of bypassing the fence.
6. After the atomic env step verifies, run the normal gated target delivery
   **while the executor remains paused**. Check that delivery retained the pause;
   rerun the same dry-run and `--apply` commands before resuming. This repairs any
   JWT name removed by a merge based on the historical Helm manifest without
   creating a pod or ReplicaSet with missing JWT config. A failed delivery or
   helper check must leave the executor paused; fix and retry forward.
   Once the helper confirms five unique reference-only entries, resume only that
   Deployment and wait for rollout:

   ```sh
   kubectl --context "$CONTEXT" --namespace "$NAMESPACE" \
     rollout resume "deployment/$RELEASE-control-plane-executor"
   kubectl --context "$CONTEXT" --namespace "$NAMESPACE" \
     rollout status "deployment/$RELEASE-control-plane-executor" --timeout=300s
   ```

   Rerun the helper after rollout, then existing #980 bearer/isolation checks.
   Verify five unique reference-only entries, pod config readiness, Available,
   replicas/annotations, and `EXECUTOR_UPGRADE_UNCHANGED` on repeat. Retain only
   statuses/hashes. ConfigMap-only changes do not refresh running env: later audience
   enforcement changes still need the existing APISIX/executor reload procedure.
   If Helm 4 reports a conflict on HPA-managed `spec.replicas`, the env step cannot
   resolve replica ownership. Reconcile only the executor's desired replica count
   with its HPA owner: set `controlPlaneExecutor.replicas` to the current count in
   the reviewed tracked target values, re-render, and retry with those same layers
   without `--force-conflicts`. Matching values permit SSA without overriding that
   count. Any lasting ownership handoff remains an operator rollout decision;
   never force conflicts for the whole release to recover this env transition.

## Failure and rollback

Missing, empty or mismatched ConfigMap data, invalid env, dirty render input or
wrong revision fails before mutation. Correct and retry forward. Never delete
the Service or ConfigMap.
Keep a failed preparation/delivery paused and serving the installed ReplicaSet;
correct configuration/env before resume. If new pods fail after resume, old pods
remain under the rolling update; check availability before proceeding. A post-patch rollout timeout does not revert the patch.
If an HPA changes replicas during the rollout, the helper can report a post-patch
live-state verification failure even though it never writes replicas. Check the
HPA's desired count, live replicas, JWT env and Available, then rerun the same step
against the new resourceVersion. Do not reset replicas or assume the patch reverted;
do not proceed to delivery or resume until verification succeeds.

Prefer correcting the target configuration and retrying forward. Alternatively,
an operator may approve reapplying **only** the protected `433be51` executor render
with actual old values, after checking replicas and preserving other-manager
annotations. Restore literals and remove references atomically. No whole-release
forced upgrade or Helm rollback is part of this step; existing database/auth
fail-forward rules remain authoritative. Audience mappers may remain.

These are new unpublished notes; published 0.4.19 notes/packages and render
baselines remain unchanged. Release review must finalize the shipping version
before packaging; this bounded repair leaves Chart.yaml's version unchanged.
