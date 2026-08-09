#!/usr/bin/env bash
set -euo pipefail

# Revision-20 staging repair. Default behavior is metadata-only preflight/diff.
# Applying either phase requires an explicit mode plus exact target confirmation.
EXPECTED_CONTEXT="default"
EXPECTED_NAMESPACE="in-falcone-staging"
EXPECTED_RELEASE="falcone"
EXPECTED_REVISION="20"
EXPECTED_PVC="falcone-postgresql-vector-data"
EXPECTED_VECTOR_STATEFULSET="falcone-postgresql-vector"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd "$script_dir/.." && pwd)"
staging_values="$chart_dir/values/staging.yaml"
mode="preflight"
apply=false
confirm_target=""
confirm_pvc=""
pvc_uid=""
backup_reference=""

usage() {
  printf '%s\n' \
    "usage: $0 [--phase-a|--phase-b] [--apply] [--confirm-target CONTEXT/NAMESPACE/RELEASE@REVISION]" \
    "          [--pvc-uid UID --confirm-pvc NAME/UID] [--backup-reference NON_SECRET_ID]" \
    "default: read-only preflight and secret-suppressed Helm diff; no cluster mutation"
}

while (($#)); do
  case "$1" in
    --phase-a) mode="phase-a" ;;
    --phase-b) mode="phase-b" ;;
    --apply) apply=true ;;
    --confirm-target) shift; confirm_target="${1:-}" ;;
    --pvc-uid) shift; pvc_uid="${1:-}" ;;
    --confirm-pvc) shift; confirm_pvc="${1:-}" ;;
    --backup-reference) shift; backup_reference="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

for command_name in kubectl helm jq; do
  command -v "$command_name" >/dev/null || { printf 'missing command: %s\n' "$command_name" >&2; exit 2; }
done
[[ -f "$staging_values" ]] || { printf 'staging values not found: %s\n' "$staging_values" >&2; exit 2; }

actual_context="$(kubectl config current-context)"
[[ "$actual_context" == "$EXPECTED_CONTEXT" ]] || {
  printf 'TARGET_CONTEXT_MISMATCH expected=%s actual=%s\n' "$EXPECTED_CONTEXT" "$actual_context" >&2
  exit 1
}
kubectl get namespace "$EXPECTED_NAMESPACE" >/dev/null
release_json="$(helm list -n "$EXPECTED_NAMESPACE" --filter "^${EXPECTED_RELEASE}$" -o json)"
actual_revision="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].revision else empty end')"
[[ -n "$actual_revision" ]] || { printf 'TARGET_RELEASE_MISSING\n' >&2; exit 1; }

target_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_REVISION}"
if [[ "$mode" == "phase-a" || "$mode" == "preflight" ]]; then
  [[ "$actual_revision" == "$EXPECTED_REVISION" ]] || {
    printf 'REVISION_GATE_FAILED expected=%s actual=%s; use forward recovery after Phase A\n' "$EXPECTED_REVISION" "$actual_revision" >&2
    exit 1
  }
fi

[[ -n "$backup_reference" ]] || backup_reference="REQUIRED-BEFORE-APPLY"
render_file="$(mktemp "${TMPDIR:-/tmp}/falcone-revision20-render.XXXXXX")"
diff_file="$(mktemp "${TMPDIR:-/tmp}/falcone-revision20-diff.XXXXXX")"
cleanup() { rm -f "$render_file" "$diff_file"; }
trap cleanup EXIT

phase_a_args=(
  -f "$staging_values"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
  --set openbao.openbao.authReconcile.allowRecoveryRoot=true
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference}"
)
phase_b_args=(
  -f "$staging_values"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference}"
)

if [[ "$mode" == "phase-b" ]]; then selected_args=("${phase_b_args[@]}"); else selected_args=("${phase_a_args[@]}"); fi
helm template "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" --is-upgrade \
  "${selected_args[@]}" >"$render_file"

