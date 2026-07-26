#!/bin/sh
#
# Disposable PostgreSQL 16.14 integration suite for the C-25 authority
# bootstrap. Bootstrap and bounded-login probes run from a separate client
# container over a Docker network whose host rules require SCRAM. No fixture
# credential is printed or placed in docker argv.

set -eu
umask 077

root_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
bootstrap_script="$root_dir/charts/in-falcone/files/webhook-database-authority-bootstrap.sh"
container="falcone-c25-bootstrap-pg16-$$"
unsupported_container="falcone-c25-bootstrap-pg15-$$"
network="falcone-c25-bootstrap-net-$$"
client_image="docker.io/library/postgres:16.14-alpine"
unsupported_image="docker.io/library/postgres:15-alpine"
had_client_image=false
if docker image inspect "$client_image" >/dev/null 2>&1; then
  had_client_image=true
fi
had_unsupported_image=false
if docker image inspect "$unsupported_image" >/dev/null 2>&1; then
  had_unsupported_image=true
fi
passed=0

cleanup() {
  docker rm -fv "$container" >/dev/null 2>&1 || true
  docker rm -fv "$unsupported_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "$had_client_image" = "false" ]; then
    docker image rm "$client_image" >/dev/null 2>&1 || true
  fi
  if [ "$had_unsupported_image" = "false" ]; then
    docker image rm "$unsupported_image" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

ok() {
  passed=$((passed + 1))
  printf 'ok %s - %s\n' "$passed" "$1"
}

fail() {
  printf 'not ok %s - %s\n' "$((passed + 1))" "$1" >&2
  exit 1
}

random_fixture() {
  od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
}

docker network create \
  --label falcone.c25.task=webhook-database-bootstrap-test \
  "$network" >/dev/null

export PGHOST="$container"
export PGPORT=5432
export PGUSER=postgres
export PGPASSWORD="$(random_fixture)"
export GLOBAL_DATABASE_ROLE=falcone
export WEBHOOK_SCHEMA_DATABASE_ROLE=falcone_webhook_schema
export WEBHOOK_RUNTIME_DATABASE_ROLE=falcone_webhook_runtime
export WEBHOOK_KEY_WRITE_DATABASE_ROLE=falcone_webhook_writer
export WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE=falcone_webhook_lifecycle_login
export WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE=postgres
export WEBHOOK_SCHEMA_DATABASE_PASSWORD="$(random_fixture)"
export WEBHOOK_RUNTIME_DATABASE_PASSWORD="$(random_fixture)"
export WEBHOOK_KEY_WRITE_DATABASE_PASSWORD="$(random_fixture)"
export WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD="$(random_fixture)"
export ATTACKER_RUNTIME_DATABASE_PASSWORD="$(random_fixture)"
export POSTGRES_PASSWORD="$PGPASSWORD"

docker run -d \
  --name "$container" \
  --network "$network" \
  --label falcone.c25.task=webhook-database-bootstrap-test \
  -e POSTGRES_PASSWORD \
  "$client_image" >/dev/null
unset POSTGRES_PASSWORD

docker exec "$container" sh -ec \
  'for i in $(seq 1 90); do
     if pg_isready -U postgres >/dev/null 2>&1; then
       sleep 2
       pg_isready -U postgres >/dev/null 2>&1 && exit 0
     fi
     sleep 1
   done
   exit 1'

server_version="$(docker exec "$container" psql -X -qAt -U postgres -c 'SHOW server_version')"
[ "$server_version" = "16.14" ] || fail 'PostgreSQL 16.14 server identity'
ok 'PostgreSQL 16.14 server identity'

scram_posture="$(
  docker exec "$container" psql -X -qAt -U postgres \
    -c "SELECT current_setting('password_encryption') || ':' || CASE WHEN bool_and(auth_method = 'scram-sha-256') THEN 'yes' ELSE 'no' END FROM pg_hba_file_rules WHERE type LIKE 'host%' AND address = 'all' AND 'all' = ANY(database) AND 'all' = ANY(user_name) AND error IS NULL"
)"
[ "$scram_posture" = "scram-sha-256:yes" ] \
  || fail 'separate-client host authentication requires SCRAM'
ok 'separate-client host authentication requires SCRAM'

docker exec "$container" psql -X -q -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE falcone LOGIN CREATEDB'

set_urls() {
  export WEBHOOK_SCHEMA_DATABASE_URL="postgresql://${WEBHOOK_SCHEMA_DATABASE_ROLE}:${WEBHOOK_SCHEMA_DATABASE_PASSWORD}@127.0.0.1:5432/${PGDATABASE}"
  export WEBHOOK_RUNTIME_DATABASE_URL="postgresql://${WEBHOOK_RUNTIME_DATABASE_ROLE}:${WEBHOOK_RUNTIME_DATABASE_PASSWORD}@127.0.0.1:5432/${PGDATABASE}"
  export WEBHOOK_KEY_WRITE_DATABASE_URL="postgresql://${WEBHOOK_KEY_WRITE_DATABASE_ROLE}:${WEBHOOK_KEY_WRITE_DATABASE_PASSWORD}@127.0.0.1:5432/${PGDATABASE}"
  export WEBHOOK_KEY_LIFECYCLE_DATABASE_URL="postgresql://${WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE}:${WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD}@127.0.0.1:5432/${PGDATABASE}"
}

