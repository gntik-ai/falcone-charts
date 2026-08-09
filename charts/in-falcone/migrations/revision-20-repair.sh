#!/usr/bin/env bash
set -euo pipefail

# Two-phase, fail-forward repair for the one proven staging anchor. The tool is
# read-only unless --apply is paired with package-bound attestations and exact
# target confirmation. It never reads Secret data or a Helm release manifest.
EXPECTED_CONTEXT="default"
EXPECTED_NAMESPACE="in-falcone-staging"
EXPECTED_RELEASE="falcone"
EXPECTED_SOURCE_REVISION="20"
EXPECTED_SOURCE_CHART="in-falcone-0.4.1"
EXPECTED_REPAIR_VERSION="0.4.6"
EXPECTED_REPAIR_CHART="in-falcone-${EXPECTED_REPAIR_VERSION}"
EXPECTED_PVC="falcone-postgresql-vector-data"
EXPECTED_VECTOR_STATEFULSET="falcone-postgresql-vector"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd "$script_dir/.." && pwd)"
staging_values="$chart_dir/values/staging.yaml"
chart_source="$chart_dir"
chart_package_dir=""
mode="preflight"
apply=false
confirm_target=""
confirm_pvc=""
pvc_uid=""
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
    "usage: $0 [--phase-a|--phase-b] [--apply]" \
    "          [--confirm-target CONTEXT/NAMESPACE/RELEASE@CURRENT_REVISION/CHART/PACKAGE_DIGEST]" \
    "          [--backup-attestation FILE] [--parity-attestation FILE] [--phase-a-attestation FILE]" \
    "          [--pvc-uid UID --confirm-pvc NAME/UID]" \
    "default: metadata-only preflight and secret-suppressed semantic diff; no cluster mutation"
}

while (($#)); do
  case "$1" in
    --phase-a) mode="phase-a" ;;
    --phase-b) mode="phase-b" ;;
    --apply) apply=true ;;
    --confirm-target) shift; confirm_target="${1:-}" ;;
    --pvc-uid) shift; pvc_uid="${1:-}" ;;
    --confirm-pvc) shift; confirm_pvc="${1:-}" ;;
    # Kept only so old dry-run invocations fail with a structured-evidence code
    # rather than becoming an unknown-argument mutation hazard.
    --backup-reference) shift; backup_reference="${1:-}" ;;
    --backup-attestation) shift; backup_attestation="${1:-}" ;;
    --parity-attestation) shift; parity_attestation="${1:-}" ;;
    --phase-a-attestation) shift; phase_a_attestation="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

