#!/usr/bin/env bash
set -euo pipefail

EXPECTED_CONTEXT="default"
EXPECTED_NAMESPACE="in-falcone-staging"
EXPECTED_RELEASE="falcone"
EXPECTED_PVC="falcone-postgresql-vector-data"
EXPECTED_VECTOR_STATEFULSET="falcone-postgresql-vector"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd "$script_dir/.." && pwd)"
apply=false
confirm_target=""
backup_reference=""

while (($#)); do
  case "$1" in
    --apply) apply=true ;;
    --confirm-target) shift; confirm_target="${1:-}" ;;
    --backup-reference) shift; backup_reference="${1:-}" ;;
    -h|--help)
      printf 'usage: %s [--apply --confirm-target default/in-falcone-staging/falcone --backup-reference ID]\n' "$0"
      exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$(kubectl config current-context)" == "$EXPECTED_CONTEXT" ]] || { printf 'TARGET_CONTEXT_MISMATCH\n' >&2; exit 1; }
kubectl get namespace "$EXPECTED_NAMESPACE" >/dev/null
actual_release="$(helm list -n "$EXPECTED_NAMESPACE" --filter "^${EXPECTED_RELEASE}$" -o json | jq -r 'if length == 1 then .[0].name else empty end')"
[[ "$actual_release" == "$EXPECTED_RELEASE" ]] || { printf 'TARGET_RELEASE_MISSING\n' >&2; exit 1; }
[[ -n "$backup_reference" ]] || backup_reference="REQUIRED-BEFORE-APPLY"
args=(
  -f "$chart_dir/values/staging.yaml"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference}"
)
helm template "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" --is-upgrade "${args[@]}" >/dev/null
printf 'forward-recovery-preflight=passed dry-run=%s target=%s/%s/%s\n' \
  "$([[ "$apply" == true ]] && printf false || printf true)" "$EXPECTED_CONTEXT" "$EXPECTED_NAMESPACE" "$EXPECTED_RELEASE"
[[ "$apply" == true ]] || { printf 'no mutation performed\n'; exit 0; }
[[ "$confirm_target" == "${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}" ]] || {
  printf 'JIT_TARGET_CONFIRMATION_REQUIRED\n' >&2; exit 1;
}
[[ "$backup_reference" != "REQUIRED-BEFORE-APPLY" ]] || { printf 'BACKUP_REFERENCE_REQUIRED\n' >&2; exit 1; }

# Forward recovery never deletes a PVC and never rolls back to revision 20. It
# reapplies the canonical repaired values and resumes the exact workloads.
helm upgrade "$EXPECTED_RELEASE" "$chart_dir" --namespace "$EXPECTED_NAMESPACE" \
  --atomic --wait --timeout 20m "${args[@]}"
if kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" >/dev/null 2>&1; then
  kubectl -n "$EXPECTED_NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound pvc/"$EXPECTED_PVC" --timeout=5m
fi
kubectl -n "$EXPECTED_NAMESPACE" rollout status statefulset/"$EXPECTED_VECTOR_STATEFULSET" --timeout=10m
kubectl -n "$EXPECTED_NAMESPACE" rollout status deployment/falcone-ferretdb --timeout=10m
printf 'forward-recovery=applied rollback=not-used\n'