invoke_bootstrap() {
  set_urls
  docker run --rm -i \
    --network "$network" \
    --label falcone.c25.task=webhook-database-bootstrap-test \
    -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
    -e GLOBAL_DATABASE_ROLE \
    -e WEBHOOK_SCHEMA_DATABASE_ROLE \
    -e WEBHOOK_RUNTIME_DATABASE_ROLE \
    -e WEBHOOK_KEY_WRITE_DATABASE_ROLE \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE \
    -e WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE \
    -e WEBHOOK_SCHEMA_DATABASE_PASSWORD \
    -e WEBHOOK_RUNTIME_DATABASE_PASSWORD \
    -e WEBHOOK_KEY_WRITE_DATABASE_PASSWORD \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD \
    -e WEBHOOK_SCHEMA_DATABASE_URL \
    -e WEBHOOK_RUNTIME_DATABASE_URL \
    -e WEBHOOK_KEY_WRITE_DATABASE_URL \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_URL \
    -e WEBHOOK_DATABASE_BOOTSTRAP_MODE \
    "$client_image" sh -s <"$bootstrap_script"
}

invoke_bootstrap_bounded_tmp_failure() {
  set_urls
  docker run --rm \
    --network "$network" \
    --label falcone.c25.task=webhook-database-bootstrap-test \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=1m \
    --volume "$bootstrap_script:/bootstrap.sh:ro" \
    -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
    -e GLOBAL_DATABASE_ROLE \
    -e WEBHOOK_SCHEMA_DATABASE_ROLE \
    -e WEBHOOK_RUNTIME_DATABASE_ROLE \
    -e WEBHOOK_KEY_WRITE_DATABASE_ROLE \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE \
    -e WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE \
    -e WEBHOOK_SCHEMA_DATABASE_PASSWORD \
    -e WEBHOOK_RUNTIME_DATABASE_PASSWORD \
    -e WEBHOOK_KEY_WRITE_DATABASE_PASSWORD \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD \
    -e WEBHOOK_SCHEMA_DATABASE_URL \
    -e WEBHOOK_RUNTIME_DATABASE_URL \
    -e WEBHOOK_KEY_WRITE_DATABASE_URL \
    -e WEBHOOK_KEY_LIFECYCLE_DATABASE_URL \
    -e WEBHOOK_DATABASE_BOOTSTRAP_MODE \
    "$client_image" sh -ec '
      if bootstrap_output="$(sh /bootstrap.sh 2>&1)"; then
        exit 1
      else
        bootstrap_status=$?
      fi
      [ "$bootstrap_status" -eq 1 ]
      [ "$bootstrap_output" = WEBHOOK_DATABASE_BOOTSTRAP_FAILED ]
      [ -z "$(find /tmp -mindepth 1 -maxdepth 1 -print -quit)" ]
      printf "%s\n" "$bootstrap_output"
    '
}

run_bootstrap() {
  expected_output="${1:-WEBHOOK_DATABASE_BOOTSTRAP_READY}"
  output="$(invoke_bootstrap 2>/dev/null)" || return 1
  [ "$output" = "$expected_output" ]
}

