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
EXPECTED_REPAIR_VERSION="0.4.16"
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
auth_job_file=""

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
  [[ -z "$auth_job_file" ]] || rm -f "$auth_job_file"
  if [[ -n "$chart_package_dir" && "$chart_package_dir" == "${TMPDIR:-/tmp}/falcone-repair-package."* ]]; then
    rm -rf "$chart_package_dir"
  fi
  if ((rc != 0)) && [[ "$mutation_started" == true ]]; then
    printf 'mutation_started=true\n' >&2
    printf 'FORWARD_RECOVERY_REQUIRED\n' >&2
  fi
  exit "$rc"
}
trap cleanup EXIT

die() { printf '%s\n' "$1" >&2; exit 1; }

for command_name in kubectl helm jq sha256sum python3; do
  command -v "$command_name" >/dev/null || { printf 'missing command: %s\n' "$command_name" >&2; exit 2; }
done
python3 -c 'import yaml' >/dev/null 2>&1 || { printf 'missing Python module: yaml (PyYAML)\n' >&2; exit 2; }
[[ -f "$staging_values" ]] || { printf 'staging values not found: %s\n' "$staging_values" >&2; exit 2; }

actual_context="$(kubectl config current-context)"
[[ "$actual_context" == "$EXPECTED_CONTEXT" ]] || die "TARGET_CONTEXT_MISMATCH expected=${EXPECTED_CONTEXT} actual=${actual_context}"
kubectl get namespace "$EXPECTED_NAMESPACE" >/dev/null

read_release() {
  release_json="$(helm list -n "$EXPECTED_NAMESPACE" --filter "^${EXPECTED_RELEASE}$" -o json)"
  actual_revision="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].revision else empty end')"
  actual_chart="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].chart else empty end')"
  actual_status="$(printf '%s' "$release_json" | jq -r 'if length == 1 then .[0].status else empty end')"
  [[ -n "$actual_revision" && -n "$actual_chart" && -n "$actual_status" ]] || die "TARGET_RELEASE_MISSING"
}
read_release