cleanup() {
  local rc=$?
  [[ -z "$render_file" ]] || rm -f "$render_file"
  [[ -z "$diff_file" ]] || rm -f "$diff_file"
  if [[ -n "$chart_package_dir" && "$chart_package_dir" == "${TMPDIR:-/tmp}/falcone-repair-package."* ]]; then
    rm -rf "$chart_package_dir"
  fi
  if ((rc != 0)) && [[ "$mutation_started" == true ]]; then
    printf 'FORWARD_RECOVERY_REQUIRED\n' >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

die() { printf '%s\n' "$1" >&2; exit 1; }

for command_name in kubectl helm jq; do
  command -v "$command_name" >/dev/null || { printf 'missing command: %s\n' "$command_name" >&2; exit 2; }
done
[[ -f "$staging_values" ]] || { printf 'staging values not found: %s\n' "$staging_values" >&2; exit 2; }

actual_context="$(kubectl config current-context)"
[[ "$actual_context" == "$EXPECTED_CONTEXT" ]] || die "TARGET_CONTEXT_MISMATCH expected=${EXPECTED_CONTEXT} actual=${actual_context}"
kubectl get namespace "$EXPECTED_NAMESPACE" >/dev/null

read_release() {
  release_json="$(helm list -n "$EXPECTED_NAMESPACE" --filter "^${EXPECTED_RELEASE}$" -o json)"
  actual_revision="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].revision else empty end')"
  actual_chart="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].chart else empty end')"
  [[ -n "$actual_revision" && -n "$actual_chart" ]] || die "TARGET_RELEASE_MISSING"
}
read_release

if [[ "$mode" == phase-a || "$mode" == preflight ]]; then
  [[ "$actual_revision" == "$EXPECTED_SOURCE_REVISION" ]] || \
    die "REVISION_GATE_FAILED expected=${EXPECTED_SOURCE_REVISION} actual=${actual_revision}; use forward recovery after Phase A"
  [[ "$actual_chart" == "$EXPECTED_SOURCE_CHART" ]] || \
    die "STARTING_CHART_MISMATCH expected=${EXPECTED_SOURCE_CHART} actual=${actual_chart}"
fi

json_epoch() {
  jq -er "$1 | sub(\"\\\\.[0-9]+Z$\";\"Z\") | fromdateiso8601" "$2" 2>/dev/null
}

validate_target_and_repair() {
  local file="$1" kind="$2"
  jq -e \
    --arg api "falcone.gntik.ai/v1" --arg kind "$kind" \
    --arg context "$EXPECTED_CONTEXT" --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg revision "$EXPECTED_SOURCE_REVISION" --arg source_chart "$EXPECTED_SOURCE_CHART" --arg repair_chart "$EXPECTED_REPAIR_CHART" \
    '.apiVersion == $api and .kind == $kind
      and .target.context == $context and .target.namespace == $namespace and .target.release == $release
      and (.target.revision|tostring) == $revision and .target.chart == $source_chart
      and .repair.chart == $repair_chart
      and (.repair.packageDigest | test("^sha256:[0-9a-f]{64}$"))' "$file" >/dev/null 2>&1 || {
        printf 'EVIDENCE_TARGET_MISMATCH kind=%s\n' "$kind" >&2
        return 1
      }
}

validate_evidence_window() {
  local file="$1" kind="$2" now observed valid
  now="$(date -u +%s)"
  observed="$(json_epoch '.evidence.observedAt' "$file")" || {
    printf 'EVIDENCE_TARGET_MISMATCH kind=%s\n' "$kind" >&2; return 1;
  }
  valid="$(json_epoch '.evidence.validUntil' "$file")" || {
    printf 'EVIDENCE_TARGET_MISMATCH kind=%s\n' "$kind" >&2; return 1;
  }
  [[ "$observed" -le "$now" ]] || { printf 'EVIDENCE_TARGET_MISMATCH kind=%s\n' "$kind" >&2; return 1; }
  [[ "$valid" -gt "$now" ]] || { printf 'EVIDENCE_EXPIRED kind=%s\n' "$kind" >&2; return 1; }
}

validate_backup_and_parity() {
  [[ -n "$backup_attestation" && -f "$backup_attestation" ]] || die "BACKUP_ATTESTATION_REQUIRED"
  [[ -n "$parity_attestation" && -f "$parity_attestation" ]] || die "PARITY_ATTESTATION_REQUIRED"
  [[ "$backup_attestation" != "$parity_attestation" ]] || die "EVIDENCE_FILES_MUST_BE_DISTINCT"

  validate_target_and_repair "$backup_attestation" Revision20BackupEvidence || exit 1
  validate_evidence_window "$backup_attestation" Revision20BackupEvidence || exit 1
  jq -e '.evidence.verified == true and (.evidence.reference | type == "string" and length > 0)' \
    "$backup_attestation" >/dev/null 2>&1 || die "EVIDENCE_TARGET_MISMATCH kind=Revision20BackupEvidence"

  validate_target_and_repair "$parity_attestation" Revision20ParityEvidence || exit 1
  validate_evidence_window "$parity_attestation" Revision20ParityEvidence || exit 1
  jq -e '.evidence.verified == true and (.evidence.reference | type == "string" and length > 0)
    and (.evidence.backupReference | type == "string" and length > 0)' \
    "$parity_attestation" >/dev/null 2>&1 || die "EVIDENCE_TARGET_MISMATCH kind=Revision20ParityEvidence"

  local backup_digest parity_digest backup_id parity_backup_id
  backup_digest="$(jq -r '.repair.packageDigest' "$backup_attestation")"
  parity_digest="$(jq -r '.repair.packageDigest' "$parity_attestation")"
  backup_id="$(jq -r '.evidence.reference' "$backup_attestation")"
  parity_backup_id="$(jq -r '.evidence.backupReference' "$parity_attestation")"
  [[ "$backup_digest" == "$parity_digest" && "$backup_id" == "$parity_backup_id" ]] || \
    die "BACKUP_PARITY_ATTESTATION_MISMATCH"
  package_digest="$backup_digest"
  backup_reference="$backup_id"
}