reject_bootstrap() {
  if run_bootstrap >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

reject_bootstrap_code() {
  expected_code="$1"
  if output="$(invoke_bootstrap 2>&1)"; then
    return 1
  fi
  [ "$output" = "$expected_code" ]
}

admin_sql() {
  database="$1"
  sql="$2"
  docker exec "$container" psql -X -q -U postgres -d "$database" \
    -v ON_ERROR_STOP=1 -c "$sql"
}

query() {
  database="$1"
  sql="$2"
  docker exec "$container" psql -X -qAt -U postgres -d "$database" \
    -v ON_ERROR_STOP=1 -c "$sql"
}

bounded_sql() {
  bounded_role="$1"
  bounded_password="$2"
  bounded_database="$3"
  bounded_statement="$4"
  (
    export PGUSER="$bounded_role"
    export PGPASSWORD="$bounded_password"
    export PGDATABASE="$bounded_database"
    docker run --rm \
      --network "$network" \
      --label falcone.c25.task=webhook-database-bootstrap-test \
      -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
      "$client_image" \
      psql -X -q -v ON_ERROR_STOP=1 -c "$bounded_statement"
  )
}

bounded_identity() {
  bounded_role="$1"
  bounded_password="$2"
  bounded_database="$3"
  (
    export PGUSER="$bounded_role"
    export PGPASSWORD="$bounded_password"
    export PGDATABASE="$bounded_database"
    docker run --rm \
      --network "$network" \
      --label falcone.c25.task=webhook-database-bootstrap-test \
      -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
      "$client_image" \
      psql -X -qAt -v ON_ERROR_STOP=1 \
        -c 'SELECT CASE WHEN session_user = current_user THEN session_user ELSE NULL END' \
      2>/dev/null
  )
}

# A hostile pre-existing exact-flags LOGIN must be credential-proven before
# any role, membership, schema ACL, or ownership mutation is attempted.
admin_sql postgres 'CREATE DATABASE c25_credential_mismatch OWNER falcone'
docker exec -i \
  -e ATTACKER_RUNTIME_DATABASE_PASSWORD \
  "$container" psql -X -q -U postgres -v ON_ERROR_STOP=1 <<'SQL'
\getenv attacker_password ATTACKER_RUNTIME_DATABASE_PASSWORD
CREATE ROLE falcone_webhook_runtime
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT
  NOREPLICATION NOBYPASSRLS
  PASSWORD :'attacker_password';
SQL
export PGDATABASE=c25_credential_mismatch
export WEBHOOK_DATABASE_BOOTSTRAP_MODE=apply
reject_bootstrap || fail 'pre-existing bounded credential mismatch rejection'

mismatch_state="$(
  query c25_credential_mismatch "
    SELECT
      (SELECT count(*) FROM pg_roles
        WHERE rolname IN (
          'falcone_webhook_schema','falcone_webhook_writer',
          'falcone_webhook_lifecycle_login','falcone_app',
          'falcone_webhook_key_writer','falcone_webhook_key_lifecycle'
        )) || ':' ||
      (SELECT count(*) FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid=membership.member
        WHERE member.rolname='falcone_webhook_runtime') || ':' ||
      (SELECT count(*)
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) privilege
         JOIN pg_roles grantee ON grantee.oid=privilege.grantee
        WHERE namespace.nspname='public'
          AND grantee.rolname='falcone_webhook_schema')"
)"
[ "$mismatch_state" = "0:0:0" ] \
  || fail 'credential mismatch preserves roles memberships and schema ACL'
if bounded_identity \
  "$WEBHOOK_RUNTIME_DATABASE_ROLE" \
  "$WEBHOOK_RUNTIME_DATABASE_PASSWORD" \
  c25_credential_mismatch >/dev/null 2>&1
then
  fail 'managed runtime credential must not authenticate hostile role'
fi
[ "$(bounded_identity \
    "$WEBHOOK_RUNTIME_DATABASE_ROLE" \
    "$ATTACKER_RUNTIME_DATABASE_PASSWORD" \
    c25_credential_mismatch)" = "$WEBHOOK_RUNTIME_DATABASE_ROLE" ] \
  || fail 'hostile credential remains unchanged but unauthorized'
ok 'credential mismatch fails before all authority and ownership mutation'

admin_sql postgres 'DROP DATABASE c25_credential_mismatch'
admin_sql postgres 'DROP ROLE falcone_webhook_runtime'

# Fresh: roles precede application DDL; the bounded schema LOGIN owns objects it
# creates after the gate.
admin_sql postgres 'CREATE DATABASE c25_fresh OWNER falcone'
export PGDATABASE=c25_fresh
export WEBHOOK_DATABASE_BOOTSTRAP_MODE=verify
run_bootstrap WEBHOOK_DATABASE_BOOTSTRAP_VERIFIED \
  || fail 'rollback-only fresh authority verification'
dry_run_role_count="$(
  query c25_fresh "
    SELECT count(*) FROM pg_roles
    WHERE rolname IN (
      'falcone_webhook_schema','falcone_webhook_runtime',
      'falcone_webhook_writer','falcone_webhook_lifecycle_login',
      'falcone_app','falcone_webhook_key_writer',
      'falcone_webhook_key_lifecycle'
    )"
)"
[ "$dry_run_role_count" = "0" ] || fail 'rollback-only authority state preservation'
ok 'default verification mode rolls back all fresh-install authority changes'

export WEBHOOK_DATABASE_BOOTSTRAP_MODE=apply
run_bootstrap || fail 'fresh bounded authority bootstrap'
ok 'fresh bounded authority bootstrap'

schema_privileges="$(
  query c25_fresh "
    SELECT string_agg(
      privilege.privilege_type || ':' || grantor.rolname,
      ',' ORDER BY privilege.privilege_type
    )
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(
      COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
    ) privilege
    JOIN pg_roles grantee ON grantee.oid=privilege.grantee
    JOIN pg_roles grantor ON grantor.oid=privilege.grantor
    WHERE namespace.nspname='public'
      AND grantee.rolname='falcone_webhook_schema'"
)"
[ "$schema_privileges" = 'CREATE:pg_database_owner,USAGE:pg_database_owner' ] \
  || fail 'bounded schema privilege and grantor provenance'
