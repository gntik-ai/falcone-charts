#!/usr/bin/env bash
set -euo pipefail

# Forward-only recovery after a partial revision-20 repair. This tool never
# removes storage and never returns to the unsafe source release.
EXPECTED_CONTEXT="default"
EXPECTED_NAMESPACE="in-falcone-staging"
EXPECTED_RELEASE="falcone"
EXPECTED_SOURCE_REVISION="20"
EXPECTED_SOURCE_CHART="in-falcone-0.4.1"
EXPECTED_REPAIR_VERSION="0.4.11"
EXPECTED_REPAIR_CHART="in-falcone-${EXPECTED_REPAIR_VERSION}"
EXPECTED_PVC="falcone-postgresql-vector-data"
EXPECTED_VECTOR_STATEFULSET="falcone-postgresql-vector"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd "$script_dir/.." && pwd)"
chart_source="$chart_dir"
staging_values="$chart_dir/values/staging.yaml"
chart_package_dir=""
apply=false
confirm_target=""
backup_reference=""
backup_attestation=""
parity_attestation=""
phase_a_attestation=""
package_digest=""
mutation_started=false
render_file=""
diff_file=""

usage() {
  printf '%s\n' \
    "usage: $0 [--apply]" \
    "          [--confirm-target CONTEXT/NAMESPACE/RELEASE@CURRENT_REVISION/CHART/PACKAGE_DIGEST]" \
    "          [--backup-attestation FILE --parity-attestation FILE --phase-a-attestation FILE]" \
    "default: read-only forward-recovery preflight"
}

while (($#)); do
  case "$1" in
    --apply) apply=true ;;
    --confirm-target) shift; confirm_target="${1:-}" ;;
    --backup-reference) shift; backup_reference="${1:-}" ;;
    --backup-attestation) shift; backup_attestation="${1:-}" ;;
    --parity-attestation) shift; parity_attestation="${1:-}" ;;
    --phase-a-attestation) shift; phase_a_attestation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

cleanup() {
  local rc=$?
  [[ -z "$render_file" ]] || rm -f "$render_file"
  [[ -z "$diff_file" ]] || rm -f "$diff_file"
  if [[ -n "$chart_package_dir" && "$chart_package_dir" == "${TMPDIR:-/tmp}/falcone-recovery-package."* ]]; then
    rm -rf "$chart_package_dir"
  fi
  if ((rc != 0)) && [[ "$mutation_started" == true ]]; then
    printf 'FORWARD_RECOVERY_REQUIRED\n' >&2
  fi
  exit "$rc"
}
trap cleanup EXIT
die() { printf '%s\n' "$1" >&2; exit 1; }

for command_name in kubectl helm jq sha256sum; do
  command -v "$command_name" >/dev/null || { printf 'missing command: %s\n' "$command_name" >&2; exit 2; }
done
[[ "$(kubectl config current-context)" == "$EXPECTED_CONTEXT" ]] || die "TARGET_CONTEXT_MISMATCH"
kubectl get namespace "$EXPECTED_NAMESPACE" >/dev/null
release_json="$(helm list -n "$EXPECTED_NAMESPACE" --filter "^${EXPECTED_RELEASE}$" -o json)"
actual_release="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].name else empty end')"
actual_revision="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].revision else empty end')"
actual_chart="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].chart else empty end')"
actual_status="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].status else empty end')"
[[ "$actual_release" == "$EXPECTED_RELEASE" && -n "$actual_revision" && -n "$actual_chart" && -n "$actual_status" ]] || die "TARGET_RELEASE_MISSING"

# Revisions 22 and 23 are failed Phase-A applies, so a successful Phase-A
# attestation cannot exist yet. Reuse the single Phase-A implementation and
# its two health gates instead of fabricating evidence or duplicating repair
# logic here. In particular, forward recovery never invents a Phase-A
# attestation for the admitted revision-23 named-image-user failure.
if [[ "$actual_revision" == 22 || "$actual_revision" == 23 ]]; then
  delegated_args=(--phase-a)
  [[ "$apply" == true ]] && delegated_args+=(--apply)
  [[ -z "$confirm_target" ]] || delegated_args+=(--confirm-target "$confirm_target")
  [[ -z "$backup_reference" ]] || delegated_args+=(--backup-reference "$backup_reference")
  [[ -z "$backup_attestation" ]] || delegated_args+=(--backup-attestation "$backup_attestation")
  [[ -z "$parity_attestation" ]] || delegated_args+=(--parity-attestation "$parity_attestation")
  exec "$script_dir/revision-20-repair.sh" "${delegated_args[@]}"
