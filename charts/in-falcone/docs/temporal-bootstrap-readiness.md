# Temporal bootstrap readiness

The chart creates the configured Temporal namespace and its five search
attributes through a normal, revision-scoped Job. The Job is submitted with
the other chart resources during Helm install and upgrade; it is not a
`post-install` or `post-upgrade` hook. Its name contains the Helm revision, so
Kubernetes never has to patch the immutable pod template of a completed Job.

The Job first probes the always-present Temporal frontend. Health is bounded by
the chart deadline. If the frontend does not become healthy, the Job exits
before calling namespace or search-attribute commands and reports the target,
bounded attempts, and a correct-or-resolve-then-retry-forward instruction.

After health succeeds, reconciliation is additive: an existing namespace and
attributes are retained, missing objects are created, and every configured
attribute is verified. Partial progress is safe to retry. The Job never
deletes a namespace, search attribute, workflow history, or other Temporal
state, and it has no ServiceAccount token, Secret, Kubernetes API credentials,
or RBAC contract.

The supported application namespace is `falcone-flows`, which is the target used by all
application consumers. The chart rejects a different producer namespace before rendering so
it cannot install a bootstrap Job and consumers that point at different namespaces. The five
required attributes may be listed in any order, but their exact names are `tenantId`,
`workspaceId`, `flowId`, `flowVersion`, and `triggerType`, each with type `Keyword`; missing,
duplicate, extra, or differently typed entries are rejected before rendering.

## Operator checks

After an install or upgrade, run the following procedure. It derives
`HELM_REVISION` from the deployed Helm history and selects the active Job:

```bash
set -euo pipefail
: "${RELEASE_NAME:?set RELEASE_NAME}" "${RELEASE_NAMESPACE:?set RELEASE_NAMESPACE}"
# Dependencies: Helm, kubectl, jq, Bash, awk, and sed.
history="$(helm history -n "$RELEASE_NAMESPACE" "$RELEASE_NAME" -o json)"
mapfile -t deployed_revisions < <(printf '%s' "$history" | jq -r '.[] | select(.status=="deployed") | .revision')
if [ "${#deployed_revisions[@]}" -ne 1 ]; then echo "expected exactly one deployed Helm revision, found ${#deployed_revisions[@]}" >&2; exit 1; fi
ACTIVE_REVISION="${deployed_revisions[0]}"
manifest="$(mktemp)"; trap 'rm -f "$manifest"' EXIT
helm get manifest "$RELEASE_NAME" -n "$RELEASE_NAMESPACE" --revision "$ACTIVE_REVISION" >"$manifest" || { echo "helm get manifest failed for release=$RELEASE_NAME namespace=$RELEASE_NAMESPACE active revision=$ACTIVE_REVISION; correct or resolve and retry to fail forward safely" >&2; exit 1; }
manifest_job_count="$(awk 'BEGIN { RS="---" } /apiVersion:[[:space:]]*batch\/v1/ && /kind:[[:space:]]*Job/ && /app\.kubernetes\.io\/component:[[:space:]]*temporal-bootstrap/ { n++ } END { print n + 0 }' "$manifest")"
if [ "$manifest_job_count" -ne 1 ]; then echo "expected exactly one effective bootstrap Job in stored manifest; release=$RELEASE_NAME namespace=$RELEASE_NAMESPACE active revision=$ACTIVE_REVISION effective manifest revision unknown effective lifecycle unknown found $manifest_job_count; correct or resolve and retry to fail forward safely" >&2; exit 1; fi
manifest_job="$(awk 'BEGIN { RS="---" } /apiVersion:[[:space:]]*batch\/v1/ && /kind:[[:space:]]*Job/ && /app\.kubernetes\.io\/component:[[:space:]]*temporal-bootstrap/ { print; exit }' "$manifest")"
effective_revision="$(printf '%s\n' "$manifest_job" | sed -n 's/.*falcone.io\/helm-release-revision:[[:space:]]*"*\([0-9][0-9]*\)"*.*/\1/p' | head -1)"
effective_lifecycle="$(printf '%s\n' "$manifest_job" | sed -n 's/.*falcone.io\/helm-lifecycle:[[:space:]]*"*\(install\|upgrade\)"*.*/\1/p' | head -1)"
if [[ ! "$effective_revision" =~ ^[1-9][0-9]*$ || ! "$effective_lifecycle" =~ ^(install|upgrade)$ ]]; then echo "invalid effective bootstrap labels for release=$RELEASE_NAME namespace=$RELEASE_NAMESPACE active revision=$ACTIVE_REVISION effective revision=$effective_revision effective lifecycle=$effective_lifecycle; correct or resolve and retry to fail forward safely" >&2; exit 1; fi
selector="app.kubernetes.io/instance=$RELEASE_NAME,app.kubernetes.io/component=temporal-bootstrap,falcone.io/helm-release-revision=$effective_revision,falcone.io/helm-lifecycle=$effective_lifecycle"
mapfile -t jobs < <(kubectl -n "$RELEASE_NAMESPACE" get jobs -l "$selector" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
if [ "${#jobs[@]}" -ne 1 ]; then
  echo "expected exactly one live Temporal bootstrap Job; release=$RELEASE_NAME namespace=$RELEASE_NAMESPACE active revision=$ACTIVE_REVISION effective revision=$effective_revision effective lifecycle=$effective_lifecycle selector=$selector found ${#jobs[@]}; correct or resolve and retry to fail forward safely" >&2
  exit 1
fi
kubectl -n "$RELEASE_NAMESPACE" logs "job/${jobs[0]}"
kubectl -n "$RELEASE_NAMESPACE" rollout status \
  "deployment/$RELEASE_NAME-workflow-worker" --timeout=10m
```