ok 'bounded schema has only owner-provenance public-schema CREATE and USAGE'

graph="$(
  query c25_fresh "
    SELECT string_agg(
      granted.rolname || '>' || member.rolname || ':' ||
      membership.admin_option || ':' || membership.inherit_option || ':' ||
      membership.set_option || ':' || grantor.rolname,
      ',' ORDER BY granted.rolname
    )
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
    WHERE member.rolname IN (
      'falcone_webhook_runtime',
      'falcone_webhook_writer',
      'falcone_webhook_lifecycle_login'
    )"
)"
[ "$graph" = 'falcone_app>falcone_webhook_runtime:false:true:false:postgres,falcone_webhook_key_lifecycle>falcone_webhook_lifecycle_login:false:false:true:postgres,falcone_webhook_key_writer>falcone_webhook_writer:false:false:true:postgres' ] \
  || fail 'exact PostgreSQL 16 membership graph and grantor provenance'
ok 'exact PostgreSQL 16 membership graph and grantor provenance'

bounded_sql \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  c25_fresh \
  'CREATE TABLE webhook_subscriptions (id text PRIMARY KEY, payload text); CREATE TABLE webhook_signing_secrets (id text PRIMARY KEY, subscription_id text, secret_cipher text); CREATE TABLE webhook_deliveries (id text PRIMARY KEY, payload text); CREATE TABLE webhook_delivery_attempts (id text PRIMARY KEY, payload text); CREATE TABLE webhook_master_key_state (singleton smallint PRIMARY KEY, verification_cipher text); CREATE TABLE webhook_master_key_rotations (request_id text PRIMARY KEY, result_payload text); CREATE FUNCTION falcone_webhook_key_write_current_id() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$; CREATE FUNCTION falcone_webhook_signing_secret_write_statement_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE FUNCTION falcone_webhook_signing_secret_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'
fresh_owners="$(
  query c25_fresh "
    SELECT count(*)
    FROM (
      SELECT class.oid
      FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname='public'
        AND class.relkind='r'
        AND class.relname IN (
          'webhook_subscriptions','webhook_signing_secrets',
          'webhook_deliveries','webhook_delivery_attempts',
          'webhook_master_key_state','webhook_master_key_rotations'
        )
        AND pg_get_userbyid(class.relowner)='falcone_webhook_schema'
      UNION ALL
      SELECT procedure.oid
      FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
      WHERE namespace.nspname='public'
        AND procedure.pronargs=0
        AND procedure.proname IN (
          'falcone_webhook_key_write_current_id',
          'falcone_webhook_signing_secret_write_statement_fence',
          'falcone_webhook_signing_secret_write_fence'
        )
        AND pg_get_userbyid(procedure.proowner)='falcone_webhook_schema'
    ) objects"
)"
[ "$fresh_owners" = '9' ] \
  || fail 'fresh application DDL is owned by bounded schema LOGIN'
run_bootstrap || fail 'fresh replay after bounded schema DDL'
ok 'fresh exact object graph and automatic dependent ownership replay'

# Legacy upgrade: transfer only the six enumerated tables and three
# zero-argument functions. Preserve even old assumed sequence names and all
# unrelated control objects.
admin_sql postgres 'CREATE DATABASE c25_legacy OWNER falcone'
docker exec "$container" psql -X -q -U falcone -d c25_legacy -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE webhook_subscriptions (id integer); CREATE TABLE webhook_signing_secrets (id integer); CREATE TABLE webhook_deliveries (id integer); CREATE TABLE webhook_delivery_attempts (id integer); CREATE TABLE plan_audit_events (id text, action_type text); CREATE SEQUENCE webhook_subscriptions_id_seq; CREATE TABLE unrelated_control (id integer); CREATE SEQUENCE unrelated_control_seq; CREATE FUNCTION falcone_webhook_key_write_current_id() RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$; CREATE FUNCTION falcone_webhook_signing_secret_write_statement_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$; CREATE FUNCTION falcone_webhook_signing_secret_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$'
export PGDATABASE=c25_legacy
run_bootstrap || fail 'legacy enumerated ownership handoff'

audit_acl="$(
  query c25_legacy "
    SELECT string_agg(
      grantee.rolname || ':' || privilege.privilege_type || ':' ||
      grantor.rolname || ':' || privilege.is_grantable,
      ',' ORDER BY privilege.privilege_type
    )
    FROM pg_class class
    CROSS JOIN LATERAL aclexplode(
      COALESCE(class.relacl, acldefault('r', class.relowner))
    ) privilege
    JOIN pg_roles grantee ON grantee.oid=privilege.grantee
    JOIN pg_roles grantor ON grantor.oid=privilege.grantor
    WHERE class.oid='public.plan_audit_events'::regclass
      AND grantee.rolname='falcone_webhook_key_lifecycle'"
)"
[ "$audit_acl" = 'falcone_webhook_key_lifecycle:INSERT:falcone:false,falcone_webhook_key_lifecycle:SELECT:falcone:false' ] \
  || fail 'pre-deployment lifecycle audit ACL bootstrap'