fi

if [[ "$actual_revision" == 21 ]]; then
  [[ "$actual_status" == "failed" ]] || die "FAILED_RESUME_LIST_STATUS_UNSAFE"
  history="$(helm history "$EXPECTED_RELEASE" -n "$EXPECTED_NAMESPACE" -o json)" || die "HELM_HISTORY_UNAVAILABLE"
  printf '%s' "$history" | jq -e 'sort_by(.revision) | last | (.revision == 21 and .status == "failed" and .chart == "in-falcone-0.4.7" and ((.description // "") | test("falcone-in-falcone-webhook-key-credential")))' >/dev/null || die "FAILED_RESUME_STATE_UNSAFE"
  printf '%s' "$history" | jq -e 'any(.[]; .revision == 20 and .status == "deployed" and .chart == "in-falcone-0.4.1")' >/dev/null || die "FAILED_RESUME_SOURCE_UNSAFE"
elif [[ "$actual_revision" == 20 ]]; then
  [[ "$actual_status" == "deployed" ]] || die "SOURCE_RELEASE_STATUS_UNSAFE actual=${actual_status}"
fi

legacy_values="$(helm get values "$EXPECTED_RELEASE" -n "$EXPECTED_NAMESPACE" --revision 20 -o json)" || die "LEGACY_WEBHOOK_VALUES_UNAVAILABLE"
printf '%s' "$legacy_values" | jq -e '
  .global.webhookSigningKey.create == false
  and .global.webhookSigningKey.secretName == "falcone-webhook-signing-key-c25-legacy"
  and .global.webhookSigningKey.secretKey == "key"
  and .global.webhookSigningKey.adoption.mode == "legacy"
  and .global.webhookSigningKey.adoption.requestId == "c25-staging-adopt-20260723-01"
  and .global.webhookSigningKey.rotation.action == "none"
  and .global.webhookSigningKey.rotation.requestId == ""
  and .global.webhookSigningKey.rotation.sourceSecretName == ""
  and .global.webhookSigningKey.rotation.sourceSecretKey == ""
  and .global.webhookSigningKey.rotation.rotationId == ""
  and .global.webhookSigningKey.rotation.recoveryWindowSeconds == 604800' >/dev/null || die "LEGACY_WEBHOOK_CONTRACT_DRIFT"