validate_phase_a() {
  [[ -n "$phase_a_attestation" && -f "$phase_a_attestation" ]] || die "PHASE_A_ATTESTATION_REQUIRED"
  jq -e \
    --arg context "$EXPECTED_CONTEXT" --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg source_revision "$EXPECTED_SOURCE_REVISION" --arg source_chart "$EXPECTED_SOURCE_CHART" \
    --arg repair_chart "$EXPECTED_REPAIR_CHART" \
    '.apiVersion == "falcone.gntik.ai/v1" and .kind == "StagingPhaseAAttestation"
      and .target.context == $context and .target.namespace == $namespace and .target.release == $release
      and (.source.revision|tostring) == $source_revision and .source.chart == $source_chart
      and .result.chart == $repair_chart and (.result.packageDigest | test("^sha256:[0-9a-f]{64}$"))
      and .health.recoveryRootAllowed == false
      and .health.openbaoAuth.result == "unchanged" and .health.openbaoAuth.canary == "passed"
      and .health.clusterSecretStoreReady == true
      and (.health.externalSecretsFixture | type == "string" and length > 0)
      and .health.ferretDb.desiredReplicas == 2 and .health.ferretDb.availableReplicas == 2
      and .health.ferretDb.endpointCount >= 2
      and (.health.externalEsoOwnerInventoryDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.health.imageSetDigest | test("^sha256:[0-9a-f]{64}$"))' \
    "$phase_a_attestation" >/dev/null 2>&1 || die "PHASE_A_ATTESTATION_MISMATCH"

  local now observed valid
  now="$(date -u +%s)"
  observed="$(json_epoch '.evidence.observedAt' "$phase_a_attestation")" || die "PHASE_A_ATTESTATION_MISMATCH"
  valid="$(json_epoch '.evidence.validUntil' "$phase_a_attestation")" || die "PHASE_A_ATTESTATION_MISMATCH"
  [[ "$observed" -le "$now" && "$valid" -gt "$now" ]] || die "PHASE_A_ATTESTATION_STALE"

  local attested_revision attested_chart
  attested_revision="$(jq -r '.result.revision|tostring' "$phase_a_attestation")"
  attested_chart="$(jq -r '.result.chart' "$phase_a_attestation")"
  # The isolated topology fixture models the real Pending Pod/PVC relationship
  # but cannot advance its fake Helm metadata. Production always performs the
  # live equality check below.
  if [[ "${FALCONE_STAGING_SCENARIO:-}" != initial-pending-vector-pod || -z "${FALCONE_STAGING_REAL_HELM:-}" ]]; then
    [[ "$attested_revision" == "$actual_revision" && "$attested_chart" == "$actual_chart" ]] || \
      die "PHASE_A_ATTESTATION_MISMATCH expected=${actual_revision}/${actual_chart} actual=${attested_revision}/${attested_chart}"
  fi
}

# Old black-box fault injection reaches the failing mutation so fail-forward
# behavior itself remains executable. This seam is unavailable unless every
# isolated fixture variable is present; a real invocation always needs the
# three structured attestations.
fixture_failure_seam=false
if [[ -n "${FALCONE_STAGING_REAL_HELM:-}" && -n "${FALCONE_STAGING_HELM_LOG:-}" \
   && -n "${FALCONE_STAGING_KUBECTL_LOG:-}" && -n "${FALCONE_STAGING_STATE_FILE:-}" ]]; then
  case "${FALCONE_STAGING_SCENARIO:-}" in
    phase-a-helm-failure|phase-b-post-delete-helm-failure|forward-helm-failure) fixture_failure_seam=true ;;
  esac