[ "$(query c25_legacy "
    SELECT pg_get_userbyid(relowner) || ':' ||
      has_table_privilege('falcone_webhook_lifecycle_login',
        'public.plan_audit_events','SELECT') || ':' ||
      has_table_privilege('falcone_webhook_lifecycle_login',
        'public.plan_audit_events','INSERT')
      FROM pg_class
     WHERE oid='public.plan_audit_events'::regclass")" = 'falcone:false:false' ] \
  || fail 'lifecycle audit access is available only after bounded SET ROLE'
ok 'first-handoff bootstrap grants exact lifecycle audit access before Deployment'

enumerated_owner_count="$(
  query c25_legacy "
    SELECT count(*) FROM (
      SELECT 1
      FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
      WHERE namespace.nspname='public'
        AND class.relname IN (
          'webhook_subscriptions','webhook_signing_secrets',
          'webhook_deliveries','webhook_delivery_attempts'
        )
        AND pg_get_userbyid(class.relowner)='falcone_webhook_schema'
      UNION ALL
      SELECT 1
      FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
      WHERE namespace.nspname='public'
        AND procedure.proname IN (
          'falcone_webhook_key_write_current_id',
          'falcone_webhook_signing_secret_write_statement_fence',
          'falcone_webhook_signing_secret_write_fence'
        )
        AND pg_get_userbyid(procedure.proowner)='falcone_webhook_schema'
    ) owned"
)"
[ "$enumerated_owner_count" = "7" ] || fail 'legacy enumerated object ownership transfer'
non_enumerated_owners="$(
  query c25_legacy "
    SELECT string_agg(pg_get_userbyid(class.relowner), ',' ORDER BY class.relname)
    FROM pg_class class JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public'
      AND class.relname IN (
        'unrelated_control','unrelated_control_seq',
        'webhook_subscriptions_id_seq'
      )"
)"
[ "$non_enumerated_owners" = 'falcone,falcone,falcone' ] \
  || fail 'non-enumerated object preservation'
ok 'legacy handoff preserves old assumed and unrelated sequences'

run_bootstrap || fail 'ordinary no-op replay'
ok 'ordinary no-op replay reuses the existing graph'

admin_sql c25_legacy \
  'CREATE ROLE c25_audit_foreign_owner NOLOGIN; ALTER TABLE plan_audit_events OWNER TO c25_audit_foreign_owner'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_OWNER_DRIFT \
  || fail 'lifecycle audit owner drift rejection'
admin_sql c25_legacy \
  'ALTER TABLE plan_audit_events OWNER TO falcone; DROP ROLE c25_audit_foreign_owner'
run_bootstrap || fail 'lifecycle audit owner drift recovery'
ok 'lifecycle audit owner drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE INSERT ON plan_audit_events FROM falcone_webhook_key_lifecycle; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'partial lifecycle audit ACL rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; GRANT INSERT ON plan_audit_events TO falcone_webhook_key_lifecycle; RESET ROLE'
run_bootstrap || fail 'partial lifecycle audit ACL recovery'
ok 'partial lifecycle audit ACL fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT DELETE ON plan_audit_events TO falcone_webhook_lifecycle_login; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'direct lifecycle LOGIN table grant rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE DELETE ON plan_audit_events FROM falcone_webhook_lifecycle_login; RESET ROLE'
run_bootstrap || fail 'direct lifecycle LOGIN table grant recovery'
ok 'direct lifecycle LOGIN table privilege drift fails closed'

admin_sql c25_legacy \
  'GRANT UPDATE (action_type) ON plan_audit_events TO falcone_webhook_lifecycle_login'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'direct lifecycle audit column grant rejection'
admin_sql c25_legacy \
  'REVOKE UPDATE (action_type) ON plan_audit_events FROM falcone_webhook_lifecycle_login'
run_bootstrap || fail 'lifecycle audit column grant recovery'
ok 'direct lifecycle audit column privilege drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT DELETE ON plan_audit_events TO PUBLIC; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'PUBLIC lifecycle audit table grant rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE DELETE ON plan_audit_events FROM PUBLIC; RESET ROLE'
run_bootstrap || fail 'PUBLIC lifecycle audit table grant recovery'
ok 'PUBLIC lifecycle audit table privilege drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT UPDATE (action_type) ON plan_audit_events TO PUBLIC; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'PUBLIC lifecycle audit column grant rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE UPDATE (action_type) ON plan_audit_events FROM PUBLIC; RESET ROLE'
run_bootstrap || fail 'PUBLIC lifecycle audit column grant recovery'
ok 'PUBLIC lifecycle audit column privilege drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT DELETE ON plan_audit_events TO falcone_app; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'other C-25 group lifecycle audit table grant rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE DELETE ON plan_audit_events FROM falcone_app; RESET ROLE'
run_bootstrap || fail 'other C-25 group lifecycle audit table grant recovery'
ok 'other C-25 group lifecycle audit table privilege drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT UPDATE (action_type) ON plan_audit_events TO falcone_webhook_key_writer; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'other C-25 group lifecycle audit column grant rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE UPDATE (action_type) ON plan_audit_events FROM falcone_webhook_key_writer; RESET ROLE'
run_bootstrap || fail 'other C-25 group lifecycle audit column grant recovery'
ok 'other C-25 group lifecycle audit column privilege drift fails closed'