require_render_contract() {
  local contract="$1"
  local expected="$2"
  grep -qF "$expected" "$render_file" || {
    printf 'STAGING_IMAGE_DIGEST_DRIFT contract=%s\n' "$contract" >&2
    exit 1
  }
}

# Validate each approved digest at the public field that consumes it. This
# prevents an approved digest appearing on the wrong workload from satisfying
# the preflight. MCP is deliberately different: consumers combine the separate
# MCP_RUNTIME_IMAGE and MCP_RUNTIME_IMAGE_DIGEST ConfigMap fields, rather than
# receiving one repository@digest value.
require_render_contract control-plane \
  'image: "ghcr.io/gntik-ai/in-falcone-control-plane@sha256:0c6aeff8f3c115c63b49164cdb6daf73c2b4636b4d1907e48c8b18484218861a"'
require_render_contract control-plane-executor \
  'image: "ghcr.io/gntik-ai/in-falcone-control-plane-executor@sha256:d19acae027d39e68ae4656e779ae8ce738a22a145092681d34d01201252ac28d"'
require_render_contract web-console \
  'image: "ghcr.io/gntik-ai/in-falcone-web-console@sha256:2cf611ee6e77e63b80c7aa988790191a668e52f08e2f907a335d1bb8eb83ff34"'
require_render_contract workflow-worker \
  'image: "ghcr.io/gntik-ai/in-falcone-workflow-worker@sha256:2669be573ec5d461f8a1e21c58c13817fd1bc14a947dba845ce1cfac8368a054"'
require_render_contract function-executor-runtime \
  "value: 'ghcr.io/gntik-ai/in-falcone-fn-runtime@sha256:4fe7a77b01e7e49cd97722a3f55808ec4a09c0c0886680389011ba43796382ba'"
require_render_contract mcp-runtime-image \
  'MCP_RUNTIME_IMAGE: "ghcr.io/gntik-ai/in-falcone-mcp-runtime:0.3.0"'
require_render_contract mcp-runtime-image-digest \
  'MCP_RUNTIME_IMAGE_DIGEST: "sha256:ef4bf4a350388508f301f6ea4f39012b412b7bb625314e136812ba8cc53efb99"'
if grep -Eq '^  namespace: external-secrets[[:space:]]*$' "$render_file"; then
  printf 'EXTERNAL_ESO_OWNER_RENDERED\n' >&2
  exit 1
fi

if helm plugin list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx diff; then
  helm diff upgrade "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" \
    --suppress-secrets "${selected_args[@]}" >"$diff_file" || diff_status=$?
  diff_status="${diff_status:-0}"
  [[ "$diff_status" == 0 || "$diff_status" == 2 ]] || { printf 'HELM_DIFF_FAILED\n' >&2; exit 1; }
  if grep -Eq 'external-secrets.*(DELETE|CREATE|UPDATE)|namespace: external-secrets' "$diff_file"; then
    printf 'EXTERNAL_ESO_OWNER_MUTATION_PLANNED\n' >&2
    exit 1
  fi
else
  printf 'HELM_DIFF_PLUGIN_REQUIRED_FOR_APPLY\n'
  [[ "$apply" == false ]] || exit 1
fi

printf 'preflight=passed context=%s namespace=%s release=%s revision=%s mode=%s dry-run=%s\n' \
  "$actual_context" "$EXPECTED_NAMESPACE" "$EXPECTED_RELEASE" "$actual_revision" "$mode" "$([[ "$apply" == true ]] && printf false || printf true)"

if [[ "$apply" == false ]]; then
  printf 'no mutation performed; rerun with the phase-specific --apply confirmation only after reviewing the suppressed diff\n'
  exit 0