The Job success line and the workflow-worker init gate both require the namespace plus all five
exact `Keyword` attributes. If the Job fails, inspect its bounded phase diagnostic, correct the
frontend or Temporal condition, and run a new `helm upgrade --install` revision. Do not delete
the namespace, search attributes, workflow histories, or schedules as a recovery step.

Before rollback, verify the retained namespace and attributes are usable by
the target chart. Rollback does not undo Temporal state; if compatibility is
uncertain, correct the condition and fail forward instead.

Offline Helm renders and process-isolated tests do not prove live readiness.
The live acceptance is: r1 clean install, r2 upgrade, r3 failed-forward retry
with a fresh revision Job, then rollback verification. For each revision check
Job completion, immutable pod-template identity/UID, active revision and
lifecycle labels, namespace plus five attributes, and workflow-worker readiness.
During rollback, the active Helm revision can differ from the revision and
labels recorded in the stored manifest being replayed; therefore this
procedure derives the effective Job labels from `helm get manifest --revision
"$ACTIVE_REVISION"` before querying live Jobs.

## Admin-tools image migration

`global.temporalAdminToolsImage` is the single image authority for both the
revision Job and the mandatory workflow-worker startup gate. It accepts the
repository, tag, optional digest, and pull policy and still uses the global
registry normalizer and pull-secret configuration. The historical
`temporal.adminTools.image` input remains only for compatibility: the exact
shipped default is neutral, while a custom legacy value must match the global
authority exactly or rendering fails with migration guidance. The old
`workflowWorker.temporalBootstrapImage` path is rejected and cannot divert the
gate.

```yaml
global:
  temporalAdminToolsImage:
    repository: docker.io/temporalio/admin-tools
    tag: "1.31.1"
    digest: ""
    pullPolicy: IfNotPresent
```

For a custom digest-pinned image, copy all four fields together:

```yaml
global:
  temporalAdminToolsImage:
    repository: registry.example.test/team/admin-tools
    tag: "9.9.9"
    digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    pullPolicy: IfNotPresent
```