admin_sql c25_legacy \
  'SET ROLE falcone; GRANT SELECT ON plan_audit_events TO falcone_webhook_key_lifecycle WITH GRANT OPTION; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'lifecycle audit grant option rejection'
admin_sql c25_legacy \
  'SET ROLE falcone; REVOKE GRANT OPTION FOR SELECT ON plan_audit_events FROM falcone_webhook_key_lifecycle; RESET ROLE'
run_bootstrap || fail 'lifecycle audit grant option recovery'
ok 'lifecycle audit WITH GRANT OPTION drift fails closed'

admin_sql c25_legacy \
  'CREATE ROLE c25_audit_alternate_grantor NOLOGIN; SET ROLE falcone; GRANT SELECT ON plan_audit_events TO c25_audit_alternate_grantor WITH GRANT OPTION; RESET ROLE; SET ROLE c25_audit_alternate_grantor; GRANT SELECT ON plan_audit_events TO falcone_webhook_key_lifecycle; RESET ROLE'
reject_bootstrap_code WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT \
  || fail 'lifecycle audit alternate grantor rejection'
admin_sql c25_legacy \
  'SET ROLE c25_audit_alternate_grantor; REVOKE SELECT ON plan_audit_events FROM falcone_webhook_key_lifecycle; RESET ROLE; SET ROLE falcone; REVOKE SELECT ON plan_audit_events FROM c25_audit_alternate_grantor; RESET ROLE; DROP ROLE c25_audit_alternate_grantor'
run_bootstrap || fail 'lifecycle audit alternate grantor recovery'
ok 'lifecycle audit alternate-grantor provenance drift fails closed'

bounded_sql \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  c25_legacy \
  'CREATE TABLE c25_schema_owner_excess (id integer)'
reject_bootstrap_code WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT \
  || fail 'schema owner scope drift rejection'
admin_sql c25_legacy 'DROP TABLE c25_schema_owner_excess'
run_bootstrap || fail 'schema owner scope drift recovery'
ok 'schema owner is rejected for non-enumerated objects'

bounded_sql \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  c25_legacy \
  "CREATE TYPE c25_schema_owner_enum AS ENUM ('bounded')"
owner_graph_before="$(
  query c25_legacy "
    SELECT
      (SELECT count(*) FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid=membership.member
        WHERE member.rolname IN (
          'falcone_webhook_runtime','falcone_webhook_writer',
          'falcone_webhook_lifecycle_login'
        )) || ':' ||
      (SELECT pg_get_userbyid(relowner)
         FROM pg_class
        WHERE oid='public.webhook_subscriptions'::regclass)"
)"
reject_bootstrap_code WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT \
  || fail 'schema-owned enum drift rejection'
[ "$(query c25_legacy "SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typname='c25_schema_owner_enum'")" = 'falcone_webhook_schema' ] \
  || fail 'enum owner drift transaction preservation'
[ "$(query c25_legacy "
    SELECT
      (SELECT count(*) FROM pg_auth_members membership
        JOIN pg_roles member ON member.oid=membership.member
        WHERE member.rolname IN (
          'falcone_webhook_runtime','falcone_webhook_writer',
          'falcone_webhook_lifecycle_login'
        )) || ':' ||
      (SELECT pg_get_userbyid(relowner)
         FROM pg_class
        WHERE oid='public.webhook_subscriptions'::regclass)")" = "$owner_graph_before" ] \
  || fail 'enum failure preserves graph and relation ownership'
admin_sql c25_legacy 'DROP TYPE c25_schema_owner_enum'
run_bootstrap || fail 'enum owner drift recovery'
ok 'schema-owned enum fails closed and preserves state'

bounded_sql \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  c25_legacy \
  'CREATE DOMAIN c25_schema_owner_domain AS text CHECK (VALUE <> $$forbidden$$)'
reject_bootstrap || fail 'schema-owned domain drift rejection'
[ "$(query c25_legacy "SELECT pg_get_userbyid(typowner) FROM pg_type WHERE typname='c25_schema_owner_domain'")" = 'falcone_webhook_schema' ] \
  || fail 'domain owner drift transaction preservation'
