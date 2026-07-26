#!/bin/sh
#
# Create or validate the retained Secret that carries the four bounded webhook
# PostgreSQL credentials. Secret values are never accepted as arguments and no
# command in this file writes them to stdout/stderr.

set -eu
umask 077

fail() {
  printf '%s\n' 'WEBHOOK_DATABASE_CREDENTIAL_INVALID' >&2
  exit 1
}

required() {
  eval "required_value=\${$1:-}"
  [ -n "$required_value" ] || fail
}

for required_name in \
  RELEASE_NAMESPACE RELEASE_NAME CHART_LABEL APP_NAME MANAGED_BY \
  WEBHOOK_DATABASE_CREDENTIAL_SECRET WEBHOOK_DATABASE_CREDENTIAL_MARKER \
  WEBHOOK_DATABASE_CREDENTIAL_CREATE WEBHOOK_DATABASE_IS_UPGRADE \
  WEBHOOK_DATABASE_FIRST_HANDOFF \
  WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED \
  WEBHOOK_DATABASE_MARKER_CREATE_AUTHORIZED \
  WEBHOOK_DATABASE_HOST WEBHOOK_DATABASE_PORT \
  WEBHOOK_DATABASE_NAME WEBHOOK_SCHEMA_DATABASE_ROLE \
  WEBHOOK_RUNTIME_DATABASE_ROLE WEBHOOK_KEY_WRITE_DATABASE_ROLE \
  WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE
do
  required "$required_name"
done

for boolean_value in \
  "$WEBHOOK_DATABASE_CREDENTIAL_CREATE" "$WEBHOOK_DATABASE_IS_UPGRADE" \
  "$WEBHOOK_DATABASE_FIRST_HANDOFF" \
  "$WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED" \
  "$WEBHOOK_DATABASE_MARKER_CREATE_AUTHORIZED"
do
  case "$boolean_value" in true|false) ;; *) fail ;; esac
done

secret_get() {
  kubectl -n "$RELEASE_NAMESPACE" get secret \
    "$WEBHOOK_DATABASE_CREDENTIAL_SECRET" "$@" 2>/dev/null
}

secret_exists() {
  secret_get >/dev/null
}

marker_get() {
  kubectl -n "$RELEASE_NAMESPACE" get configmap \
    "$WEBHOOK_DATABASE_CREDENTIAL_MARKER" "$@" 2>/dev/null
}

marker_exists() {
  marker_get >/dev/null
}

required_keys='WEBHOOK_SCHEMA_DATABASE_PASSWORD
WEBHOOK_RUNTIME_DATABASE_PASSWORD
WEBHOOK_KEY_WRITE_DATABASE_PASSWORD
WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD
WEBHOOK_SCHEMA_DATABASE_URL
WEBHOOK_RUNTIME_DATABASE_URL
WEBHOOK_KEY_WRITE_DATABASE_URL
WEBHOOK_KEY_LIFECYCLE_DATABASE_URL'