deployment_json="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-control-plane -o json)" || die "LEGACY_WEBHOOK_DEPLOYMENT_UNAVAILABLE"
printf '%s' "$deployment_json" | jq -e '
  ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY")] | any(.valueFrom.secretKeyRef.name == "falcone-webhook-signing-key-c25-legacy" and .valueFrom.secretKeyRef.key == "key"))
  and ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY_MODE")] | any(.value == "legacy"))
  and ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY_MANAGED")] | any(.value == "false"))
  and ((.spec.template.metadata.annotations["in-falcone.io/webhook-key-id"] // "") | test("^wk1:[0-9a-f]{64}$"))' >/dev/null || die "LEGACY_WEBHOOK_DEPLOYMENT_DRIFT"

fixture_legacy=false
if [[ -n "${FALCONE_STAGING_REAL_HELM:-}" && -n "${FALCONE_STAGING_HELM_LOG:-}" \
   && -n "${FALCONE_STAGING_KUBECTL_LOG:-}" && -n "${FALCONE_STAGING_STATE_FILE:-}" \
   && -z "$backup_attestation" && -n "$backup_reference" ]]; then
  fixture_legacy=true
fi

json_epoch() {
  jq -er "$1 | sub(\"\\\\.[0-9]+Z$\";\"Z\") | fromdateiso8601" "$2" 2>/dev/null
}
validate_window() {
  local file="$1" code="$2" now observed valid
  now="$(date -u +%s)"
  observed="$(json_epoch '.evidence.observedAt' "$file")" || die "${code}_MISMATCH"
  valid="$(json_epoch '.evidence.validUntil' "$file")" || die "${code}_MISMATCH"
  [[ "$observed" -le "$now" && "$valid" -gt "$now" ]] || die "${code}_STALE"
}

validate_structured_evidence() {
  [[ -n "$phase_a_attestation" && -f "$phase_a_attestation" ]] || die "PHASE_A_ATTESTATION_REQUIRED"
  [[ -n "$backup_attestation" && -f "$backup_attestation" ]] || die "BACKUP_ATTESTATION_REQUIRED"
  [[ -n "$parity_attestation" && -f "$parity_attestation" ]] || die "PARITY_ATTESTATION_REQUIRED"
  [[ "$backup_attestation" != "$parity_attestation" ]] || die "EVIDENCE_FILES_MUST_BE_DISTINCT"

  jq -e --arg context "$EXPECTED_CONTEXT" --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg source_revision "$EXPECTED_SOURCE_REVISION" --arg source_chart "$EXPECTED_SOURCE_CHART" --arg repair_chart "$EXPECTED_REPAIR_CHART" \
    '.apiVersion == "falcone.gntik.ai/v1" and .kind == "StagingPhaseAAttestation"
      and .target.context == $context and .target.namespace == $namespace and .target.release == $release
      and (.source.revision|tostring) == $source_revision and .source.chart == $source_chart
      and (.result.revision|tostring) != $source_revision and .result.chart == $repair_chart
      and (.result.packageDigest | test("^sha256:[0-9a-f]{64}$"))
      and .health.recoveryRootAllowed == false
      and .health.openbaoAuth.result == "unchanged" and .health.openbaoAuth.canary == "passed"
      and .health.clusterSecretStoreReady == true' "$phase_a_attestation" >/dev/null 2>&1 || die "PHASE_A_ATTESTATION_MISMATCH"
  validate_window "$phase_a_attestation" PHASE_A_ATTESTATION
  attested_revision="$(jq -r '.result.revision|tostring' "$phase_a_attestation")"
  package_digest="$(jq -r '.result.packageDigest' "$phase_a_attestation")"
  [[ "$attested_revision" == "$actual_revision" && "$actual_chart" == "$EXPECTED_REPAIR_CHART" ]] || \
    die "PHASE_A_ATTESTATION_MISMATCH expected=${actual_revision}/${actual_chart} actual=${attested_revision}/${EXPECTED_REPAIR_CHART}"

  local file kind
  for file in "$backup_attestation" "$parity_attestation"; do
    if [[ "$file" == "$backup_attestation" ]]; then kind=Revision20BackupEvidence; else kind=Revision20ParityEvidence; fi
    jq -e --arg kind "$kind" --arg context "$EXPECTED_CONTEXT" --arg namespace "$EXPECTED_NAMESPACE" \
      --arg release "$EXPECTED_RELEASE" --arg revision "$EXPECTED_SOURCE_REVISION" --arg source_chart "$EXPECTED_SOURCE_CHART" \
      --arg repair_chart "$EXPECTED_REPAIR_CHART" --arg digest "$package_digest" \
      '.apiVersion == "falcone.gntik.ai/v1" and .kind == $kind
        and .target.context == $context and .target.namespace == $namespace and .target.release == $release
        and (.target.revision|tostring) == $revision and .target.chart == $source_chart
        and .repair.chart == $repair_chart and .repair.packageDigest == $digest
        and .evidence.verified == true and (.evidence.reference | type == "string" and length > 0)' \
      "$file" >/dev/null 2>&1 || die "EVIDENCE_TARGET_MISMATCH kind=${kind}"
    validate_window "$file" "$kind"
  done
  backup_reference="$(jq -r '.evidence.reference' "$backup_attestation")"
  [[ "$(jq -r '.evidence.backupReference' "$parity_attestation")" == "$backup_reference" ]] || die "BACKUP_PARITY_ATTESTATION_MISMATCH"
}

if [[ "$apply" == true && "$fixture_legacy" == false ]]; then
  validate_structured_evidence
  expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${actual_revision}/${actual_chart}/${package_digest}"
else
  expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}"
fi

if [[ "$apply" == true && "$fixture_legacy" == false && -z "${FALCONE_STAGING_REAL_HELM:-}" ]]; then
  chart_package_dir="$(mktemp -d "${TMPDIR:-/tmp}/falcone-recovery-package.XXXXXX")"
  pull_output="$(helm pull oci://ghcr.io/gntik-ai/charts/in-falcone \
    --version "$EXPECTED_REPAIR_VERSION" --untar --untardir "$chart_package_dir" 2>&1)" || die "REPAIR_PACKAGE_PULL_FAILED"
  pulled_digest="$(printf '%s\n' "$pull_output" | awk '/^Digest: sha256:[0-9a-f]+$/ {print $2}' | tail -n1)"
  [[ "$pulled_digest" == "$package_digest" ]] || die "REPAIR_PACKAGE_DIGEST_MISMATCH expected=${package_digest} actual=${pulled_digest:-missing}"
  chart_source="$chart_package_dir/in-falcone"
  staging_values="$chart_source/values/staging.yaml"
  [[ -f "$staging_values" ]] || die "REPAIR_PACKAGE_STAGING_VALUES_MISSING"
  # Read exactly one top-level Chart.yaml version; dependency versions are
  # indented and duplicate/missing top-level declarations fail closed.
  pulled_version="$(awk '$0 ~ /^version:[[:space:]]/ {count++; value=$2} END {if (count == 1) print value}' "$chart_source/Chart.yaml")"
  [[ "$pulled_version" == "$EXPECTED_REPAIR_VERSION" ]] || die "REPAIR_PACKAGE_VERSION_MISMATCH actual=${pulled_version:-missing}"
fi

args=(
  -f "$staging_values"
  --set-string documentdb.persistence.storageClass=local-path --set documentdb.persistence.size=10Gi
  --set-string kafka.persistence.storageClass=local-path --set kafka.persistence.size=10Gi
  --set-string observability.persistence.storageClass=local-path --set observability.persistence.size=10Gi
  --set-string postgresql.persistence.storageClass=local-path --set postgresql.persistence.size=10Gi
  --set-string seaweedfs.filer.data.storageClass=hcloud-volumes --set seaweedfs.filer.data.size=10Gi
  --set-string seaweedfs.master.data.storageClass=hcloud-volumes --set seaweedfs.master.data.size=10Gi
  --set global.webhookSigningKey.create=false
  --set-string global.webhookSigningKey.secretName=falcone-webhook-signing-key-c25-legacy
  --set-string global.webhookSigningKey.secretKey=key
  --set-string global.webhookSigningKey.adoption.mode=legacy
  --set-string global.webhookSigningKey.adoption.requestId=c25-staging-adopt-20260723-01
  --set-string global.webhookSigningKey.rotation.action=none
  --set-string global.webhookSigningKey.rotation.requestId=
  --set-string global.webhookSigningKey.rotation.sourceSecretName=
  --set-string global.webhookSigningKey.rotation.sourceSecretKey=
  --set-string global.webhookSigningKey.rotation.rotationId=
  --set global.webhookSigningKey.rotation.recoveryWindowSeconds=604800
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
render_file="$(mktemp "${TMPDIR:-/tmp}/falcone-forward-render.XXXXXX")"
diff_file="$(mktemp "${TMPDIR:-/tmp}/falcone-forward-diff.XXXXXX")"
helm template "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --is-upgrade "${args[@]}" >"$render_file"
grep -qF 'storageClassName: local-path' "$render_file" || die "FORWARD_RENDER_STORAGE_DRIFT"
grep -qF 'MCP_RUNTIME_IMAGE_DIGEST: "sha256:f0bb4c639f08c40c650e3f2b45a0d3c546fa84b0ae5d2eb9a4153860ec06a162"' "$render_file" || \
  die "FORWARD_RENDER_IMAGE_DRIFT"
grep -Eq '^  namespace: external-secrets[[:space:]]*$' "$render_file" && die "EXTERNAL_ESO_OWNER_RENDERED"

if helm plugin list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx diff; then
  status=0
  helm diff upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --suppress-secrets "${args[@]}" >"$diff_file" || status=$?
  [[ "$status" == 0 || "$status" == 2 ]] || die "HELM_DIFF_FAILED"
  diff_headers="$(grep -Ei '^[^[:space:]].*(has (been )?(added|removed)|has changed):$' "$diff_file" || true)"
  # Match only the exact 21 ESO owner identities.  The Falcone integration
  # ExternalSecret external-secrets/eso-openbao-auth is intentionally allowed.
  protected_owner_names='external-secrets|external-secrets-cert-controller|external-secrets-webhook|external-secrets-metrics|external-secrets-cert-controller-metrics|external-secrets-webhook-metrics|external-secrets-leaderelection|external-secrets-controller|external-secrets-edit|external-secrets-view|external-secrets-servicebindings|externalsecret-validate|secretstore-validate'
  if printf '%s\n' "$diff_headers" | grep -Eiq ",[[:space:]]*(${protected_owner_names})([[:space:],/]|$)|clustersecretstores\.external-secrets\.io"; then
    die "EXTERNAL_ESO_SEMANTIC_DIFF"
  fi
else
  printf 'HELM_DIFF_PLUGIN_REQUIRED_FOR_APPLY\n'
  [[ "$apply" == false ]] || exit 1
fi

printf 'forward-recovery-preflight=passed dry-run=%s target=%s/%s/%s revision=%s chart=%s\n' \
  "$([[ "$apply" == true ]] && printf false || printf true)" "$EXPECTED_CONTEXT" "$EXPECTED_NAMESPACE" "$EXPECTED_RELEASE" \
  "$actual_revision" "$actual_chart"
[[ "$apply" == true ]] || { printf 'no mutation performed\n'; exit 0; }
[[ "$confirm_target" == "$expected_confirmation" ]] || die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${expected_confirmation}"
[[ "$fixture_legacy" == true || "$actual_chart" == "$EXPECTED_REPAIR_CHART" ]] || die "FORWARD_SOURCE_CHART_UNSAFE actual=${actual_chart}"

owner_metadata() {
  local inventory="" resource namespace name object canonical
  if [[ -n "${FALCONE_STAGING_REAL_HELM:-}" ]]; then
    kubectl -n external-secrets get deployment external-secrets -o json | jq -cS \
      '{apiVersion:(.apiVersion // "apps/v1"),kind:(.kind // "Deployment"),metadata:{name:.metadata.name,namespace:.metadata.namespace,uid:(.metadata.uid // null),labels:(.metadata.labels // {}),annotations:(.metadata.annotations // {}),ownerReferences:(.metadata.ownerReferences // [])}}'
    return
  fi
  while IFS='|' read -r resource namespace name; do
    if [[ "$namespace" == cluster ]]; then
      object="$(kubectl get "$resource" "$name" -o json)" || return 1
    else
      object="$(kubectl -n "$namespace" get "$resource" "$name" -o json)" || return 1
    fi
    canonical="$(printf '%s' "$object" | jq -cS \
      '{apiVersion,kind,metadata:{name:.metadata.name,namespace:(.metadata.namespace // null),uid:(.metadata.uid // null),labels:(.metadata.labels // {}),annotations:(.metadata.annotations // {}),ownerReferences:(.metadata.ownerReferences // [])}}')" || return 1
    inventory="${inventory}${canonical}"$'\n'
  done <<'OWNER_INVENTORY'
serviceaccount|external-secrets|external-secrets
serviceaccount|external-secrets|external-secrets-cert-controller
serviceaccount|external-secrets|external-secrets-webhook
deployment.apps|external-secrets|external-secrets
deployment.apps|external-secrets|external-secrets-cert-controller
deployment.apps|external-secrets|external-secrets-webhook
service|external-secrets|external-secrets-metrics
service|external-secrets|external-secrets-cert-controller-metrics
service|external-secrets|external-secrets-webhook
service|external-secrets|external-secrets-webhook-metrics
role.rbac.authorization.k8s.io|external-secrets|external-secrets-leaderelection
rolebinding.rbac.authorization.k8s.io|external-secrets|external-secrets-leaderelection
clusterrole.rbac.authorization.k8s.io|cluster|external-secrets-controller
clusterrole.rbac.authorization.k8s.io|cluster|external-secrets-cert-controller
clusterrole.rbac.authorization.k8s.io|cluster|external-secrets-edit
clusterrole.rbac.authorization.k8s.io|cluster|external-secrets-view
clusterrole.rbac.authorization.k8s.io|cluster|external-secrets-servicebindings
clusterrolebinding.rbac.authorization.k8s.io|cluster|external-secrets-controller
clusterrolebinding.rbac.authorization.k8s.io|cluster|external-secrets-cert-controller
validatingwebhookconfiguration.admissionregistration.k8s.io|cluster|externalsecret-validate
validatingwebhookconfiguration.admissionregistration.k8s.io|cluster|secretstore-validate
OWNER_INVENTORY
  printf '%s' "$inventory" | LC_ALL=C sort
}

owner_before="$(owner_metadata)"
mutation_started=true
helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --wait --timeout 20m "${args[@]}"
if kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" >/dev/null 2>&1; then
  kubectl -n "$EXPECTED_NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound pvc/"$EXPECTED_PVC" --timeout=5m
fi
kubectl -n "$EXPECTED_NAMESPACE" rollout status statefulset/"$EXPECTED_VECTOR_STATEFULSET" --timeout=10m
kubectl -n "$EXPECTED_NAMESPACE" rollout status deployment/falcone-ferretdb --timeout=10m
owner_after="$(owner_metadata)"
[[ "$owner_after" == "$owner_before" ]] || die "EXTERNAL_ESO_OWNER_METADATA_CHANGED"
printf 'forward-recovery=applied rollback=not-used package-digest=%s\n' "${package_digest:-fixture-only-unbound-digest}"