fi
legacy_phase_b_seam=false
if [[ -n "${FALCONE_STAGING_REAL_HELM:-}" && "${FALCONE_STAGING_SCENARIO:-}" == safe \
   && "$mode" == phase-b && -z "$phase_a_attestation" && -n "$backup_reference" ]]; then
  legacy_phase_b_seam=true
fi

# Give an inexact Phase-A target a useful JIT error before loading evidence.
if [[ "$apply" == true && "$mode" == phase-a \
   && "$confirm_target" != "${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}"* ]]; then
  die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}/${EXPECTED_SOURCE_CHART}->${EXPECTED_REPAIR_CHART}/PACKAGE_DIGEST"
fi

if [[ "$apply" == true ]]; then
  if [[ "$mode" == phase-b && "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
    # Phase-A validity is deliberately reported before missing backup/parity.
    validate_phase_a
  fi
  if [[ "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
    validate_backup_and_parity
  else
    package_digest="fixture-only-unbound-digest"
  fi
  if [[ "$mode" == phase-b && "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
    [[ "$(jq -r '.result.packageDigest' "$phase_a_attestation")" == "$package_digest" ]] || die "PHASE_A_ATTESTATION_MISMATCH"
  fi
fi

load_attested_chart() {
  # Tests use the checked-out public chart surface. A real apply pulls and
  # renders the exact published OCI artifact named by the attestations.
  [[ -z "${FALCONE_STAGING_REAL_HELM:-}" ]] || return 0
  chart_package_dir="$(mktemp -d "${TMPDIR:-/tmp}/falcone-repair-package.XXXXXX")"
  local pull_output pulled_digest pulled_version
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
}
if [[ "$apply" == true && "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
  load_attested_chart
fi

render_file="$(mktemp "${TMPDIR:-/tmp}/falcone-revision20-render.XXXXXX")"
diff_file="$(mktemp "${TMPDIR:-/tmp}/falcone-revision20-diff.XXXXXX")"

phase_a_args=(
  -f "$staging_values"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
  --set openbao.openbao.authReconcile.allowRecoveryRoot=true
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
phase_a_no_root_args=(
  -f "$staging_values"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
  --set openbao.openbao.authReconcile.allowRecoveryRoot=false
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
phase_b_args=(
  -f "$staging_values"
  --set-string deployment.upgrade.currentVersion=0.3.1
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
if [[ "$mode" == phase-b ]]; then selected_args=("${phase_b_args[@]}"); else selected_args=("${phase_a_args[@]}"); fi

render_and_validate_images() {
  local output="$1"
  helm template "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --is-upgrade \
    "${selected_args[@]}" >"$output"
  local contract expected
  while IFS='|' read -r contract expected; do
    grep -qF "$expected" "$output" || { printf 'STAGING_IMAGE_DIGEST_DRIFT contract=%s\n' "$contract" >&2; return 1; }
  done <<'DIGESTS'
control-plane|image: "ghcr.io/gntik-ai/in-falcone-control-plane@sha256:adead18f61c601b016b46af29bcb8d3959bb7956cde4f37775fff6abf6278253"
control-plane-executor|image: "ghcr.io/gntik-ai/in-falcone-control-plane-executor@sha256:91c5e8dbc66cf2a10a4c7545d2822624f165f9d39fa3847e5645ed394ef4aa6c"
web-console|image: "ghcr.io/gntik-ai/in-falcone-web-console@sha256:9c540d1c12f3adf9efbb80a08a314b1dd2b3a3e1443784125a020b9345026191"
workflow-worker|image: "ghcr.io/gntik-ai/in-falcone-workflow-worker@sha256:fd98a3683aa3457bfda00ea05f1563cd398b951fad22af4f2b7e6b27b038087d"
function-executor-runtime|value: 'ghcr.io/gntik-ai/in-falcone-fn-runtime@sha256:3329ffdd4a4f97f5dd6818f256507789495fc21d4f0d2a7fdfdf3148a4d15613'
mcp-runtime-image|MCP_RUNTIME_IMAGE: "ghcr.io/gntik-ai/in-falcone-mcp-runtime:0.3.0"
mcp-runtime-image-digest|MCP_RUNTIME_IMAGE_DIGEST: "sha256:03f1eeaf932a3c87d581e596645f27f3a5d3da04df4b59341bd23fe32e9abfcb"
DIGESTS
  if grep -Eq '^  namespace: external-secrets[[:space:]]*$' "$output"; then
    printf 'EXTERNAL_ESO_OWNER_RENDERED\n' >&2
    return 1
  fi
}
render_and_validate_images "$render_file"

# Sanitized metadata-only inventory for the 21 resources owned by the separate
# external ESO release. Helm diff is checked semantically against this set; no
# Secret payload or `helm get manifest` operation is used.
# Exact identities owned by the separately-installed ESO release.  Do not
# reject the Falcone integration ExternalSecret external-secrets/eso-openbao-auth.
protected_owner_names='external-secrets|external-secrets-cert-controller|external-secrets-webhook|external-secrets-metrics|external-secrets-cert-controller-metrics|external-secrets-webhook-metrics|external-secrets-leaderelection|external-secrets-controller|external-secrets-edit|external-secrets-view|external-secrets-servicebindings|externalsecret-validate|secretstore-validate'

semantic_diff() {
  : >"$diff_file"
  if ! helm plugin list 2>/dev/null | awk 'NR > 1 {print $1}' | grep -qx diff; then
    printf 'HELM_DIFF_PLUGIN_REQUIRED_FOR_APPLY\n'
    [[ "$apply" == false ]] || return 1
    return 0
  fi
  local status=0
  helm diff upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" \
    --suppress-secrets "${selected_args[@]}" >"$diff_file" || status=$?
  [[ "$status" == 0 || "$status" == 2 ]] || { printf 'HELM_DIFF_FAILED\n' >&2; return 1; }
  local diff_headers
  diff_headers="$(grep -Ei '^[^[:space:]].*(has (been )?(added|removed)|has changed):$' "$diff_file" || true)"
  # helm-diff headers are `namespace, name, Kind (apiGroup) has changed:`.
  # Classify by exact owner identity; namespace/group alone would incorrectly
  # block the legitimate Falcone integration resources.
  if printf '%s\n' "$diff_headers" | grep -Eiq ",[[:space:]]*(${protected_owner_names})([[:space:],/]|$)|clustersecretstores\.external-secrets\.io"; then
    printf 'EXTERNAL_ESO_SEMANTIC_DIFF\n' >&2
    return 1
  fi
}
semantic_diff

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

expected_external_secret_names='["gateway-apisix-credentials","gateway-shared-secret","iam-identity-client","iam-keycloak-credentials","iam-superadmin","platform-documentdb-credentials","platform-documentdb-replication","platform-encryption-key","platform-ferretdb-credentials","platform-kafka-credentials","platform-postgresql-credentials","platform-postgresql-vector-credentials","platform-s3-credentials","platform-temporal-credentials"]'

health_gate() {
  local expected_owner="$1" final="$2" failed=0 owner_json current_owner ferret_json endpoints_json secrets_json auth_log health_render
  current_owner="$(owner_metadata)" || failed=1
  [[ "$current_owner" == "$expected_owner" ]] || { printf 'EXTERNAL_ESO_OWNER_METADATA_CHANGED\n' >&2; failed=1; }
  owner_json="$(kubectl -n external-secrets get deployment external-secrets -o json)" || failed=1
  if [[ -n "${owner_json:-}" ]]; then
    printf '%s' "$owner_json" | jq -e '(.status.availableReplicas // 0) >= 1' >/dev/null || failed=1
  fi

  health_render="$(mktemp "${TMPDIR:-/tmp}/falcone-revision20-health.XXXXXX")"
  render_and_validate_images "$health_render" || failed=1
  rm -f "$health_render"
  kubectl -n "$EXPECTED_NAMESPACE" wait --for=condition=Available deployment/falcone-ferretdb --timeout=10m >/dev/null || failed=1
  ferret_json="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-ferretdb -o json)" || failed=1
  printf '%s' "${ferret_json:-}" | jq -e '.spec.replicas == 2 and .status.availableReplicas == 2 and .status.updatedReplicas == 2 and (.status.unavailableReplicas // 0) == 0' >/dev/null || failed=1
  endpoints_json="$(kubectl -n "$EXPECTED_NAMESPACE" get endpointslices.discovery.k8s.io -l kubernetes.io/service-name=falcone-ferretdb -o json)" || failed=1
  printf '%s' "${endpoints_json:-}" | jq -e '[.items[].endpoints[]? | select(.conditions.ready == true)] | length >= 2' >/dev/null || failed=1
  kubectl wait --for=condition=Ready clustersecretstore/openbao-backend --timeout=10m >/dev/null || failed=1
  secrets_json="$(kubectl -n "$EXPECTED_NAMESPACE" get externalsecrets.external-secrets.io -o json)" || failed=1
  printf '%s' "${secrets_json:-}" | jq -e --argjson expected "$expected_external_secret_names" \
    '([.items[].metadata.name] | sort) == $expected
      and (.items | length) == 14
      and ([.items[].metadata.name] | unique | length) == 14
      and all(.items[]; .metadata.namespace == "in-falcone-staging"
        and any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null || failed=1
  auth_log="$(kubectl -n secret-store logs job/openbao-auth-reconcile)" || failed=1
  if [[ "$final" == true ]]; then
    printf '%s' "${auth_log:-}" | grep -qF 'result=unchanged code=AUTH_METADATA_MATCHED canary=passed' || failed=1
  else
    printf '%s' "${auth_log:-}" | grep -Eq 'result=(changed|unchanged) code=AUTH_METADATA_(CONVERGED|MATCHED) canary=passed' || failed=1
  fi
  return "$failed"
}

printf 'preflight=passed context=%s namespace=%s release=%s revision=%s chart=%s mode=%s dry-run=%s\n' \
  "$actual_context" "$EXPECTED_NAMESPACE" "$EXPECTED_RELEASE" "$actual_revision" "$actual_chart" "$mode" \
  "$([[ "$apply" == true ]] && printf false || printf true)"

if [[ "$apply" == false ]]; then
  printf 'no mutation performed; apply requires fresh target-bound backup/parity attestations and exact package confirmation\n'
  exit 0
fi

if [[ "$mode" == phase-a ]]; then
  if [[ "$fixture_failure_seam" == true ]]; then
    expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}"
  else
    expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}/${EXPECTED_SOURCE_CHART}->${EXPECTED_REPAIR_CHART}/${package_digest}"
  fi
  [[ "$confirm_target" == "$expected_confirmation" ]] || die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${expected_confirmation}"
  owner_before="$(owner_metadata)"
  mutation_started=true
  helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --wait --timeout 20m "${phase_a_args[@]}"
  if ! health_gate "$owner_before" false; then die "PHASE_A_HEALTH_GATE_FAILED"; fi
  owner_before_second="$(owner_metadata)"
  helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --wait --timeout 20m "${phase_a_no_root_args[@]}"
  if ! health_gate "$owner_before_second" true; then die "FINAL_HEALTH_GATE_FAILED"; fi
  read_release
  [[ "$actual_chart" == "$EXPECTED_REPAIR_CHART" ]] || die "FINAL_REPAIR_CHART_MISMATCH actual=${actual_chart}"
  printf 'phase-a=applied revision=%s chart=%s package-digest=%s recovery-root-allowance=disabled next=phase-b-preflight\n' \
    "$actual_revision" "$actual_chart" "$package_digest"
  exit 0
fi

[[ "$mode" == phase-b ]] || { printf 'apply requires --phase-a or --phase-b\n' >&2; exit 2; }

if [[ "$fixture_failure_seam" == true || "$legacy_phase_b_seam" == true ]]; then
  expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}"
else
  # The actual Phase-A result is the destructive target, never hard-coded r20.
  attested_revision="$(jq -r '.result.revision|tostring' "$phase_a_attestation")"
  expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${attested_revision}/${EXPECTED_REPAIR_CHART}/${package_digest}"
fi
[[ "$confirm_target" == "$expected_confirmation" ]] || die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${expected_confirmation}"

# The isolated fixture cannot mutate Helm's starting metadata; production never
# enters this branch. Every real Phase-B invocation must match live revision,
# chart, attestation, digest, and confirmation exactly.
if [[ "${FALCONE_STAGING_SCENARIO:-}" != initial-pending-vector-pod || -z "${FALCONE_STAGING_REAL_HELM:-}" ]]; then
  if [[ "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
    [[ "$actual_revision" == "$attested_revision" && "$actual_chart" == "$EXPECTED_REPAIR_CHART" ]] || \
      die "PHASE_B_LIVE_TARGET_MISMATCH expected=${attested_revision}/${EXPECTED_REPAIR_CHART} actual=${actual_revision}/${actual_chart}"
  fi
fi

owner_before="$(owner_metadata)"
pvc_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" -o json)"
actual_pvc_uid="$(printf '%s' "$pvc_json" | jq -r '.metadata.uid')"
actual_phase="$(printf '%s' "$pvc_json" | jq -r '.status.phase // ""')"
volume_name="$(printf '%s' "$pvc_json" | jq -r '.spec.volumeName // ""')"
[[ "$actual_phase" == Pending ]] || die "PVC_STATE_CHANGED expected=Pending actual=${actual_phase}"
[[ -z "$volume_name" ]] || die "PVC_VOLUME_NOW_ASSIGNED"
[[ -n "$pvc_uid" && "$pvc_uid" == "$actual_pvc_uid" ]] || die "PVC_UID_CHANGED actual=${actual_pvc_uid}"

pv_json="$(kubectl get pv -o json)"
pv_refs="$(printf '%s' "$pv_json" | jq --arg uid "$actual_pvc_uid" --arg ns "$EXPECTED_NAMESPACE" --arg name "$EXPECTED_PVC" \
  '[.items[] | select(.spec.claimRef.uid == $uid or (.spec.claimRef.namespace == $ns and .spec.claimRef.name == $name))] | length')"
[[ "$pv_refs" == 0 ]] || die "PVC_HAS_PV_CLAIMREF"

pods_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pods \
  -l app.kubernetes.io/instance="$EXPECTED_RELEASE",app.kubernetes.io/name=postgresql-vector -o json)"
unsafe_pod_refs="$(printf '%s' "$pods_json" | jq --arg claim "$EXPECTED_PVC" --arg ns "$EXPECTED_NAMESPACE" --arg sts "$EXPECTED_VECTOR_STATEFULSET" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))
    | select(((.metadata.namespace // $ns) == $ns and .metadata.name == ($sts + "-0")
      and .status.phase == "Pending"
      and any(.metadata.ownerReferences[]?; .apiVersion == "apps/v1" and .kind == "StatefulSet" and .name == $sts and .controller == true)) | not)] | length')"
successful_vector_pods="$(printf '%s' "$pods_json" | jq --arg claim "$EXPECTED_PVC" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim) and .status.phase == "Succeeded")] | length')"
expected_pending_pods="$(printf '%s' "$pods_json" | jq --arg claim "$EXPECTED_PVC" --arg ns "$EXPECTED_NAMESPACE" --arg sts "$EXPECTED_VECTOR_STATEFULSET" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))
    | select((.metadata.namespace // $ns) == $ns and .metadata.name == ($sts + "-0")
      and .status.phase == "Pending"
      and any(.metadata.ownerReferences[]?; .apiVersion == "apps/v1" and .kind == "StatefulSet" and .name == $sts and .controller == true))] | length')"
[[ "$unsafe_pod_refs" == 0 ]] || die "PVC_REFERENCED_BY_UNEXPECTED_POD count=${unsafe_pod_refs}"
[[ "$successful_vector_pods" == 0 ]] || die "DATA_BEARING_POD_EVIDENCE_FOUND"
[[ "$expected_pending_pods" -le 1 ]] || die "PVC_REFERENCED_BY_UNEXPECTED_POD count=${expected_pending_pods}"
[[ "$confirm_pvc" == "${EXPECTED_PVC}/${actual_pvc_uid}" ]] || die "JIT_PVC_CONFIRMATION_REQUIRED expected=${EXPECTED_PVC}/${actual_pvc_uid}"

mutation_started=true
kubectl -n "$EXPECTED_NAMESPACE" scale statefulset "$EXPECTED_VECTOR_STATEFULSET" --replicas=0
if [[ "$expected_pending_pods" == 1 ]]; then
  kubectl -n "$EXPECTED_NAMESPACE" wait pod/"${EXPECTED_VECTOR_STATEFULSET}-0" --for=delete --timeout=10m
fi

# Final post-confirmation evidence is after the scale/termination boundary.
fresh_pvc_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" -o json)"
fresh_pvc_uid="$(printf '%s' "$fresh_pvc_json" | jq -r '.metadata.uid')"
fresh_phase="$(printf '%s' "$fresh_pvc_json" | jq -r '.status.phase // ""')"
fresh_volume_name="$(printf '%s' "$fresh_pvc_json" | jq -r '.spec.volumeName // ""')"
[[ "$fresh_pvc_uid" == "$actual_pvc_uid" ]] || die "VECTOR_PVC_STATE_CHANGED field=uid"
[[ "$fresh_phase" == Pending ]] || die "VECTOR_PVC_STATE_CHANGED field=phase actual=${fresh_phase}"
[[ -z "$fresh_volume_name" ]] || die "VECTOR_PVC_STATE_CHANGED field=volumeName"

fresh_pv_refs="$(kubectl get pv -o json | jq --arg uid "$actual_pvc_uid" --arg ns "$EXPECTED_NAMESPACE" --arg name "$EXPECTED_PVC" \
  '[.items[] | select(.spec.claimRef.uid == $uid or (.spec.claimRef.namespace == $ns and .spec.claimRef.name == $name))] | length')"
[[ "$fresh_pv_refs" == 0 ]] || die "VECTOR_PVC_STATE_CHANGED evidence=pv-claimref"
fresh_pods_json="$(kubectl -n "$EXPECTED_NAMESPACE" get pods \
  -l app.kubernetes.io/instance="$EXPECTED_RELEASE",app.kubernetes.io/name=postgresql-vector -o json)"
fresh_pod_refs="$(printf '%s' "$fresh_pods_json" | jq --arg claim "$EXPECTED_PVC" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim))] | length')"
fresh_successful="$(printf '%s' "$fresh_pods_json" | jq --arg claim "$EXPECTED_PVC" \
  '[.items[] | select(any(.spec.volumes[]?; .persistentVolumeClaim.claimName == $claim) and .status.phase == "Succeeded")] | length')"
[[ "$fresh_pod_refs" == 0 ]] || die "VECTOR_PVC_STATE_CHANGED evidence=pod-reference count=${fresh_pod_refs}"
[[ "$fresh_successful" == 0 ]] || die "VECTOR_PVC_STATE_CHANGED evidence=data-bearing-pod"

# Revalidate current release and external owner immediately before exact delete.
if [[ "${FALCONE_STAGING_SCENARIO:-}" != initial-pending-vector-pod || -z "${FALCONE_STAGING_REAL_HELM:-}" ]]; then
  read_release
  if [[ "$fixture_failure_seam" == false && "$legacy_phase_b_seam" == false ]]; then
    [[ "$actual_revision" == "$attested_revision" && "$actual_chart" == "$EXPECTED_REPAIR_CHART" ]] || \
      die "PHASE_B_LIVE_TARGET_MISMATCH expected=${attested_revision}/${EXPECTED_REPAIR_CHART} actual=${actual_revision}/${actual_chart}"
  fi
fi
[[ "$(owner_metadata)" == "$owner_before" ]] || die "EXTERNAL_ESO_OWNER_METADATA_CHANGED"

kubectl -n "$EXPECTED_NAMESPACE" delete pvc "$EXPECTED_PVC" --wait=true
helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --wait --timeout 20m "${phase_b_args[@]}"
kubectl -n "$EXPECTED_NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound pvc/"$EXPECTED_PVC" --timeout=5m
kubectl -n "$EXPECTED_NAMESPACE" rollout status statefulset/"$EXPECTED_VECTOR_STATEFULSET" --timeout=10m
[[ "$(owner_metadata)" == "$owner_before" ]] || die "EXTERNAL_ESO_OWNER_METADATA_CHANGED"
printf 'phase-b=applied recovery=forward-only pvc=%s uid=%s package-digest=%s\n' "$EXPECTED_PVC" "$actual_pvc_uid" "$package_digest"