fi
[[ "$backup_reference" != "REQUIRED-BEFORE-APPLY" ]] || { printf 'BACKUP_REFERENCE_REQUIRED\n' >&2; exit 1; }
[[ "$confirm_target" == "$target_confirmation" ]] || {
  printf 'JIT_TARGET_CONFIRMATION_REQUIRED expected=%s\n' "$target_confirmation" >&2
  exit 1
}

if [[ "$mode" == "phase-a" ]]; then
  helm upgrade "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" \
    --atomic --wait --timeout 20m "${phase_a_args[@]}"
  kubectl -n "$EXPECTED_NAMESPACE" wait --for=condition=Available deployment/falcone-ferretdb --timeout=10m
  kubectl wait --for=condition=Ready clustersecretstore/openbao-backend --timeout=10m
  not_ready="$(kubectl -n "$EXPECTED_NAMESPACE" get externalsecrets.external-secrets.io -o json \
    | jq '[.items[] | select(any(.status.conditions[]?; .type == "Ready" and .status == "True") | not)] | length')"
  [[ "$not_ready" == 0 ]] || { printf 'EXTERNAL_SECRETS_NOT_READY count=%s\n' "$not_ready" >&2; exit 1; }
  # Remove the one-release recovery-root allowance while retaining the immutable
  # old PVC storage contract. This second idempotent pass must report unchanged.
  phase_a_no_root_args=(
    -f "$staging_values"
    --set-string deployment.upgrade.currentVersion=0.3.1
    --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
    --set openbao.openbao.authReconcile.allowRecoveryRoot=false
    --set global.webhookDatabase.migration.backupVerified=true
    --set global.webhookDatabase.migration.parityVerified=true
    --set-string "global.webhookDatabase.migration.backupReference=${backup_reference}"
  )
  helm upgrade "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" \
    --atomic --wait --timeout 20m "${phase_a_no_root_args[@]}"
  printf 'phase-a=applied recovery-root-allowance=disabled next=phase-b-preflight\n'
  exit 0
fi

[[ "$mode" == "phase-b" ]] || { printf 'apply requires --phase-a or --phase-b\n' >&2; exit 2; }
pvc_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" -o json)"
actual_pvc_uid="$(printf '%s' "$pvc_json" | jq -r '.metadata.uid')"
actual_phase="$(printf '%s' "$pvc_json" | jq -r '.status.phase // ""')"
volume_name="$(printf '%s' "$pvc_json" | jq -r '.spec.volumeName // ""')"
[[ "$actual_phase" == "Pending" ]] || { printf 'PVC_STATE_CHANGED expected=Pending actual=%s\n' "$actual_phase" >&2; exit 1; }
[[ -z "$volume_name" ]] || { printf 'PVC_VOLUME_NOW_ASSIGNED\n' >&2; exit 1; }
[[ -n "$pvc_uid" && "$pvc_uid" == "$actual_pvc_uid" ]] || { printf 'PVC_UID_CHANGED actual=%s\n' "$actual_pvc_uid" >&2; exit 1; }
pv_refs="$(kubectl get pv -o json | jq --arg uid "$actual_pvc_uid" --arg ns "$EXPECTED_NAMESPACE" --arg name "$EXPECTED_PVC" \
  '[.items[] | select(.spec.claimRef.uid == $uid or (.spec.claimRef.namespace == $ns and .spec.claimRef.name == $name))] | length')"
[[ "$pv_refs" == 0 ]] || { printf 'PVC_HAS_PV_CLAIMREF\n' >&2; exit 1; }
pod_refs="$(kubectl -n "$EXPECTED_NAMESPACE" get pods -o json | jq --arg claim "$EXPECTED_PVC" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))] | length')"
[[ "$pod_refs" == 0 ]] || { printf 'PVC_REFERENCED_BY_POD count=%s\n' "$pod_refs" >&2; exit 1; }
successful_vector_pods="$(kubectl -n "$EXPECTED_NAMESPACE" get pods \
  -l app.kubernetes.io/instance="$EXPECTED_RELEASE",app.kubernetes.io/name=postgresql-vector -o json \
  | jq '[.items[] | select(.status.phase == "Succeeded")] | length')"
