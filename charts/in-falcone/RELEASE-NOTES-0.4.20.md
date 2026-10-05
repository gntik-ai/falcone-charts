# in-falcone 0.4.20 (next unpublished release)

## Executor JWT environment upgrade (#980, #1053)

#980 moved the executor JWT configuration to five reference-only entries in
`{release}-executor-jwt-config`. An existing Deployment with literal JWT env
can reject an apply that retains both `value` and `valueFrom`. Use the one-time
atomic env patch below before retrying a rejected delivery, after normal gated
Helm delivery has reconciled the target executor JWT ConfigMap. The helper cannot
prepare a pre-#980 release before that ConfigMap exists. On migrated staging it
is a no-op. Fresh installs need no transition.

The chosen mechanism changes only the five executor JWT env entries in one
resourceVersion-fenced JSON Patch. It preserves non-JWT env, HPA-managed replicas,
other-manager annotations, the Service and ConfigMap. Removing the old value
and adding its reference happen atomically, so there is no intermediate pod
template without JWKS URL, issuer or audience. This avoids whole-object replace's
field-loss risk. There is no permanent Argo replacement option; Helm remains the
deployment adapter and the helper renders the exact target chart checkout.
All migration, backup/parity, immutable-image and ESO/OpenBao gates still apply.

## Path evidence and limits

The mandatory `executor-env-upgrade` PR CI job records separate observed outcomes
for Helm 3.17.3 client upgrade, Argo-style client apply of a Helm-created Deployment
without a last-applied annotation, and Helm 4.1.4 upgrade with `--server-side=true`.
The `executor-env-upgrade-evidence` artifact records both revisions, client versions,
legacy values layer SHA256, each untreated result, atomic-step result and delivery
retry. The test prints its SHA256. Consult those results to decide which path needs
the step; do not infer Helm's behavior from Argo's failure. Publication requires
the job. At least one untreated path must reproduce the reported API rejection;
all recovered paths must become Available, resolve all five references, preserve
replicas/annotations/Service/ConfigMap and be unchanged on a repeat step.

Untouched `433be51` executor defaults do **not** define direct issuer/audience env
(the TLS overlay adds literal JWKS only). The test renders that real chart with
`tests/blackbox/fixtures/executor-env-before-980.yaml`, an explicit credential-free
installed-values layer modeling the reported three literals. It does not claim
untouched historical defaults reproduce that installation. The disposable live
probe preserves rendered selectors, metadata and JWT env, substituting BusyBox
readiness/env checks for the application. It does not claim a full platform install
or bearer round trip. Live outcomes are pending CI, not claimed from this sandbox.

## Operator order and step

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
4. Let the normal gated Helm delivery reconcile `{release}-executor-jwt-config`
   with the target configuration first. If it has not reached that resource, stop
   and have the operator complete that prerequisite through the normal adapter.
   The helper checks all five keys are nonempty with boolean-only output; it never
   creates/changes the ConfigMap or reads a Secret. Confirm it is the target
   ConfigMap: key presence alone does not attest its values.
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
   exact ordered layers. The same helper precedes retry through the normal gated
   delivery. It mutates only `{release}-control-plane-executor`, checks reference-only
   env, rollout and retained replicas/annotations. Kubernetes' controller-owned
   Deployment revision annotation may advance. A concurrent change fails the
   resourceVersion test: recheck live state and retry instead of bypassing the fence.
6. Retry the normal gated delivery and existing #980 bearer/isolation checks.
   Verify five unique reference-only entries, pod config readiness, Available,
   replicas/annotations, and `EXECUTOR_UPGRADE_UNCHANGED` on repeat. Retain only
   statuses/hashes. ConfigMap-only changes do not refresh running env: later audience
   enforcement changes still need the existing APISIX/executor reload procedure.

## Failure and rollback

Missing ConfigMap/key, invalid env, dirty render input or wrong revision fails
before mutation. Correct and retry forward. Never delete the Service or ConfigMap.
If new pods fail, old pods remain under the rolling update; check availability
before proceeding. A post-patch rollout timeout does not revert the patch.

Prefer correcting the target configuration and retrying forward. Alternatively,
an operator may approve reapplying **only** the protected `433be51` executor render
with actual old values, after checking replicas and preserving other-manager
annotations. Restore literals and remove references atomically. No whole-release
forced upgrade or Helm rollback is part of this step; existing database/auth
fail-forward rules remain authoritative. Audience mappers may remain.

These are new unpublished notes; published 0.4.19 notes/packages and render
baselines remain unchanged. Release review must finalize the shipping version
before packaging; this bounded repair leaves Chart.yaml's version unchanged.