admin_sql c25_legacy 'DROP DOMAIN c25_schema_owner_domain'
run_bootstrap || fail 'domain owner drift recovery'
ok 'schema-owned domain is rejected as an independent object kind'

bounded_sql \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_PASSWORD" \
  c25_legacy \
  'CREATE SEQUENCE webhook_deliveries_id_seq'
reject_bootstrap || fail 'schema-owned old assumed sequence rejection'
[ "$(query c25_legacy "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.webhook_deliveries_id_seq'::regclass")" = 'falcone_webhook_schema' ] \
  || fail 'schema-owned sequence drift transaction preservation'
admin_sql c25_legacy 'DROP SEQUENCE webhook_deliveries_id_seq'
run_bootstrap || fail 'schema-owned sequence drift recovery'
ok 'schema-owned sequence fails scope while legacy sequence stays untouched'

admin_sql c25_legacy 'ALTER ROLE falcone_webhook_runtime SUPERUSER'
reject_bootstrap_code WEBHOOK_DATABASE_ROLE_OPTION_DRIFT \
  || fail 'role option drift rejection'
admin_sql c25_legacy 'ALTER ROLE falcone_webhook_runtime NOSUPERUSER'
run_bootstrap || fail 'role option drift recovery'
ok 'role option drift fails closed without blocking corrected replay'

admin_sql c25_legacy 'ALTER ROLE falcone_webhook_writer INHERIT'
reject_bootstrap || fail 'role inheritance drift rejection'
admin_sql c25_legacy 'ALTER ROLE falcone_webhook_writer NOINHERIT'
run_bootstrap || fail 'role inheritance drift recovery'
ok 'role inheritance drift fails closed'

admin_sql c25_legacy 'REVOKE falcone_app FROM falcone_webhook_runtime; GRANT falcone_app TO falcone_webhook_runtime WITH ADMIN FALSE, INHERIT FALSE, SET FALSE'
reject_bootstrap_code WEBHOOK_DATABASE_MEMBERSHIP_DRIFT \
  || fail 'membership option drift rejection'
admin_sql c25_legacy 'REVOKE falcone_app FROM falcone_webhook_runtime'
run_bootstrap || fail 'membership option drift recovery'
ok 'membership option drift fails closed'

admin_sql c25_legacy 'REVOKE falcone_app FROM falcone_webhook_runtime; CREATE ROLE c25_foreign_grantor LOGIN; GRANT falcone_app TO c25_foreign_grantor WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; GRANT falcone_app TO falcone_webhook_runtime WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY c25_foreign_grantor'
reject_bootstrap || fail 'foreign grantor rejection'
admin_sql c25_legacy 'REVOKE falcone_app FROM falcone_webhook_runtime GRANTED BY c25_foreign_grantor; REVOKE falcone_app FROM c25_foreign_grantor; DROP ROLE c25_foreign_grantor'
run_bootstrap || fail 'foreign grantor recovery'
ok 'foreign grantor provenance fails closed'

admin_sql c25_legacy 'CREATE ROLE c25_foreign_owner NOLOGIN; ALTER TABLE webhook_subscriptions OWNER TO c25_foreign_owner'
reject_bootstrap_code WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT \
  || fail 'foreign owner rejection'
[ "$(query c25_legacy "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.webhook_subscriptions'::regclass")" = 'c25_foreign_owner' ] \
  || fail 'owner drift transaction preservation'
admin_sql c25_legacy 'ALTER TABLE webhook_subscriptions OWNER TO falcone; DROP ROLE c25_foreign_owner'
run_bootstrap || fail 'owner drift recovery'
ok 'owner drift is rejected and preserves state until corrected'

admin_sql c25_legacy 'GRANT falcone_webhook_key_writer TO falcone'
admin_sql c25_legacy \
  'CREATE FUNCTION c25_token_bait() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING MESSAGE = $bait$unrecognized PostgreSQL failure containing WEBHOOK_DATABASE_ROLE_OPTION_DRIFT as token bait$bait$; END $$; CREATE EVENT TRIGGER c25_token_bait ON ddl_command_start EXECUTE FUNCTION c25_token_bait()'
token_bait_state_before="$(
  query c25_legacy "
    SELECT
      (SELECT count(*)
         FROM pg_auth_members membership
         JOIN pg_roles granted ON granted.oid=membership.roleid
         JOIN pg_roles member ON member.oid=membership.member
        WHERE granted.rolname IN (
          'falcone_app','falcone_webhook_key_writer',
          'falcone_webhook_key_lifecycle'
        )
          AND member.rolname IN (
            'falcone','falcone_webhook_runtime','falcone_webhook_writer',
            'falcone_webhook_lifecycle_login'
          )) || ':' ||
      (SELECT pg_get_userbyid(relowner)
         FROM pg_class
        WHERE oid='public.webhook_subscriptions'::regclass) || ':' ||
      (SELECT count(*)
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) privilege
         JOIN pg_roles grantee ON grantee.oid=privilege.grantee
        WHERE namespace.nspname='public'
          AND grantee.rolname='falcone_webhook_schema')"
)"
[ "$(invoke_bootstrap_bounded_tmp_failure)" = WEBHOOK_DATABASE_BOOTSTRAP_FAILED ] \
  || fail 'unrecognized PostgreSQL token bait uses generic classification'