validate_failed_resume_state() {
  local history latest prior revision22 revision23
  history="$(helm history "$EXPECTED_RELEASE" -n "$EXPECTED_NAMESPACE" -o json)" || die "HELM_HISTORY_UNAVAILABLE"
  latest="$(printf '%s' "$history" | jq -c 'sort_by(.revision) | last')"
  prior="$(printf '%s' "$history" | jq -c 'sort_by(.revision) | map(select(.revision == 20)) | last')"
  revision22="$(printf '%s' "$history" | jq -c 'sort_by(.revision) | map(select(.revision == 22)) | last')"
  revision23="$(printf '%s' "$history" | jq -c 'sort_by(.revision) | map(select(.revision == 23)) | last')"
  printf '%s' "$latest" | jq -e \
    --arg revision "$actual_revision" --arg chart "$actual_chart" --arg status "$actual_status" \
    '(.revision | tostring) == $revision and .chart == $chart and .status == $status' >/dev/null || \
    die "FAILED_RESUME_LIST_HISTORY_MISMATCH"
  printf '%s' "$latest" | jq -e '
    if .revision == 24 then
      .status == "failed" and .chart == "in-falcone-0.4.11"
      and ((.description // "") as $description
        | ($description | startswith("Upgrade \"falcone\" failed: resource PersistentVolumeClaim/in-falcone-staging/falcone-postgresql-vector-data not ready. status: InProgress, message: PVC is not Bound. phase: Pending\n"))
        and ($description | endswith("\ncontext deadline exceeded"))
        and all([
            "resource PersistentVolumeClaim/in-falcone-staging/falcone-postgresql-vector-data not ready. status: InProgress, message: PVC is not Bound. phase: Pending",
            "resource StatefulSet/in-falcone-staging/falcone-postgresql-vector not ready. status: InProgress, message: Ready: 0/1",
            "resource ClusterSecretStore//openbao-backend not ready. status: InProgress, message: unable to create client",
            "resource ExternalSecret/in-falcone-staging/gateway-apisix-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/gateway-shared-secret not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/iam-identity-client not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/iam-keycloak-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/iam-superadmin not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-documentdb-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-documentdb-replication not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-encryption-key not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-ferretdb-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-kafka-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-postgresql-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-postgresql-vector-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-s3-credentials not ready. status: InProgress, message: could not get secret data from provider",
            "resource ExternalSecret/in-falcone-staging/platform-temporal-credentials not ready. status: InProgress, message: could not get secret data from provider"
          ][]; $description | contains(.)))
    elif .revision == 23 then
      .status == "failed" and .chart == "in-falcone-0.4.9"
      and (.description // "") == "Upgrade \"falcone\" failed: context canceled"
    elif .revision == 22 then
      .status == "failed" and .chart == "in-falcone-0.4.8"
      and ((.description // "") as $description
        | all([
            "falcone-documentdb-data",
            "falcone-kafka-data",
            "falcone-observability-data",
            "falcone-postgresql-data",
            "falcone-seaweedfs-filer",
            "falcone-seaweedfs-master"
          ][]; $description | contains(.))
        and ($description | contains("Forbidden")))
    elif .revision == 21 then
      .status == "failed" and .chart == "in-falcone-0.4.7"
      and ((.description // "") | test("falcone-in-falcone-webhook-key-credential"))
    else false end' >/dev/null || die "FAILED_RESUME_STATE_UNSAFE"
  printf '%s' "$prior" | jq -e '
    .revision == 20 and .status == "deployed" and .chart == "in-falcone-0.4.1"
    and (.description // "") == "Upgrade complete"' >/dev/null || die "FAILED_RESUME_SOURCE_UNSAFE"
  if [[ "$actual_revision" == 23 || "$actual_revision" == 24 ]]; then
    printf '%s' "$revision22" | jq -e '
      .revision == 22 and .status == "failed" and .chart == "in-falcone-0.4.8"
      and ((.description // "") as $description
        | all([
            "falcone-documentdb-data",
            "falcone-kafka-data",
            "falcone-observability-data",
            "falcone-postgresql-data",
            "falcone-seaweedfs-filer",
            "falcone-seaweedfs-master"
          ][]; $description | contains(.))
        and ($description | contains("Forbidden")))' >/dev/null || die "FAILED_RESUME_PREDECESSOR_UNSAFE"
  fi
  if [[ "$actual_revision" == 24 ]]; then
    printf '%s' "$revision23" | jq -e '
      .revision == 23 and .status == "failed" and .chart == "in-falcone-0.4.9"
      and (.description // "") == "Upgrade \"falcone\" failed: context canceled"' >/dev/null || \
      die "FAILED_RESUME_PREDECESSOR_UNSAFE"
  fi
  printf 'failed-resume=validated failedRevision=%s sourceRevision=20 sourceChart=in-falcone-0.4.1\n' "$(printf '%s' "$latest" | jq -r .revision)"
}

validate_legacy_webhook_contract() {
  local values
  values="$(helm get values "$EXPECTED_RELEASE" -n "$EXPECTED_NAMESPACE" --revision 20 -o json)" || die "LEGACY_WEBHOOK_VALUES_UNAVAILABLE"
  printf '%s' "$values" | jq -e '
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
  local deployment
  deployment="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-control-plane -o json)" || die "LEGACY_WEBHOOK_DEPLOYMENT_UNAVAILABLE"
  printf '%s' "$deployment" | jq -e '
    ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY")]
      | any(.valueFrom.secretKeyRef.name == "falcone-webhook-signing-key-c25-legacy" and .valueFrom.secretKeyRef.key == "key"))
    and ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY_MODE")]
      | any(.value == "legacy"))
    and ([.spec.template.spec.containers[]?.env[]? | select(.name == "WEBHOOK_SIGNING_KEY_MANAGED")]
      | any(.value == "false"))
    and ((.spec.template.metadata.annotations["in-falcone.io/webhook-key-id"] // "") | test("^wk1:[0-9a-f]{64}$"))' >/dev/null || die "LEGACY_WEBHOOK_DEPLOYMENT_DRIFT"
  printf 'legacy-webhook-contract=validated sourceRevision=20 secretName=falcone-webhook-signing-key-c25-legacy adoption=legacy rotation=none\n'
}

validate_failed_storage_contract() {
  [[ "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 ]] || return 0
  local values object name component claim child
  values="$(helm get values "$EXPECTED_RELEASE" -n "$EXPECTED_NAMESPACE" --revision 20 -o json)" || \
    die "LEGACY_STORAGE_VALUES_UNAVAILABLE"
  printf '%s' "$values" | jq -e '
    all([.documentdb, .kafka, .observability, .postgresql][];
      .persistence.storageClass == "local-path" and .persistence.size == "10Gi")
    and .seaweedfs.filer.data.storageClass == "hcloud-volumes"
    and .seaweedfs.filer.data.size == "10Gi"
    and .seaweedfs.master.data.storageClass == "hcloud-volumes"
    and .seaweedfs.master.data.size == "10Gi"' >/dev/null || die "LEGACY_STORAGE_CONTRACT_DRIFT"

  for name in falcone-documentdb-data falcone-kafka-data falcone-observability-data falcone-postgresql-data; do
    object="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$name" -o json)" || die "IMMUTABLE_STORAGE_RESOURCE_MISSING name=${name}"
    printf '%s' "$object" | jq -e --arg name "$name" --arg namespace "$EXPECTED_NAMESPACE" '
      .metadata.name == $name and .metadata.namespace == $namespace
      and .status.phase == "Bound" and .spec.storageClassName == "local-path"
      and .spec.resources.requests.storage == "10Gi"
      and (.spec.volumeName | type == "string" and length > 0)' >/dev/null || \
      die "IMMUTABLE_STORAGE_CONTRACT_DRIFT resource=PersistentVolumeClaim/${name}"
  done

  for component in filer master; do
    name="falcone-seaweedfs-${component}"
    if [[ "$component" == filer ]]; then claim=data-filer; else claim=data-in-falcone-staging; fi
    object="$(kubectl -n "$EXPECTED_NAMESPACE" get statefulset "$name" -o json)" || \
      die "IMMUTABLE_STORAGE_RESOURCE_MISSING name=${name}"
    printf '%s' "$object" | jq -e \
      --arg name "$name" --arg component "$component" --arg claim "$claim" '
      .metadata.name == $name and .metadata.namespace == "in-falcone-staging"
      and .spec.serviceName == $name
      and .spec.selector.matchLabels["app.kubernetes.io/name"] == "seaweedfs"
      and .spec.selector.matchLabels["app.kubernetes.io/instance"] == "falcone"
      and .spec.selector.matchLabels["app.kubernetes.io/component"] == $component
      and (.spec.volumeClaimTemplates | length) == 1
      and .spec.volumeClaimTemplates[0].metadata.name == $claim
      and .spec.volumeClaimTemplates[0].spec.accessModes == ["ReadWriteOnce"]
      and .spec.volumeClaimTemplates[0].spec.storageClassName == "hcloud-volumes"
      and .spec.volumeClaimTemplates[0].spec.resources.requests.storage == "10Gi"' >/dev/null || \
      die "IMMUTABLE_STORAGE_CONTRACT_DRIFT resource=StatefulSet/${name}"

    child="${claim}-${name}-0"
    object="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$child" -o json)" || \
      die "IMMUTABLE_STORAGE_RESOURCE_MISSING name=${child}"
    printf '%s' "$object" | jq -e --arg name "$child" --arg namespace "$EXPECTED_NAMESPACE" '
      .metadata.name == $name and .metadata.namespace == $namespace
      and .status.phase == "Bound" and .spec.storageClassName == "local-path"
      and .spec.resources.requests.storage == "10Gi"
      and (.spec.volumeName | type == "string" and length > 0)' >/dev/null || \
      die "IMMUTABLE_STORAGE_CONTRACT_DRIFT resource=PersistentVolumeClaim/${child}"
  done
  printf 'immutable-storage-contract=validated sourceRevision=20 failedRevision=%s standalonePvcs=4 seaweedfsStatefulSets=2 childPvcs=2\n' "$actual_revision"
}

revision23_state=""
revision24_state=""
validate_revision23_named_user_failure() {
  [[ "$actual_revision" == 23 ]] || return 0
  local deployments pods all_pods configmap config_hash replicasets
  local apisix_deployment_uid apisix_deployment_generation active_apisix_replicaset
  local active_apisix_replicaset_name active_apisix_replicaset_uid
  deployments="$(kubectl -n "$EXPECTED_NAMESPACE" get deployments \
    -l app.kubernetes.io/instance="$EXPECTED_RELEASE" -o json)" || die "REVISION23_DEPLOYMENTS_UNAVAILABLE"
  pods="$(kubectl -n "$EXPECTED_NAMESPACE" get pods \
    -l app.kubernetes.io/instance="$EXPECTED_RELEASE" -o json)" || die "REVISION23_PODS_UNAVAILABLE"

  if printf '%s' "$deployments" | jq -e \
    --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg apisix_image "docker.io/apache/apisix:3.10.0-debian" \
    --arg observability_image "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62" '
    def exact_deployment($name; $component; $image; $desired; $available):
      [.items[] | select(.metadata.name == $name)] as $matches
      | ($matches | length) == 1
      and ($matches[0] as $deployment
        | $deployment.metadata.namespace == $namespace
        and $deployment.metadata.labels["app.kubernetes.io/name"] == $component
        and $deployment.metadata.labels["app.kubernetes.io/instance"] == $release
        and $deployment.spec.selector.matchLabels["app.kubernetes.io/name"] == $component
        and $deployment.spec.selector.matchLabels["app.kubernetes.io/instance"] == $release
        and $deployment.spec.template.metadata.labels["app.kubernetes.io/name"] == $component
        and $deployment.spec.template.metadata.labels["app.kubernetes.io/instance"] == $release
        and ($deployment.metadata.generation | type == "number")
        and $deployment.status.observedGeneration == $deployment.metadata.generation
        and $deployment.spec.replicas == $desired
        and $deployment.status.replicas == ($desired + 1)
        and $deployment.status.availableReplicas == $available
        and $deployment.status.updatedReplicas == 1
        and $deployment.status.unavailableReplicas == 1
        and ([ $deployment.spec.template.spec.containers[]
          | select(.name == $component and .image == $image
            and .securityContext.runAsNonRoot == true
            and (.securityContext | has("runAsUser") | not)
            and (.securityContext | has("runAsGroup") | not)) ] | length) == 1);
    exact_deployment("falcone-apisix"; "apisix"; $apisix_image; 3; 3)
    and exact_deployment("falcone-observability"; "observability"; $observability_image; 1; 1)' \
    >/dev/null; then
    revision23_state="named-user-failure"
  elif printf '%s' "$deployments" | jq -e \
    --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg apisix_image "docker.io/apache/apisix:3.10.0-debian" \
    --arg observability_image "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62" '
    def one($name): [.items[] | select(.metadata.name == $name)] | if length == 1 then .[0] else null end;
    def identity($deployment; $component):
      $deployment.metadata.namespace == $namespace
      and $deployment.metadata.labels["app.kubernetes.io/name"] == $component
      and $deployment.metadata.labels["app.kubernetes.io/instance"] == $release
      and $deployment.spec.selector.matchLabels["app.kubernetes.io/name"] == $component
      and $deployment.spec.selector.matchLabels["app.kubernetes.io/instance"] == $release
      and $deployment.spec.template.metadata.labels["app.kubernetes.io/name"] == $component
      and $deployment.spec.template.metadata.labels["app.kubernetes.io/instance"] == $release;
    def exact_apisix:
      one("falcone-apisix") as $deployment
      | $deployment != null and identity($deployment; "apisix")
      and ($deployment.metadata.uid | type == "string" and length > 0)
      and $deployment.metadata.generation == 7
      and $deployment.status.observedGeneration == 7
      and $deployment.spec.replicas == 3
      and $deployment.status.replicas == 3
      and $deployment.status.updatedReplicas == 3
      and $deployment.status.readyReplicas == 3
      and $deployment.status.availableReplicas == 3
      and (($deployment.status.unavailableReplicas // 0) == 0)
      and ($deployment.spec.template.spec.securityContext as $security
        | $security.fsGroup == 1001
        and $security.fsGroupChangePolicy == "OnRootMismatch"
        and $security.runAsNonRoot == true
        and $security.runAsUser == 636
        and $security.seccompProfile.type == "RuntimeDefault"
        and ($security | has("runAsGroup") | not))
      and ([ $deployment.spec.template.spec.containers[]
        | select(.name == "apisix" and .image == $apisix_image
          and .securityContext.runAsNonRoot == true
          and (.securityContext | has("runAsUser") | not)
          and (.securityContext | has("runAsGroup") | not)
          and (.volumeMounts // []) == [{
            "name": "standalone-config",
            "mountPath": "/usr/local/apisix/conf/apisix.yaml",
            "subPath": "apisix.yaml"
          }]) ] | length) == 1
      and ($deployment.spec.template.spec.volumes // []) == [{
        "name": "standalone-config",
        "configMap": {
          "name": "falcone-apisix-standalone",
          "defaultMode": 420
        }
      }];
    def exact_observability:
      one("falcone-observability") as $deployment
      | $deployment != null and identity($deployment; "observability")
      and $deployment.metadata.generation == 5
      and $deployment.status.observedGeneration == 5
      and $deployment.spec.replicas == 1
      and $deployment.status.replicas == 2
      and $deployment.status.updatedReplicas == 1
      and $deployment.status.readyReplicas == 1
      and $deployment.status.availableReplicas == 1
      and $deployment.status.unavailableReplicas == 1
      and ([ $deployment.spec.template.spec.containers[]
        | select(.name == "observability" and .image == $observability_image
          and .securityContext.runAsNonRoot == true
          and (.securityContext | has("runAsUser") | not)
          and (.securityContext | has("runAsGroup") | not)) ] | length) == 1;
    exact_apisix and exact_observability' >/dev/null; then
    revision23_state="partial-manual-recovery"
  else
    die "REVISION23_DEPLOYMENT_EVIDENCE_DRIFT"
  fi

  if [[ "$revision23_state" == "named-user-failure" ]]; then
    printf '%s' "$pods" | jq -e \
    --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg apisix_image "docker.io/apache/apisix:3.10.0-debian" \
    --arg observability_image "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62" '
    def owned_by_replicaset:
      ([.metadata.ownerReferences[]?
        | select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true
          and (.name | type == "string" and length > 0))] | length) == 1;
    def target($component; $image):
      select(.metadata.namespace == $namespace
        and .metadata.labels["app.kubernetes.io/name"] == $component
        and .metadata.labels["app.kubernetes.io/instance"] == $release
        and owned_by_replicaset
        and ([.spec.containers[] | select(.name == $component and .image == $image)] | length) == 1);
    def waiting_signature($component; $user):
      .status.phase == "Pending"
      and ([.status.containerStatuses[]?
        | select(.name == $component and .ready == false
          and .state.waiting.reason == "CreateContainerConfigError"
          and (.state.waiting.message
            | contains("container has runAsNonRoot and image has non-numeric user (" + $user + ")"))
          and (.state.waiting.message | contains("cannot verify user is non-root")))] | length) == 1;
    def ready_signature($component):
      .status.phase == "Running"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
      and any(.status.containerStatuses[]?; .name == $component and .ready == true);
    ([.items[] | target("apisix"; $apisix_image)] as $apisix
      | [.items[] | target("observability"; $observability_image)] as $observability
      | ($apisix | length) == 4
      and ([$apisix[] | select(waiting_signature("apisix"; "apisix"))] | length) == 1
      and ([$apisix[] | select(ready_signature("apisix"))] | length) == 3
      and ($observability | length) == 2
      and ([$observability[] | select(waiting_signature("observability"; "nobody"))] | length) == 1
      and ([$observability[] | select(ready_signature("observability"))] | length) == 1
      and ([.items[]
        | select(.status.phase == "Pending")
        | [.status.containerStatuses[]?
          | select(.state.waiting.reason == "CreateContainerConfigError"
            and (.state.waiting.message
              | contains("container has runAsNonRoot and image has non-numeric user ("))
            and (.state.waiting.message | contains("cannot verify user is non-root")))]
        | select(length > 0)] | length) == 2)' \
      >/dev/null || die "REVISION23_POD_EVIDENCE_DRIFT"
    printf 'revision23-failure=validated chart=in-falcone-0.4.9 cause=named-image-users deployments=2 pendingPods=2 readyPods=4\n'
    return 0
  fi

  configmap="$(kubectl -n "$EXPECTED_NAMESPACE" get configmap falcone-apisix-standalone -o json)" || \
    die "REVISION23_APISIX_CONFIGMAP_UNAVAILABLE"
  printf '%s' "$configmap" | jq -e --arg namespace "$EXPECTED_NAMESPACE" '
    .metadata.name == "falcone-apisix-standalone"
    and .metadata.namespace == $namespace
    and (.data | keys) == ["apisix.yaml"]
    and (((.binaryData // {}) | keys) | length) == 0
    and (.data["apisix.yaml"] | type == "string" and length > 0)' >/dev/null || \
    die "REVISION23_APISIX_CONFIGMAP_DRIFT"
  config_hash="$(printf '%s' "$configmap" | jq -j '.data["apisix.yaml"]' | sha256sum | awk '{print $1}')"
  [[ "$config_hash" == "28aa61f223b1306a9604817f44abf6c8c1c867e6ba9020bc9ff85235dd2c555b" ]] || \
    die "REVISION23_APISIX_CONFIGMAP_DRIFT"

  apisix_deployment_uid="$(printf '%s' "$deployments" | jq -er \
    '[.items[] | select(.metadata.name == "falcone-apisix")]
      | if length == 1 then .[0].metadata.uid else error("deployment cardinality") end')" || \
    die "REVISION23_REPLICASET_EVIDENCE_DRIFT"
  apisix_deployment_generation="$(printf '%s' "$deployments" | jq -er \
    '[.items[] | select(.metadata.name == "falcone-apisix")]
      | if length == 1 then (.[0].metadata.generation | tostring) else error("deployment cardinality") end')" || \
    die "REVISION23_REPLICASET_EVIDENCE_DRIFT"
  replicasets="$(kubectl -n "$EXPECTED_NAMESPACE" get replicasets.apps \
    -l app.kubernetes.io/instance="$EXPECTED_RELEASE",app.kubernetes.io/name=apisix -o json)" || \
    die "REVISION23_REPLICASETS_UNAVAILABLE"
  active_apisix_replicaset="$(printf '%s' "$replicasets" | jq -ce \
    --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg deployment_uid "$apisix_deployment_uid" --arg deployment_generation "$apisix_deployment_generation" '
    [.items[] | select(
      .apiVersion == "apps/v1" and .kind == "ReplicaSet"
      and .metadata.namespace == $namespace
      and (.metadata.uid | type == "string" and length > 0)
      and .metadata.labels["app.kubernetes.io/name"] == "apisix"
      and .metadata.labels["app.kubernetes.io/instance"] == $release
      and .metadata.annotations["deployment.kubernetes.io/revision"] == $deployment_generation
      and .spec.replicas == 3
      and .status.replicas == 3
      and .status.readyReplicas == 3
      and .status.availableReplicas == 3
      and ([.metadata.ownerReferences[]? | select(
        .apiVersion == "apps/v1" and .kind == "Deployment"
        and .name == "falcone-apisix" and .uid == $deployment_uid
        and .controller == true)] | length) == 1)]
    | if length == 1 then .[0] else error("active ReplicaSet cardinality") end')" || \
    die "REVISION23_REPLICASET_EVIDENCE_DRIFT"
  active_apisix_replicaset_name="$(printf '%s' "$active_apisix_replicaset" | jq -er '.metadata.name')" || \
    die "REVISION23_REPLICASET_EVIDENCE_DRIFT"
  active_apisix_replicaset_uid="$(printf '%s' "$active_apisix_replicaset" | jq -er '.metadata.uid')" || \
    die "REVISION23_REPLICASET_EVIDENCE_DRIFT"

  all_pods="$(kubectl get pods -A -o json)" || die "REVISION23_GLOBAL_PODS_UNAVAILABLE"
  printf '%s' "$pods" | jq -e \
    --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" \
    --arg active_apisix_replicaset_name "$active_apisix_replicaset_name" \
    --arg active_apisix_replicaset_uid "$active_apisix_replicaset_uid" \
    --arg apisix_image "docker.io/apache/apisix:3.10.0-debian" \
    --arg observability_image "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62" '
    def owned_by_replicaset:
      ([.metadata.ownerReferences[]?
        | select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true
          and (.name | type == "string" and length > 0))] | length) == 1;
    def owner_name:
      [.metadata.ownerReferences[]?
        | select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true)][0].name;
    def owned_by_active_apisix_replicaset:
      ([.metadata.ownerReferences[]?
        | select(.apiVersion == "apps/v1" and .kind == "ReplicaSet" and .controller == true
          and .name == $active_apisix_replicaset_name
          and .uid == $active_apisix_replicaset_uid)] | length) == 1;
    def target($component; $image):
      select(.metadata.namespace == $namespace
        and .metadata.labels["app.kubernetes.io/name"] == $component
        and .metadata.labels["app.kubernetes.io/instance"] == $release
        and owned_by_replicaset
        and ([.spec.containers[] | select(.name == $component and .image == $image)] | length) == 1);
    def exact_apisix_ready:
      .status.phase == "Running"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
      and (.spec.securityContext.fsGroup == 1001)
      and (.spec.securityContext.fsGroupChangePolicy == "OnRootMismatch")
      and (.spec.securityContext.runAsNonRoot == true)
      and (.spec.securityContext.runAsUser == 636)
      and (.spec.securityContext.seccompProfile.type == "RuntimeDefault")
      and (.spec.securityContext | has("runAsGroup") | not)
      and ([.spec.containers[] | select(.name == "apisix"
        and .image == $apisix_image
        and .securityContext.runAsNonRoot == true
        and (.securityContext | has("runAsUser") | not)
        and (.securityContext | has("runAsGroup") | not)
        and (.volumeMounts // []) == [{
          "name": "standalone-config",
          "mountPath": "/usr/local/apisix/conf/apisix.yaml",
          "subPath": "apisix.yaml"
        }])] | length) == 1
      and (.spec.volumes // []) == [{
        "name": "standalone-config",
        "configMap": {
          "name": "falcone-apisix-standalone",
          "defaultMode": 420
        }
      }]
      and ([.status.containerStatuses[]? | select(.name == "apisix"
        and .image == $apisix_image
        and .ready == true
        and .restartCount == 0
        and .state.running != null
        and (.state | has("waiting") | not)
        and .user.linux.uid == 636
        and .user.linux.gid == 636)] | length) == 1;
    def waiting_observability:
      .status.phase == "Pending"
      and ([.status.containerStatuses[]? | select(.name == "observability"
        and .ready == false
        and .state.waiting.reason == "CreateContainerConfigError"
        and (.state.waiting.message
          | contains("container has runAsNonRoot and image has non-numeric user (nobody)"))
        and (.state.waiting.message | contains("cannot verify user is non-root")))] | length) == 1;
    def ready_observability:
      .status.phase == "Running"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")
      and any(.status.containerStatuses[]?; .name == "observability" and .ready == true);
    ([.items[] | target("apisix"; $apisix_image)] as $apisix
      | [.items[] | target("observability"; $observability_image)] as $observability
      | ($apisix | length) == 3
      and ([$apisix[] | select(exact_apisix_ready)] | length) == 3
      and ([$apisix[] | owner_name] | unique | length) == 1
      and all($apisix[]; owned_by_active_apisix_replicaset)
      and ($observability | length) == 2
      and ([$observability[] | select(waiting_observability)] | length) == 1
      and ([$observability[] | select(ready_observability)] | length) == 1)' \
    >/dev/null || die "REVISION23_POD_EVIDENCE_DRIFT"
  printf '%s' "$all_pods" | jq -e '
    ([.items[]
      | select([.status.containerStatuses[]?
        | select(.state.waiting.reason == "CreateContainerConfigError"
          and (.state.waiting.message
            | contains("container has runAsNonRoot and image has non-numeric user ("))
          and (.state.waiting.message | contains("cannot verify user is non-root")))]
        | length > 0)] | length) == 1' >/dev/null || die "REVISION23_GLOBAL_POD_EVIDENCE_DRIFT"

  printf 'revision23-partial-manual-recovery=validated chart=in-falcone-0.4.9 apisixReady=3 observabilityPending=1 configHash=sha256:%s\n' "$config_hash"
}

validate_revision24_global_wait_recovery() {
  [[ "$actual_revision" == 24 ]] || return 0
  local apisix observability all_pods vector_pvc vector_statefulset vector_pod workload
  apisix="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-apisix -o json)" || \
    die "REVISION24_APISIX_EVIDENCE_UNAVAILABLE"
  observability="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-observability -o json)" || \
    die "REVISION24_OBSERVABILITY_EVIDENCE_UNAVAILABLE"
  printf '%s' "$apisix" | jq -e --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" '
    .apiVersion == "apps/v1" and .kind == "Deployment"
    and .metadata.name == "falcone-apisix" and .metadata.namespace == $namespace
    and .metadata.labels["app.kubernetes.io/name"] == "apisix"
    and .metadata.labels["app.kubernetes.io/instance"] == $release
    and .metadata.generation == 8 and .status.observedGeneration == 8
    and .spec.replicas == 3 and .status.replicas == 3
    and .status.updatedReplicas == 3 and .status.readyReplicas == 3
    and .status.availableReplicas == 3 and ((.status.unavailableReplicas // 0) == 0)
    and .spec.template.spec.securityContext == {
      fsGroup: 1001, fsGroupChangePolicy: "OnRootMismatch", runAsGroup: 636,
      runAsNonRoot: true, runAsUser: 636, seccompProfile: {type: "RuntimeDefault"}}
    and ([.spec.template.spec.containers[] | select(
      .name == "apisix" and .image == "docker.io/apache/apisix:3.10.0-debian"
      and .securityContext == {
        allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]},
        readOnlyRootFilesystem: false, runAsGroup: 636, runAsNonRoot: true, runAsUser: 636})]
      | length) == 1' >/dev/null || die "REVISION24_APISIX_EVIDENCE_DRIFT"
  printf '%s' "$observability" | jq -e --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" '
    .apiVersion == "apps/v1" and .kind == "Deployment"
    and .metadata.name == "falcone-observability" and .metadata.namespace == $namespace
    and .metadata.labels["app.kubernetes.io/name"] == "observability"
    and .metadata.labels["app.kubernetes.io/instance"] == $release
    and .metadata.generation == 6 and .status.observedGeneration == 6
    and .spec.replicas == 1 and .status.replicas == 1
    and .status.updatedReplicas == 1 and .status.readyReplicas == 1
    and .status.availableReplicas == 1 and ((.status.unavailableReplicas // 0) == 0)
    and .spec.template.spec.securityContext == {
      fsGroup: 1001, fsGroupChangePolicy: "OnRootMismatch", runAsNonRoot: true,
      seccompProfile: {type: "RuntimeDefault"}}
    and ([.spec.template.spec.containers[] | select(
      .name == "observability"
      and .image == "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62"
      and .securityContext.runAsNonRoot == true
      and .securityContext.runAsUser == 65534
      and .securityContext.runAsGroup == 65534)] | length) == 1' >/dev/null || \
    die "REVISION24_OBSERVABILITY_EVIDENCE_DRIFT"

  all_pods="$(kubectl get pods -A -o json)" || die "REVISION24_GLOBAL_POD_EVIDENCE_UNAVAILABLE"
  printf '%s' "$all_pods" | jq -e '
    [.items[] | .status.containerStatuses[]?
      | select(.state.waiting.reason == "CreateContainerConfigError"
        and (.state.waiting.message // "" | contains("container has runAsNonRoot and image has non-numeric user ("))
        and (.state.waiting.message // "" | contains("cannot verify user is non-root")))]
    | length == 0' >/dev/null || die "REVISION24_NAMED_USER_EVIDENCE_DRIFT"

  vector_pvc="$(kubectl -n "$EXPECTED_NAMESPACE" get pvc "$EXPECTED_PVC" -o json)" || \
    die "REVISION24_VECTOR_PVC_UNAVAILABLE"
  printf '%s' "$vector_pvc" | jq -e --arg namespace "$EXPECTED_NAMESPACE" '
    .apiVersion == "v1" and .kind == "PersistentVolumeClaim"
    and .metadata.name == "falcone-postgresql-vector-data" and .metadata.namespace == $namespace
    and .metadata.uid == "6c2f26b3-f1c3-47f6-805f-cd9fb709107b"
    and .spec.storageClassName == "hcloud-volumes"
    and .spec.resources.requests.storage == "10Gi"
    and ((.spec.volumeName // "") == "") and .status.phase == "Pending"' >/dev/null || \
    die "REVISION24_VECTOR_PVC_DRIFT"
  vector_statefulset="$(kubectl -n "$EXPECTED_NAMESPACE" get statefulset "$EXPECTED_VECTOR_STATEFULSET" -o json)" || \
    die "REVISION24_VECTOR_STATEFULSET_UNAVAILABLE"
  printf '%s' "$vector_statefulset" | jq -e --arg namespace "$EXPECTED_NAMESPACE" '
    .apiVersion == "apps/v1" and .kind == "StatefulSet"
    and .metadata.name == "falcone-postgresql-vector" and .metadata.namespace == $namespace
    and .metadata.uid == "3b44816b-1dfe-4c84-b9df-320695224149"
    and .metadata.generation == 2 and .status.observedGeneration == 2
    and .spec.replicas == 1 and .status.replicas == 1
    and ((.status.readyReplicas // 0) == 0)' >/dev/null || die "REVISION24_VECTOR_STATEFULSET_DRIFT"
  vector_pod="$(kubectl -n "$EXPECTED_NAMESPACE" get pod falcone-postgresql-vector-0 -o json)" || \
    die "REVISION24_VECTOR_POD_UNAVAILABLE"
  printf '%s' "$vector_pod" | jq -e --arg namespace "$EXPECTED_NAMESPACE" '
    .apiVersion == "v1" and .kind == "Pod"
    and .metadata.name == "falcone-postgresql-vector-0" and .metadata.namespace == $namespace
    and .metadata.uid == "494d9397-fbc4-49a5-ae3a-e0983fbca84f"
    and .status.phase == "Pending"
    and ([.metadata.ownerReferences[]? | select(
      .apiVersion == "apps/v1" and .kind == "StatefulSet"
      and .name == "falcone-postgresql-vector"
      and .uid == "3b44816b-1dfe-4c84-b9df-320695224149" and .controller == true)] | length) == 1
    and ([.spec.volumes[]? | select(.name == "data"
      and .persistentVolumeClaim.claimName == "falcone-postgresql-vector-data")] | length) == 1
    and any(.status.conditions[]?; .type == "PodScheduled" and .status == "False"
      and .reason == "Unschedulable")' >/dev/null || \
    die "REVISION24_VECTOR_POD_DRIFT"
  for workload in \
    deployment/falcone-apisix \
    deployment/falcone-control-plane \
    deployment/falcone-control-plane-executor \
    deployment/falcone-ferretdb \
    deployment/falcone-grafana \
    deployment/falcone-keycloak \
    deployment/falcone-observability \
    deployment/falcone-seaweedfs-s3 \
    deployment/falcone-temporal-frontend \
    deployment/falcone-temporal-history \
    deployment/falcone-temporal-matching \
    deployment/falcone-temporal-web \
    deployment/falcone-temporal-worker \
    deployment/falcone-web-console \
    deployment/falcone-workflow-worker \
    statefulset/falcone-documentdb \
    statefulset/falcone-kafka \
    statefulset/falcone-postgresql \
    statefulset/falcone-seaweedfs-filer \
    statefulset/falcone-seaweedfs-master \
    statefulset/falcone-seaweedfs-volume; do
    kubectl -n "$EXPECTED_NAMESPACE" rollout status "$workload" --timeout=10m >/dev/null || \
      die "REVISION24_NON_VECTOR_ROLLOUT_DRIFT workload=${workload}"
  done
  kubectl -n secret-store rollout status statefulset/openbao --timeout=10m >/dev/null || \
    die "REVISION24_NON_VECTOR_ROLLOUT_DRIFT workload=statefulset/openbao"
  revision24_state="global-wait-timeout"
  printf 'revision24-global-wait-recovery=validated chart=in-falcone-0.4.11 vectorPvcUid=%s store=openbao-backend externalSecrets=14\n' \
    "$(printf '%s' "$vector_pvc" | jq -r .metadata.uid)"
}

if [[ "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 ]]; then
  [[ "$actual_status" == "failed" ]] || die "FAILED_RESUME_LIST_STATUS_UNSAFE"
  validate_failed_resume_state
fi
validate_legacy_webhook_contract
validate_failed_storage_contract
validate_revision23_named_user_failure
validate_revision24_global_wait_recovery

if [[ "$mode" == phase-a || "$mode" == preflight ]]; then
  [[ "$actual_revision" == "$EXPECTED_SOURCE_REVISION" || "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 ]] || \
    die "REVISION_GATE_FAILED expected=${EXPECTED_SOURCE_REVISION} actual=${actual_revision}; use forward recovery after Phase A"
  [[ "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 || "$actual_status" == "deployed" ]] || die "SOURCE_RELEASE_STATUS_UNSAFE actual=${actual_status}"
  [[ "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 || "$actual_chart" == "$EXPECTED_SOURCE_CHART" ]] || \
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

# Give an inexact Phase-A target a useful JIT error before loading evidence. The
# immutable target chart is part of this early boundary; a confirmation for a
# published predecessor must not be misreported as stale evidence.
confirmation_prefix="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${actual_revision}/${actual_chart}->${EXPECTED_REPAIR_CHART}/"
confirmation_digest="${confirm_target#"$confirmation_prefix"}"
if [[ "$apply" == true && "$mode" == phase-a \
   && ( "$confirm_target" != "${confirmation_prefix}"* \
     || ! "$confirmation_digest" =~ ^sha256:[0-9a-f]{64}$ ) ]]; then
  if [[ ( "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 ) && "$actual_status" == failed ]]; then
    die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${actual_revision}/${actual_chart}->${EXPECTED_REPAIR_CHART}/PACKAGE_DIGEST"
  fi
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
  --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
  --set openbao.openbao.authReconcile.allowRecoveryRoot=false
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
phase_a_no_root_args=(
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
  --set-string postgresqlVector.persistence.storageClass=hcloud-volumes
  --set openbao.openbao.authReconcile.allowRecoveryRoot=false
  --set global.webhookDatabase.migration.backupVerified=true
  --set global.webhookDatabase.migration.parityVerified=true
  --set-string "global.webhookDatabase.migration.backupReference=${backup_reference:-READ-ONLY-PREFLIGHT}"
)
phase_b_args=(
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
if [[ "$mode" == phase-b ]]; then selected_args=("${phase_b_args[@]}"); else selected_args=("${phase_a_args[@]}"); fi

render_and_validate_images() {
  local output="$1"
  helm template "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --is-upgrade \
    "${selected_args[@]}" >"$output"
  local contract expected
  while IFS='|' read -r contract expected; do
    grep -qF "$expected" "$output" || { printf 'STAGING_IMAGE_DIGEST_DRIFT contract=%s\n' "$contract" >&2; return 1; }
  done <<'DIGESTS'
control-plane|image: "ghcr.io/gntik-ai/in-falcone-control-plane@sha256:26bb5ff1caa0ffbd9f902b5da645fa69caa9153ff6d19b28eda640f35f9c4254"
control-plane-executor|image: "ghcr.io/gntik-ai/in-falcone-control-plane-executor@sha256:94809c39149cb6d2aa12a606f5b7db19d8365e1a857b83bcd45405554116feae"
web-console|image: "ghcr.io/gntik-ai/in-falcone-web-console@sha256:4ccb885b4e15637e68f409fcedf93f180397fad3d6ccf331961d41e43af8c868"
workflow-worker|image: "ghcr.io/gntik-ai/in-falcone-workflow-worker@sha256:0520d57d36ee1383c2077388eb4880023f3b5c11536107151a1e01657001e8aa"
function-executor-runtime|value: 'ghcr.io/gntik-ai/in-falcone-fn-runtime@sha256:b50e93fb529a2129daa4e682ea4ae3741967a649c5fc1cc5f2f2b6588eb1a0fd'
mcp-runtime-image|MCP_RUNTIME_IMAGE: "ghcr.io/gntik-ai/in-falcone-mcp-runtime:0.3.0"
mcp-runtime-image-digest|MCP_RUNTIME_IMAGE_DIGEST: "sha256:f0bb4c639f08c40c650e3f2b45a0d3c546fa84b0ae5d2eb9a4153860ec06a162"
DIGESTS
  python3 - "$output" <<'PY' || {
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as stream:
    documents = [document for document in yaml.safe_load_all(stream) if isinstance(document, dict)]

matches = [
    document
    for document in documents
    if document.get("apiVersion") == "apps/v1"
    and document.get("kind") == "Deployment"
    and document.get("metadata", {}).get("name") == "falcone-apisix"
]
if len(matches) != 1:
    raise SystemExit(1)

deployment = matches[0]
metadata = deployment.get("metadata", {})
spec = deployment.get("spec", {})
template = spec.get("template", {})
pod_spec = template.get("spec", {})
expected_labels = {
    "app.kubernetes.io/name": "apisix",
    "app.kubernetes.io/instance": "falcone",
}
if any(metadata.get("labels", {}).get(key) != value for key, value in expected_labels.items()):
    raise SystemExit(1)
if spec.get("replicas") != 3 or spec.get("selector", {}).get("matchLabels") != expected_labels:
    raise SystemExit(1)
if template.get("metadata", {}).get("labels") != expected_labels:
    raise SystemExit(1)
if pod_spec.get("securityContext") != {
    "fsGroup": 1001,
    "fsGroupChangePolicy": "OnRootMismatch",
    "runAsGroup": 636,
    "runAsNonRoot": True,
    "runAsUser": 636,
    "seccompProfile": {"type": "RuntimeDefault"},
}:
    raise SystemExit(1)

containers = pod_spec.get("containers", [])
if len(containers) != 1:
    raise SystemExit(1)
container = containers[0]
if container.get("name") != "apisix" or container.get("image") != "docker.io/apache/apisix:3.10.0-debian":
    raise SystemExit(1)
if container.get("securityContext") != {
    "allowPrivilegeEscalation": False,
    "capabilities": {"drop": ["ALL"]},
    "readOnlyRootFilesystem": False,
    "runAsGroup": 636,
    "runAsNonRoot": True,
    "runAsUser": 636,
}:
    raise SystemExit(1)
if container.get("volumeMounts") != [{
    "mountPath": "/usr/local/apisix/conf/apisix.yaml",
    "name": "standalone-config",
    "subPath": "apisix.yaml",
}]:
    raise SystemExit(1)
if pod_spec.get("volumes") != [{
    "configMap": {"defaultMode": 420, "name": "falcone-apisix-standalone"},
    "name": "standalone-config",
}]:
    raise SystemExit(1)
PY
      printf 'APISIX_RENDER_CONVERGENCE_DRIFT reason=contract\n' >&2
      return 1
    }
  if grep -Eq '^  namespace: external-secrets[[:space:]]*$' "$output"; then
    printf 'EXTERNAL_ESO_OWNER_RENDERED\n' >&2
    return 1
  fi
}
render_and_validate_images "$render_file"

expected_external_secret_names='["gateway-apisix-credentials","gateway-shared-secret","iam-identity-client","iam-keycloak-credentials","iam-superadmin","platform-documentdb-credentials","platform-documentdb-replication","platform-encryption-key","platform-ferretdb-credentials","platform-kafka-credentials","platform-postgresql-credentials","platform-postgresql-vector-credentials","platform-s3-credentials","platform-temporal-credentials"]'
legacy_store_state=""
legacy_store_uid=""
legacy_store_resource_version=""
legacy_store_desired_spec=""
legacy_store_patch=""

validate_legacy_clustersecretstore_handoff() {
  [[ "$actual_revision" == 24 ]] || return 0
  local desired_metadata desired_spec legacy_spec store_list store service_account external_secrets
  desired_metadata="$(python3 - "$render_file" <<'PY'
import json
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as stream:
    documents = [document for document in yaml.safe_load_all(stream) if isinstance(document, dict)]
matches = [
    document for document in documents
    if document.get("apiVersion") == "external-secrets.io/v1beta1"
    and document.get("kind") == "ClusterSecretStore"
    and document.get("metadata", {}).get("name") == "openbao-backend"
]
if len(matches) != 1:
    raise SystemExit(1)
print(json.dumps({
    "labels": matches[0].get("metadata", {}).get("labels", {}),
    "annotations": matches[0].get("metadata", {}).get("annotations", {}),
    "spec": matches[0].get("spec", {}),
}, separators=(",", ":"), sort_keys=True))
PY
  )" || die "LEGACY_CLUSTERSECRETSTORE_RENDER_DRIFT"
  printf '%s' "$desired_metadata" | jq -e --arg release "$EXPECTED_RELEASE" --arg namespace "$EXPECTED_NAMESPACE" '
    .labels == {
      "app.kubernetes.io/name": "external-secrets",
      "app.kubernetes.io/instance": $release,
      "app.kubernetes.io/managed-by": "Helm",
      "app.kubernetes.io/part-of": "in-falcone",
      "in-falcone.io/component": "eso"
    }
    and .spec == {
      provider: {vault: {
        server: "https://openbao.secret-store.svc.cluster.local:8200",
        path: "secret", version: "v2",
        caProvider: {type: "Secret", name: "openbao-server-tls", key: "ca.crt", namespace: "secret-store"},
        auth: {kubernetes: {mountPath: "kubernetes", role: "eso-role",
          serviceAccountRef: {name: "eso-openbao-auth", namespace: "eso-system"}}}
      }}
    }' >/dev/null || die "LEGACY_CLUSTERSECRETSTORE_RENDER_DRIFT"
  desired_spec="$(printf '%s' "$desired_metadata" | jq -cS .spec)"
  legacy_spec="$(printf '%s' "$desired_spec" | jq -cS '.provider.vault.auth.kubernetes.serviceAccountRef.namespace = "external-secrets"')"

  store_list="$(kubectl get clustersecretstores.external-secrets.io -o json)" || \
    die "LEGACY_CLUSTERSECRETSTORE_EVIDENCE_UNAVAILABLE"
  printf '%s' "$store_list" | jq -e '
    ([.items[] | select(.metadata.name == "openbao-backend")] | length) == 1' >/dev/null || \
    die "LEGACY_CLUSTERSECRETSTORE_CARDINALITY_DRIFT"
  store="$(kubectl get clustersecretstore.external-secrets.io openbao-backend -o json)" || \
    die "LEGACY_CLUSTERSECRETSTORE_EVIDENCE_UNAVAILABLE"
  service_account="$(kubectl -n eso-system get serviceaccount eso-openbao-auth -o json)" || \
    die "LEGACY_CLUSTERSECRETSTORE_SERVICEACCOUNT_UNAVAILABLE"
  printf '%s' "$service_account" | jq -e '
    .apiVersion == "v1" and .kind == "ServiceAccount"
    and .metadata.name == "eso-openbao-auth" and .metadata.namespace == "eso-system"
    and .metadata.uid == "5454b1cc-c2b4-4125-b2a8-a4762d3180c9"' >/dev/null || \
    die "LEGACY_CLUSTERSECRETSTORE_SERVICEACCOUNT_DRIFT"
  printf '%s' "$store" | jq -e --arg release "$EXPECTED_RELEASE" --arg namespace "$EXPECTED_NAMESPACE" '
    .apiVersion == "external-secrets.io/v1beta1" and .kind == "ClusterSecretStore"
    and .metadata.name == "openbao-backend"
    and .metadata.uid == "f70a5ffd-56f3-4b37-8119-d54ba1108b69"
    and (.metadata.resourceVersion | type == "string" and length > 0)
    and .metadata.labels == {
      "app.kubernetes.io/name": "external-secrets",
      "app.kubernetes.io/instance": $release,
      "app.kubernetes.io/managed-by": "Helm",
      "app.kubernetes.io/part-of": "in-falcone",
      "in-falcone.io/component": "eso"
    }
    and .metadata.annotations["meta.helm.sh/release-name"] == $release
    and .metadata.annotations["meta.helm.sh/release-namespace"] == $namespace' >/dev/null || \
    die "LEGACY_CLUSTERSECRETSTORE_IDENTITY_DRIFT"

  if [[ "$(printf '%s' "$store" | jq -cS .spec)" == "$legacy_spec" ]]; then
    printf '%s' "$store" | jq -e '
      .metadata.annotations == {
        "helm.sh/hook": "post-install,post-upgrade",
        "helm.sh/hook-weight": "0",
        "meta.helm.sh/release-name": "falcone",
        "meta.helm.sh/release-namespace": "in-falcone-staging"
      }
      and any(.status.conditions[]?; .type == "Ready" and .status == "False"
        and .reason == "InvalidProviderConfig"
        and (.message // "" | contains("unable to create client")))' >/dev/null || \
      die "LEGACY_CLUSTERSECRETSTORE_HOOK_DRIFT"
    legacy_store_state="required"
  elif [[ "$(printf '%s' "$store" | jq -cS .spec)" == "$desired_spec" ]]; then
    if printf '%s' "$store" | jq -e '
      ((.metadata.annotations | has("helm.sh/hook")) | not)
      and ((.metadata.annotations | has("helm.sh/hook-weight")) | not)
      and any(.status.conditions[]?; .type == "Ready" and .status == "True")' >/dev/null; then
      legacy_store_state="complete"
    elif printf '%s' "$store" | jq -e '
      .metadata.annotations == {
        "in-falcone.io/reconcile-request": "phase-a-0.4.12-auth-updated",
        "meta.helm.sh/release-name": "falcone",
        "meta.helm.sh/release-namespace": "in-falcone-staging"
      }
      and (.status.conditions | length) == 1
      and any(.status.conditions[]?;
        .type == "Ready"
        and .status == "False"
        and .reason == "ValidationFailed"
        and .message == "unable to validate store: invalid vault credentials: Error making API request.\n\nURL: GET https://openbao.secret-store.svc.cluster.local:8200/v1/auth/token/lookup-self\nCode: 403. Errors:\n\n* 1 error occurred:\n\t* permission denied\n\n")' >/dev/null; then
      legacy_store_state="auth-policy-required"
    else
      die "LEGACY_CLUSTERSECRETSTORE_HANDOFF_DRIFT"
    fi
  else
    die "LEGACY_CLUSTERSECRETSTORE_SPEC_DRIFT"
  fi

  external_secrets="$(kubectl -n "$EXPECTED_NAMESPACE" get externalsecrets.external-secrets.io -o json)" || \
    die "LEGACY_CLUSTERSECRETSTORE_EXTERNALSECRET_EVIDENCE_UNAVAILABLE"
  printf '%s' "$external_secrets" | jq -e --argjson expected "$expected_external_secret_names" \
    --arg state "$legacy_store_state" '
    ([.items[].metadata.name] | sort) == $expected
    and (.items | length) == 14
    and ([.items[].metadata.name] | unique | length) == 14
    and all(.items[]; .metadata.namespace == "in-falcone-staging")
    and (if $state == "required" then
      all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "False"
        and (.message // "" | contains("could not get secret data from provider"))))
    elif $state == "auth-policy-required" then
      (
        all(.items[];
          (.status.conditions | length) == 1
          and .status.conditions[0].type == "Ready"
          and .status.conditions[0].status == "True")
        or
        all(.items[];
          (.status.conditions | length) == 1
          and .status.conditions[0].type == "Ready"
          and .status.conditions[0].status == "False"
          and .status.conditions[0].reason == "SecretSyncedError"
          and .status.conditions[0].message == "could not get secret data from provider")
      )
    else
      all(.items[]; any(.status.conditions[]?; .type == "Ready" and .status == "True"))
    end)' >/dev/null || die "LEGACY_CLUSTERSECRETSTORE_EXTERNALSECRET_DRIFT"

  legacy_store_uid="$(printf '%s' "$store" | jq -r .metadata.uid)"
  legacy_store_resource_version="$(printf '%s' "$store" | jq -r .metadata.resourceVersion)"
  legacy_store_desired_spec="$desired_spec"
  legacy_store_patch="$(jq -cn \
    --arg uid "$legacy_store_uid" --arg resource_version "$legacy_store_resource_version" \
    --argjson spec "$legacy_store_desired_spec" \
    '[
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$resource_version},
      {op:"remove",path:"/metadata/annotations/helm.sh~1hook"},
      {op:"remove",path:"/metadata/annotations/helm.sh~1hook-weight"},
      {op:"replace",path:"/spec",value:$spec}
    ]')"
  printf 'legacy-clustersecretstore-handoff=%s name=openbao-backend uid=%s resourceVersion=%s\n' \
    "$legacy_store_state" "$legacy_store_uid" "$legacy_store_resource_version"
}

run_revision24_pre_handoff_auth_reconcile() {
  [[ "$actual_revision" == 24 ]] || return 0
  # The auth-first pre-handoff Job is enabled by the corrected 0.4.16 recovery
  # package. Immutable 0.4.12 through 0.4.15 never completed live recovery.
  [[ "$EXPECTED_REPAIR_VERSION" == "0.4.16" ]] || return 0

  auth_job_file="$(mktemp "${TMPDIR:-/tmp}/falcone-revision24-auth-reconcile.XXXXXX")"
  helm template "$EXPECTED_RELEASE" "$chart_source" \
    --version "$EXPECTED_REPAIR_VERSION" \
    --namespace "$EXPECTED_NAMESPACE" \
    --is-upgrade \
    "${phase_a_no_root_args[@]}" \
    --set openbao.openbao.authReconcile.allowRecoveryRoot=true \
    --show-only charts/openbao/templates/openbao-auth-reconcile-job.yaml \
    >"$auth_job_file" || die "REVISION24_AUTH_RECONCILE_RENDER_FAILED"

  python3 - "$auth_job_file" "$package_digest" "$EXPECTED_REPAIR_CHART" "$actual_revision" <<'PY' || \
    die "REVISION24_AUTH_RECONCILE_RENDER_DRIFT"
import re
import sys

import yaml


class DoubleQuoted(str):
    pass


yaml.SafeDumper.add_representer(
    DoubleQuoted,
    lambda dumper, value: dumper.represent_scalar("tag:yaml.org,2002:str", value, style='"'),
)

path, package_digest, target_chart, source_revision = sys.argv[1:]
with open(path, encoding="utf-8") as stream:
    documents = [document for document in yaml.safe_load_all(stream) if isinstance(document, dict)]

if len(documents) != 1:
    raise SystemExit(1)
job = documents[0]
metadata = job.get("metadata", {})
if (
    job.get("apiVersion") != "batch/v1"
    or job.get("kind") != "Job"
    or metadata.get("name") != "openbao-auth-reconcile"
    or metadata.get("namespace") != "secret-store"
    or not re.fullmatch(r"sha256:[0-9a-f]{64}", package_digest)
    or target_chart != "in-falcone-0.4.16"
    or source_revision != "24"
):
    raise SystemExit(1)

digest12 = package_digest.removeprefix("sha256:")[:12]
metadata.pop("name")
metadata["generateName"] = f"openbao-auth-reconcile-r24-{digest12}-"
annotations = metadata.setdefault("annotations", {})
annotations["in-falcone.io/recovery-package-digest"] = package_digest
annotations["in-falcone.io/recovery-target-chart"] = target_chart
annotations["in-falcone.io/recovery-source-revision"] = source_revision
if "falcone.gntik.ai/attested-chart-version" in annotations:
    annotations["falcone.gntik.ai/attested-chart-version"] = DoubleQuoted(
        str(annotations["falcone.gntik.ai/attested-chart-version"])
    )

with open(path, "w", encoding="utf-8") as stream:
    yaml.safe_dump_all([job], stream, explicit_start=True, sort_keys=False)
PY

  local auth_job_ref auth_job_suffix auth_log digest12 expected_job_prefix terminal_lines
  digest12="${package_digest#sha256:}"
  digest12="${digest12:0:12}"
  expected_job_prefix="job.batch/openbao-auth-reconcile-r24-${digest12}-"
  auth_job_ref="$(kubectl -n secret-store create -f "$auth_job_file" -o name)" || \
    die "REVISION24_AUTH_RECONCILE_CREATE_FAILED"
  auth_job_suffix="${auth_job_ref#"$expected_job_prefix"}"
  if [[ "$auth_job_ref" == *$'\n'* \
    || "$auth_job_ref" != "${expected_job_prefix}${auth_job_suffix}" \
    || -z "$auth_job_suffix" \
    || ! "$auth_job_suffix" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    die "REVISION24_AUTH_RECONCILE_CREATE_REF_DRIFT"
  fi
  kubectl -n secret-store wait --for=condition=Complete \
    "$auth_job_ref" --timeout=5m >/dev/null || \
    die "REVISION24_AUTH_RECONCILE_INCOMPLETE"

  auth_log="$(kubectl -n secret-store logs "$auth_job_ref")" || \
    die "REVISION24_AUTH_RECONCILE_LOG_UNAVAILABLE"
  terminal_lines="$(printf '%s\n' "$auth_log" | grep '^result=' || true)"
  case "$terminal_lines" in
    "result=changed code=AUTH_METADATA_CONVERGED canary=passed"|\
    "result=unchanged code=AUTH_METADATA_MATCHED canary=passed") ;;
    *) die "REVISION24_AUTH_RECONCILE_EVIDENCE_DRIFT" ;;
  esac
  printf 'revision24-auth-reconcile=validated chart=%s job=%s recovery-root=pre-handoff-only canary=passed\n' \
    "$EXPECTED_REPAIR_CHART" "$auth_job_ref"
}

apply_legacy_clustersecretstore_handoff() {
  [[ "$actual_revision" == 24 ]] || return 0
  if [[ "$legacy_store_state" == required ]]; then
    kubectl patch clustersecretstore.external-secrets.io openbao-backend \
      --type=json -p "$legacy_store_patch" >/dev/null
  fi
  kubectl wait --for=condition=Ready clustersecretstore.external-secrets.io/openbao-backend --timeout=10m >/dev/null
  local external_secret_name external_secrets
  while IFS= read -r external_secret_name; do
    kubectl -n "$EXPECTED_NAMESPACE" wait --for=condition=Ready \
      "externalsecret.external-secrets.io/${external_secret_name}" --timeout=10m >/dev/null
  done < <(printf '%s' "$expected_external_secret_names" | jq -r '.[]')
  external_secrets="$(kubectl -n "$EXPECTED_NAMESPACE" get externalsecrets.external-secrets.io -o json)" || \
    die "LEGACY_CLUSTERSECRETSTORE_EXTERNALSECRET_EVIDENCE_UNAVAILABLE"
  printf '%s' "$external_secrets" | jq -e --argjson expected "$expected_external_secret_names" '
    ([.items[].metadata.name] | sort) == $expected
    and (.items | length) == 14
    and ([.items[].metadata.name] | unique | length) == 14
    and all(.items[]; .metadata.namespace == "in-falcone-staging"
      and any(.status.conditions[]?; .type == "Ready" and .status == "True"))' >/dev/null || \
    die "LEGACY_CLUSTERSECRETSTORE_READINESS_DRIFT"
}

validate_legacy_clustersecretstore_handoff

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
  if printf '%s\n' "$diff_headers" | grep -Eiq ",[[:space:]]*(${protected_owner_names})([[:space:],/]|$)"; then
    printf 'EXTERNAL_ESO_SEMANTIC_DIFF\n' >&2
    return 1
  fi
}
semantic_diff

# Adopt only the exact Falcone ExternalSecrets already present in the target.
# Compare specs and reject Helm ownership conflicts/extras before patching labels.
adopt_falcone_external_secrets() {
  local perform_patch="${1:-false}"
  local names name live_list live rendered spec_live spec_rendered markers uid rv labels annotations
  local adoptable=0 already_owned=0
  local -a live_names expected_names
  local -A live_json patch_json
  names='gateway-apisix-credentials gateway-shared-secret iam-identity-client iam-keycloak-credentials iam-superadmin platform-documentdb-credentials platform-documentdb-replication platform-encryption-key platform-ferretdb-credentials platform-kafka-credentials platform-postgresql-credentials platform-postgresql-vector-credentials platform-s3-credentials platform-temporal-credentials'
  live_list="$(kubectl -n "$EXPECTED_NAMESPACE" get externalsecrets.external-secrets.io -o json)" || \
    die "EXTERNAL_SECRET_IDENTITY_SET_MISMATCH"
  mapfile -t live_names < <(printf '%s' "$live_list" | jq -r '.items[].metadata.name' | sort)
  mapfile -t expected_names < <(printf '%s\n' $names | sort)
  [[ "${live_names[*]}" == "${expected_names[*]}" ]] || die "EXTERNAL_SECRET_IDENTITY_SET_MISMATCH"
  for name in $names; do
    live="$(printf '%s' "$live_list" | jq -ce --arg name "$name" '.items[] | select(.metadata.name == $name)')" || \
      die "EXTERNAL_SECRET_MISSING_$name"
    live_json[$name]="$live"
    markers="$(printf '%s' "$live" | jq -c '[.metadata.labels["app.kubernetes.io/managed-by"] // null,.metadata.annotations["meta.helm.sh/release-name"] // null,.metadata.annotations["meta.helm.sh/release-namespace"] // null]')"
    case "$markers" in
      '[null,null,null]') adoptable=$((adoptable + 1)) ;;
      '["Helm","falcone","in-falcone-staging"]') already_owned=$((already_owned + 1)) ;;
      *) die "EXTERNAL_SECRET_FOREIGN_HELM_OWNER_$name" ;;
    esac
    rendered="$(awk -v n="$name" 'BEGIN{RS="---"} $0 ~ "kind:[[:space:]]*ExternalSecret" && $0 ~ "name:[[:space:]]*" n "([[:space:]]|$)" {print; exit}' "$render_file")"
    [[ -n "$rendered" ]] || die "EXTERNAL_SECRET_NOT_RENDERED_$name"
    spec_live="$(printf '%s' "$live" | jq -cS '.spec | .target.deletionPolicy=(.target.deletionPolicy // "Retain") | .data=(.data // [] | map(.remoteRef=(.remoteRef // {}) | .remoteRef.conversionStrategy=(.remoteRef.conversionStrategy // "Default") | .remoteRef.decodingStrategy=(.remoteRef.decodingStrategy // "None") | .remoteRef.metadataPolicy=(.remoteRef.metadataPolicy // "None"))) | .dataFrom = (.dataFrom // [])')"
    spec_rendered="$(printf '%s' "$rendered" | kubectl create --dry-run=client -f - -o json | jq -cS '.spec | .target.deletionPolicy=(.target.deletionPolicy // "Retain") | .data=(.data // [] | map(.remoteRef=(.remoteRef // {}) | .remoteRef.conversionStrategy=(.remoteRef.conversionStrategy // "Default") | .remoteRef.decodingStrategy=(.remoteRef.decodingStrategy // "None") | .remoteRef.metadataPolicy=(.remoteRef.metadataPolicy // "None"))) | .dataFrom = (.dataFrom // [])')"
    [[ "$spec_live" == "$spec_rendered" ]] || die "EXTERNAL_SECRET_SPEC_DRIFT_$name"
    uid="$(printf '%s' "$live" | jq -r '.metadata.uid')"; rv="$(printf '%s' "$live" | jq -r '.metadata.resourceVersion')"
    labels="$(printf '%s' "$live" | jq -c '.metadata.labels // {} | .["app.kubernetes.io/managed-by"]="Helm"')"
    annotations="$(printf '%s' "$live" | jq -c --arg r "$EXPECTED_RELEASE" --arg n "$EXPECTED_NAMESPACE" '.metadata.annotations // {} | .["meta.helm.sh/release-name"]=$r | .["meta.helm.sh/release-namespace"]=$n')"
    patch_json[$name]="$(jq -n --arg u "$uid" --arg rv "$rv" --argjson l "$labels" --argjson a "$annotations" '[{op:"test",path:"/metadata/uid",value:$u},{op:"test",path:"/metadata/resourceVersion",value:$rv},{op:"add",path:"/metadata/labels",value:$l},{op:"add",path:"/metadata/annotations",value:$a}]')"
  done
  if [[ "$perform_patch" != true ]]; then
    printf 'external-secret-adoption=preflight exact=14 adoptable=%s already-owned=%s mutation=false\n' "$adoptable" "$already_owned"
    return 0
  fi
  for name in $names; do
    [[ "$(printf '%s' "${live_json[$name]:-}" | jq -r '[.metadata.labels["app.kubernetes.io/managed-by"] // null,.metadata.annotations["meta.helm.sh/release-name"] // null,.metadata.annotations["meta.helm.sh/release-namespace"] // null] | @tsv')" == $'Helm\tfalcone\tin-falcone-staging' ]] && continue
    kubectl -n "$EXPECTED_NAMESPACE" patch externalsecret.external-secrets.io "$name" --type=json -p "${patch_json[$name]}" >/dev/null
  done
}

validate_external_eso_release_owner() {
  local owner
  owner="$(kubectl -n external-secrets get deployment external-secrets -o json)" || \
    die "EXTERNAL_ESO_OWNER_METADATA_INVALID"
  printf '%s' "$owner" | jq -e '
    .metadata.namespace == "external-secrets"
    and .metadata.name == "external-secrets"
    and .metadata.labels["app.kubernetes.io/managed-by"] == "Helm"
    and .metadata.annotations["meta.helm.sh/release-name"] == "external-secrets"
    and .metadata.annotations["meta.helm.sh/release-namespace"] == "external-secrets"
    and (.status.availableReplicas // 0) >= 1' >/dev/null || \
    die "EXTERNAL_ESO_OWNER_METADATA_INVALID"
}

validate_external_eso_release_owner

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

validate_revision23_numeric_user_convergence() {
  local apisix_json observability_json
  apisix_json="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-apisix -o json)" || return 1
  observability_json="$(kubectl -n "$EXPECTED_NAMESPACE" get deployment falcone-observability -o json)" || return 1
  printf '%s' "$apisix_json" | jq -e --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" '
    .apiVersion == "apps/v1" and .kind == "Deployment"
    and .metadata.name == "falcone-apisix" and .metadata.namespace == $namespace
    and .metadata.labels["app.kubernetes.io/name"] == "apisix"
    and .metadata.labels["app.kubernetes.io/instance"] == $release
    and .status.observedGeneration == .metadata.generation
    and .spec.replicas == 3
    and .status.updatedReplicas == 3
    and .status.readyReplicas == 3
    and .status.availableReplicas == 3
    and ((.status.unavailableReplicas // 0) == 0)
    and (.spec.template.spec.securityContext as $pod
      | $pod.fsGroup == 1001
      and $pod.fsGroupChangePolicy == "OnRootMismatch"
      and $pod.runAsNonRoot == true
      and $pod.runAsUser == 636
      and $pod.runAsGroup == 636
      and $pod.seccompProfile.type == "RuntimeDefault")
    and ([.spec.template.spec.containers[] | select(
      .name == "apisix"
      and .image == "docker.io/apache/apisix:3.10.0-debian"
      and .securityContext.runAsNonRoot == true
      and .securityContext.runAsUser == 636
      and .securityContext.runAsGroup == 636
      and (.volumeMounts // []) == [{
        "name": "standalone-config",
        "mountPath": "/usr/local/apisix/conf/apisix.yaml",
        "subPath": "apisix.yaml"
      }])] | length) == 1
    and (.spec.template.spec.volumes // []) == [{
      "name": "standalone-config",
      "configMap": {"name": "falcone-apisix-standalone", "defaultMode": 420}
    }]' >/dev/null || return 1
  printf '%s' "$observability_json" | jq -e --arg namespace "$EXPECTED_NAMESPACE" --arg release "$EXPECTED_RELEASE" '
    .apiVersion == "apps/v1" and .kind == "Deployment"
    and .metadata.name == "falcone-observability" and .metadata.namespace == $namespace
    and .metadata.labels["app.kubernetes.io/name"] == "observability"
    and .metadata.labels["app.kubernetes.io/instance"] == $release
    and .status.observedGeneration == .metadata.generation
    and .spec.replicas == 1
    and .status.updatedReplicas == 1
    and .status.readyReplicas == 1
    and .status.availableReplicas == 1
    and ((.status.unavailableReplicas // 0) == 0)
    and (.spec.template.spec.securityContext as $pod
      | $pod.fsGroup == 1001
      and $pod.fsGroupChangePolicy == "OnRootMismatch"
      and $pod.runAsNonRoot == true
      and ($pod | has("runAsUser") | not)
      and ($pod | has("runAsGroup") | not)
      and $pod.seccompProfile.type == "RuntimeDefault")
    and ([.spec.template.spec.containers[] | select(
      .name == "observability"
      and .image == "docker.io/prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62"
      and .securityContext.runAsNonRoot == true
      and .securityContext.runAsUser == 65534
      and .securityContext.runAsGroup == 65534)] | length) == 1' >/dev/null
}

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
  if [[ "$revision23_state" == partial-manual-recovery || "$revision24_state" == global-wait-timeout ]]; then
    validate_revision23_numeric_user_convergence || {
      printf 'REVISION23_NUMERIC_USER_CONVERGENCE_DRIFT\n' >&2
      failed=1
    }
  fi
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

wait_phase_a_rollouts() {
  local workload
  # Phase A deliberately preserves the unbound postgresql-vector PVC and its
  # Pending ordinal-zero Pod for the separately confirmed Phase B. Helm's
  # global --wait cannot distinguish that expected Pending workload from a
  # broken rollout, so wait explicitly for every other managed workload.
  for workload in \
    deployment/falcone-apisix \
    deployment/falcone-control-plane \
    deployment/falcone-control-plane-executor \
    deployment/falcone-ferretdb \
    deployment/falcone-grafana \
    deployment/falcone-keycloak \
    deployment/falcone-observability \
    deployment/falcone-seaweedfs-s3 \
    deployment/falcone-temporal-frontend \
    deployment/falcone-temporal-history \
    deployment/falcone-temporal-matching \
    deployment/falcone-temporal-web \
    deployment/falcone-temporal-worker \
    deployment/falcone-web-console \
    deployment/falcone-workflow-worker \
    statefulset/falcone-documentdb \
    statefulset/falcone-kafka \
    statefulset/falcone-postgresql \
    statefulset/falcone-seaweedfs-filer \
    statefulset/falcone-seaweedfs-master \
    statefulset/falcone-seaweedfs-volume; do
    kubectl -n "$EXPECTED_NAMESPACE" rollout status "$workload" --timeout=10m
  done
  kubectl -n secret-store rollout status statefulset/openbao --timeout=10m
}

printf 'preflight=passed context=%s namespace=%s release=%s revision=%s chart=%s mode=%s dry-run=%s\n' \
  "$actual_context" "$EXPECTED_NAMESPACE" "$EXPECTED_RELEASE" "$actual_revision" "$actual_chart" "$mode" \
  "$([[ "$apply" == true ]] && printf false || printf true)"

if [[ "$apply" == false ]]; then
  if [[ "$mode" == phase-a ]]; then
    adopt_falcone_external_secrets false
  fi
  printf 'no mutation performed; apply requires fresh target-bound backup/parity attestations and exact package confirmation\n'
  exit 0
fi

if [[ "$mode" == phase-a ]]; then
  if [[ "$fixture_failure_seam" == true ]]; then
    expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}"
  elif [[ "$actual_revision" == 21 || "$actual_revision" == 22 || "$actual_revision" == 23 || "$actual_revision" == 24 ]]; then
    expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${actual_revision}/${actual_chart}->${EXPECTED_REPAIR_CHART}/${package_digest}"
  else
    expected_confirmation="${EXPECTED_CONTEXT}/${EXPECTED_NAMESPACE}/${EXPECTED_RELEASE}@${EXPECTED_SOURCE_REVISION}/${EXPECTED_SOURCE_CHART}->${EXPECTED_REPAIR_CHART}/${package_digest}"
  fi
  [[ "$confirm_target" == "$expected_confirmation" ]] || die "JIT_TARGET_CONFIRMATION_REQUIRED expected=${expected_confirmation}"
  owner_before="$(owner_metadata)"
  mutation_started=true
  run_revision24_pre_handoff_auth_reconcile
  apply_legacy_clustersecretstore_handoff
  adopt_falcone_external_secrets true
  helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --timeout 20m "${phase_a_args[@]}"
  wait_phase_a_rollouts
  if ! health_gate "$owner_before" false; then die "PHASE_A_HEALTH_GATE_FAILED"; fi
  owner_before_second="$(owner_metadata)"
  helm upgrade "$EXPECTED_RELEASE" "$chart_source" --version "$EXPECTED_REPAIR_VERSION" --namespace "$EXPECTED_NAMESPACE" --timeout 20m "${phase_a_no_root_args[@]}"
  wait_phase_a_rollouts
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