[[ "$successful_vector_pods" == 0 ]] || { printf 'DATA_BEARING_POD_EVIDENCE_FOUND\n' >&2; exit 1; }
[[ "$confirm_pvc" == "${EXPECTED_PVC}/${actual_pvc_uid}" ]] || {
  printf 'JIT_PVC_CONFIRMATION_REQUIRED expected=%s/%s\n' "$EXPECTED_PVC" "$actual_pvc_uid" >&2
  exit 1
}

# Re-read immutable identity and state immediately after confirmation. Any change
# expires the confirmation; no wildcard or label-wide deletion is used.
fresh_pvc_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" -o json)"
fresh_pvc_uid="$(printf '%s' "$fresh_pvc_json" | jq -r '.metadata.uid')"
fresh_phase="$(printf '%s' "$fresh_pvc_json" | jq -r '.status.phase // ""')"
fresh_volume_name="$(printf '%s' "$fresh_pvc_json" | jq -r '.spec.volumeName // ""')"
[[ "$fresh_pvc_uid" == "$actual_pvc_uid" ]] || { printf 'VECTOR_PVC_STATE_CHANGED field=uid\n' >&2; exit 1; }
[[ "$fresh_phase" == "Pending" ]] || { printf 'VECTOR_PVC_STATE_CHANGED field=phase actual=%s\n' "$fresh_phase" >&2; exit 1; }
[[ -z "$fresh_volume_name" ]] || { printf 'VECTOR_PVC_STATE_CHANGED field=volumeName\n' >&2; exit 1; }

fresh_pv_refs="$(kubectl get pv -o json | jq --arg uid "$actual_pvc_uid" --arg ns "$EXPECTED_NAMESPACE" --arg name "$EXPECTED_PVC" \
  '[.items[] | select(.spec.claimRef.uid == $uid or (.spec.claimRef.namespace == $ns and .spec.claimRef.name == $name))] | length')"
[[ "$fresh_pv_refs" == 0 ]] || { printf 'VECTOR_PVC_STATE_CHANGED evidence=pv-claimref\n' >&2; exit 1; }
fresh_pod_refs="$(kubectl -n "$EXPECTED_NAMESPACE" get pods -o json | jq --arg claim "$EXPECTED_PVC" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))] | length')"
[[ "$fresh_pod_refs" == 0 ]] || { printf 'VECTOR_PVC_STATE_CHANGED evidence=pod-reference count=%s\n' "$fresh_pod_refs" >&2; exit 1; }
fresh_successful_vector_pods="$(kubectl -n "$EXPECTED_NAMESPACE" get pods \
  -l app.kubernetes.io/instance="$EXPECTED_RELEASE",app.kubernetes.io/name=postgresql-vector -o json \
  | jq '[.items[] | select(.status.phase == "Succeeded")] | length')"
[[ "$fresh_successful_vector_pods" == 0 ]] || { printf 'VECTOR_PVC_STATE_CHANGED evidence=data-bearing-pod\n' >&2; exit 1; }

kubectl -n "$EXPECTED_NAMESPACE" scale statefulset "$EXPECTED_VECTOR_STATEFULSET" --replicas=0
kubectl -n "$EXPECTED_NAMESPACE" delete pvc "$EXPECTED_PVC" --wait=true
helm upgrade "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" \
  --atomic --wait --timeout 20m "${phase_b_args[@]}"
kubectl -n "$EXPECTED_NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound pvc/"$EXPECTED_PVC" --timeout=5m
kubectl -n "$EXPECTED_NAMESPACE" rollout status statefulset/"$EXPECTED_VECTOR_STATEFULSET" --timeout=10m
printf 'phase-b=applied recovery=forward-only pvc=%s uid=%s\n' "$EXPECTED_PVC" "$actual_pvc_uid"