[ "$(query c25_legacy "
    SELECT
      (SELECT count(*)
         FROM pg_auth_members membership
         JOIN pg_roles granted ON granted.oid=membership.roleid
         JOIN pg_roles member ON member.oid=membership.member
        WHERE granted.rolname IN (
          'falcone_app','falcone_webhook_key_writer',
          'falcone_webhook_key_lifecycle'
        )
          AND member.rolname IN (
            'falcone','falcone_webhook_runtime','falcone_webhook_writer',
            'falcone_webhook_lifecycle_login'
          )) || ':' ||
      (SELECT pg_get_userbyid(relowner)
         FROM pg_class
        WHERE oid='public.webhook_subscriptions'::regclass) || ':' ||
      (SELECT count(*)
         FROM pg_namespace namespace
         CROSS JOIN LATERAL aclexplode(
           COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
         ) privilege
         JOIN pg_roles grantee ON grantee.oid=privilege.grantee
        WHERE namespace.nspname='public'
          AND grantee.rolname='falcone_webhook_schema')")" = "$token_bait_state_before" ] \
  || fail 'token bait failure preserves authority state'
admin_sql c25_legacy \
  'DROP EVENT TRIGGER c25_token_bait; DROP FUNCTION c25_token_bait()'
ok 'unrecognized token-bait failure is generic, rollback-safe, and scratch-free'

run_bootstrap || fail 'approved implicit legacy membership repair'
implicit_count="$(
  query c25_legacy "
    SELECT count(*)
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid=membership.roleid
    JOIN pg_roles member ON member.oid=membership.member
    WHERE granted.rolname='falcone_webhook_key_writer'
      AND member.rolname='falcone'"
)"
[ "$implicit_count" = "0" ] || fail 'approved implicit legacy membership removal'
ok 'approved administrator-attributable legacy membership is repaired'

# PostgreSQL 15 is an explicit fail-closed boundary. The unsupported server has
# an independent runtime-only fixture and is removed by the same trap.
export POSTGRES_PASSWORD="$PGPASSWORD"
docker run -d \
  --name "$unsupported_container" \
  --network "$network" \
  --label falcone.c25.task=webhook-database-bootstrap-test \
  -e POSTGRES_PASSWORD \
  "$unsupported_image" >/dev/null
unset POSTGRES_PASSWORD
docker exec "$unsupported_container" sh -ec \
  'for i in $(seq 1 90); do
     if pg_isready -U postgres >/dev/null 2>&1; then
       sleep 2
       pg_isready -U postgres >/dev/null 2>&1 && exit 0
     fi
     sleep 1
   done
   exit 1'
docker exec "$unsupported_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE falcone LOGIN CREATEDB'
docker exec "$unsupported_container" psql -X -q -U postgres -v ON_ERROR_STOP=1 \
  -c 'CREATE DATABASE c25_unsupported OWNER falcone'
export PGHOST="$unsupported_container"
export PGDATABASE=c25_unsupported
set_urls
if docker run --rm -i \
  --network "$network" \
  --label falcone.c25.task=webhook-database-bootstrap-test \
  -e PGHOST -e PGPORT -e PGDATABASE -e PGUSER -e PGPASSWORD \
  -e GLOBAL_DATABASE_ROLE \
  -e WEBHOOK_SCHEMA_DATABASE_ROLE \
  -e WEBHOOK_RUNTIME_DATABASE_ROLE \
  -e WEBHOOK_KEY_WRITE_DATABASE_ROLE \
  -e WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE \
  -e WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE \
  -e WEBHOOK_SCHEMA_DATABASE_PASSWORD \
  -e WEBHOOK_RUNTIME_DATABASE_PASSWORD \
  -e WEBHOOK_KEY_WRITE_DATABASE_PASSWORD \
  -e WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD \
  -e WEBHOOK_SCHEMA_DATABASE_URL \
  -e WEBHOOK_RUNTIME_DATABASE_URL \
  -e WEBHOOK_KEY_WRITE_DATABASE_URL \
  -e WEBHOOK_KEY_LIFECYCLE_DATABASE_URL \
  -e WEBHOOK_DATABASE_BOOTSTRAP_MODE \
  "$client_image" sh -s <"$bootstrap_script" >/dev/null 2>&1
then
  fail 'unsupported PostgreSQL version rejection'
fi
ok 'unsupported PostgreSQL 15 fails closed'

printf '1..%s\n' "$passed"