validate_existing() {
  key_count="$(secret_get -o go-template='{{len .data}}')" || fail
  [ "$key_count" = "8" ] || fail

  for key_name in $required_keys; do
    encoded="$(secret_get -o "go-template={{index .data \"$key_name\"}}")" || fail
    [ -n "$encoded" ] || fail
    decoded="$(printf '%s' "$encoded" | base64 -d 2>/dev/null)" || fail
    [ -n "$decoded" ] || fail
    unset encoded decoded
  done

  secret_value() {
    encoded_value="$(secret_get -o "go-template={{index .data \"$1\"}}")" || fail
    printf '%s' "$encoded_value" | base64 -d 2>/dev/null
  }

  schema_password="$(secret_value WEBHOOK_SCHEMA_DATABASE_PASSWORD)" || fail
  runtime_password="$(secret_value WEBHOOK_RUNTIME_DATABASE_PASSWORD)" || fail
  writer_password="$(secret_value WEBHOOK_KEY_WRITE_DATABASE_PASSWORD)" || fail
  lifecycle_password="$(secret_value WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD)" || fail
  for password_value in \
    "$schema_password" "$runtime_password" "$writer_password" "$lifecycle_password"
  do
    [ "${#password_value}" -ge 32 ] || fail
    [ "${#password_value}" -le 128 ] || fail
    case "$password_value" in *[!A-Za-z0-9._~-]*) fail ;; esac
  done
  [ "$(printf '%s\n' \
      "$schema_password" "$runtime_password" "$writer_password" "$lifecycle_password" \
      | sort -u | wc -l | tr -d ' ')" = "4" ] || fail

  schema_url="$(secret_value WEBHOOK_SCHEMA_DATABASE_URL)" || fail
  runtime_url="$(secret_value WEBHOOK_RUNTIME_DATABASE_URL)" || fail
  writer_url="$(secret_value WEBHOOK_KEY_WRITE_DATABASE_URL)" || fail
  lifecycle_url="$(secret_value WEBHOOK_KEY_LIFECYCLE_DATABASE_URL)" || fail
  [ "$schema_url" = "postgresql://${WEBHOOK_SCHEMA_DATABASE_ROLE}:${schema_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}" ] || fail
  [ "$runtime_url" = "postgresql://${WEBHOOK_RUNTIME_DATABASE_ROLE}:${runtime_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}" ] || fail
  [ "$writer_url" = "postgresql://${WEBHOOK_KEY_WRITE_DATABASE_ROLE}:${writer_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}" ] || fail
  [ "$lifecycle_url" = "postgresql://${WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE}:${lifecycle_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}" ] || fail
  unset schema_password runtime_password writer_password lifecycle_password
  unset schema_url runtime_url writer_url lifecycle_url encoded_value

  if [ "$WEBHOOK_DATABASE_CREDENTIAL_CREATE" = "true" ]; then
    immutable="$(secret_get -o go-template='{{.immutable}}')" || fail
    managed_by="$(secret_get -o go-template='{{index .metadata.labels "app.kubernetes.io/managed-by"}}')" || fail
    instance="$(secret_get -o go-template='{{index .metadata.labels "app.kubernetes.io/instance"}}')" || fail
    component="$(secret_get -o go-template='{{index .metadata.labels "app.kubernetes.io/component"}}')" || fail
    keep="$(secret_get -o go-template='{{index .metadata.annotations "helm.sh/resource-policy"}}')" || fail
    [ "$immutable" = "true" ] || fail
    [ "$managed_by" = "$MANAGED_BY" ] || fail
    [ "$instance" = "$RELEASE_NAME" ] || fail
    [ "$component" = "webhook-database-credentials" ] || fail
    [ "$keep" = "keep" ] || fail
  fi
}

validate_marker() {
  marker_state="$(marker_get -o go-template='{{index .data "state"}}')" || fail
  marker_immutable="$(marker_get -o go-template='{{.immutable}}')" || fail
  marker_managed_by="$(marker_get -o go-template='{{index .metadata.labels "app.kubernetes.io/managed-by"}}')" || fail
  marker_instance="$(marker_get -o go-template='{{index .metadata.labels "app.kubernetes.io/instance"}}')" || fail
  marker_component="$(marker_get -o go-template='{{index .metadata.labels "app.kubernetes.io/component"}}')" || fail
  marker_keep="$(marker_get -o go-template='{{index .metadata.annotations "helm.sh/resource-policy"}}')" || fail
  [ "$marker_state" = "initialized" ] || fail
  [ "$marker_immutable" = "true" ] || fail
  [ "$marker_managed_by" = "$MANAGED_BY" ] || fail
  [ "$marker_instance" = "$RELEASE_NAME" ] || fail
  [ "$marker_component" = "webhook-database-credential-state" ] || fail
  [ "$marker_keep" = "keep" ] || fail
  unset marker_state marker_immutable marker_managed_by marker_instance
  unset marker_component marker_keep
}

create_marker() {
  [ "$WEBHOOK_DATABASE_MARKER_CREATE_AUTHORIZED" = "true" ] || fail
  if ! kubectl -n "$RELEASE_NAMESPACE" create configmap \
    "$WEBHOOK_DATABASE_CREDENTIAL_MARKER" \
    --from-literal=state=initialized \
    --dry-run=client -o json 2>/dev/null \
    | jq \
        --arg chart "$CHART_LABEL" \
        --arg app "$APP_NAME" \
        --arg instance "$RELEASE_NAME" \
        --arg managed_by "$MANAGED_BY" \
        --arg release_name "$RELEASE_NAME" \
        --arg release_namespace "$RELEASE_NAMESPACE" \
        '.immutable = true
         | .metadata.labels = {
             "helm.sh/chart": $chart,
             "app.kubernetes.io/name": $app,
             "app.kubernetes.io/instance": $instance,
             "app.kubernetes.io/managed-by": $managed_by,
             "app.kubernetes.io/part-of": "in-falcone",
             "app.kubernetes.io/component": "webhook-database-credential-state"
           }
         | .metadata.annotations = {
             "helm.sh/resource-policy": "keep",
             "meta.helm.sh/release-name": $release_name,
             "meta.helm.sh/release-namespace": $release_namespace
           }' \
    | kubectl create -f - >/dev/null 2>&1
  then
    fail
  fi
}

ensure_managed_marker() {
  if marker_exists; then
    validate_marker
    return
  fi
  create_marker
  validate_marker
}

if secret_exists; then
  validate_existing
  if [ "$WEBHOOK_DATABASE_CREDENTIAL_CREATE" = "true" ]; then
    ensure_managed_marker
  fi
  printf '%s\n' 'WEBHOOK_DATABASE_CREDENTIAL_REUSED'
  exit 0
fi

# Existing/external credential custody is strictly read-only. A managed Secret
# is created only on a fresh install or an explicit backup-gated first handoff.
# The retained marker prevents a missing Secret from ever being regenerated by
# replaying an old initialization values set.
[ "$WEBHOOK_DATABASE_CREDENTIAL_CREATE" = "true" ] || fail
marker_exists && fail
if [ "$WEBHOOK_DATABASE_IS_UPGRADE" = "true" ]; then
  [ "$WEBHOOK_DATABASE_FIRST_HANDOFF" = "true" ] || fail
else
  [ "$WEBHOOK_DATABASE_FIRST_HANDOFF" = "false" ] || fail
fi
[ "$WEBHOOK_DATABASE_SECRET_CREATE_AUTHORIZED" = "true" ] || fail

case "$WEBHOOK_DATABASE_PORT" in
  *[!0-9]*|'') fail ;;
esac

work_dir="$(mktemp -d /tmp/webhook-db-credential.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

random_password() {
  # 32 random bytes encoded as 64 URL-safe hexadecimal characters.
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

schema_password="$(random_password)"
runtime_password="$(random_password)"
writer_password="$(random_password)"
lifecycle_password="$(random_password)"

[ "$schema_password" != "$runtime_password" ] || fail
[ "$schema_password" != "$writer_password" ] || fail
[ "$schema_password" != "$lifecycle_password" ] || fail
[ "$runtime_password" != "$writer_password" ] || fail
[ "$runtime_password" != "$lifecycle_password" ] || fail
[ "$writer_password" != "$lifecycle_password" ] || fail

write_key() {
  key_name="$1"
  key_value="$2"
  printf '%s' "$key_value" >"$work_dir/$key_name"
  chmod 0400 "$work_dir/$key_name"
}

write_key WEBHOOK_SCHEMA_DATABASE_PASSWORD "$schema_password"
write_key WEBHOOK_RUNTIME_DATABASE_PASSWORD "$runtime_password"
write_key WEBHOOK_KEY_WRITE_DATABASE_PASSWORD "$writer_password"
write_key WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD "$lifecycle_password"
write_key WEBHOOK_SCHEMA_DATABASE_URL \
  "postgresql://${WEBHOOK_SCHEMA_DATABASE_ROLE}:${schema_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}"
write_key WEBHOOK_RUNTIME_DATABASE_URL \
  "postgresql://${WEBHOOK_RUNTIME_DATABASE_ROLE}:${runtime_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}"
write_key WEBHOOK_KEY_WRITE_DATABASE_URL \
  "postgresql://${WEBHOOK_KEY_WRITE_DATABASE_ROLE}:${writer_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}"
write_key WEBHOOK_KEY_LIFECYCLE_DATABASE_URL \
  "postgresql://${WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE}:${lifecycle_password}@${WEBHOOK_DATABASE_HOST}:${WEBHOOK_DATABASE_PORT}/${WEBHOOK_DATABASE_NAME}"

if ! kubectl -n "$RELEASE_NAMESPACE" create secret generic \
  "$WEBHOOK_DATABASE_CREDENTIAL_SECRET" \
  --from-file=WEBHOOK_SCHEMA_DATABASE_PASSWORD="$work_dir/WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  --from-file=WEBHOOK_RUNTIME_DATABASE_PASSWORD="$work_dir/WEBHOOK_RUNTIME_DATABASE_PASSWORD" \
  --from-file=WEBHOOK_KEY_WRITE_DATABASE_PASSWORD="$work_dir/WEBHOOK_KEY_WRITE_DATABASE_PASSWORD" \
  --from-file=WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD="$work_dir/WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD" \
  --from-file=WEBHOOK_SCHEMA_DATABASE_URL="$work_dir/WEBHOOK_SCHEMA_DATABASE_URL" \
  --from-file=WEBHOOK_RUNTIME_DATABASE_URL="$work_dir/WEBHOOK_RUNTIME_DATABASE_URL" \
  --from-file=WEBHOOK_KEY_WRITE_DATABASE_URL="$work_dir/WEBHOOK_KEY_WRITE_DATABASE_URL" \
  --from-file=WEBHOOK_KEY_LIFECYCLE_DATABASE_URL="$work_dir/WEBHOOK_KEY_LIFECYCLE_DATABASE_URL" \
  --dry-run=client -o json 2>/dev/null \
  | jq \
      --arg chart "$CHART_LABEL" \
      --arg app "$APP_NAME" \
      --arg instance "$RELEASE_NAME" \
      --arg managed_by "$MANAGED_BY" \
      --arg release_name "$RELEASE_NAME" \
      --arg release_namespace "$RELEASE_NAMESPACE" \
      '.immutable = true
       | .metadata.labels = {
           "helm.sh/chart": $chart,
           "app.kubernetes.io/name": $app,
           "app.kubernetes.io/instance": $instance,
           "app.kubernetes.io/managed-by": $managed_by,
           "app.kubernetes.io/part-of": "in-falcone",
           "app.kubernetes.io/component": "webhook-database-credentials"
         }
       | .metadata.annotations = {
           "helm.sh/resource-policy": "keep",
           "meta.helm.sh/release-name": $release_name,
           "meta.helm.sh/release-namespace": $release_namespace
         }' \
  | kubectl create -f - >/dev/null 2>&1
then
  fail
fi

unset schema_password runtime_password writer_password lifecycle_password
validate_existing
ensure_managed_marker
printf '%s\n' 'WEBHOOK_DATABASE_CREDENTIAL_CREATED'
