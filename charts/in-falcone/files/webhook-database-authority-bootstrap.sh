#!/bin/sh
#
# PostgreSQL 16 one-shot authority bootstrap for C-25. The administrator
# password and bounded passwords arrive only through Secret-backed environment
# variables. psql receives them through its environment/stdin, never argv.

set -eu
umask 077

bootstrap_mode="${WEBHOOK_DATABASE_BOOTSTRAP_MODE:-verify}"
case "$bootstrap_mode" in
  apply) export WEBHOOK_DATABASE_BOOTSTRAP_APPLY=true ;;
  verify) export WEBHOOK_DATABASE_BOOTSTRAP_APPLY=false ;;
  *) printf '%s\n' 'WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID' >&2; exit 1 ;;
esac

fail() {
  printf '%s\n' "${1:-WEBHOOK_DATABASE_BOOTSTRAP_FAILED}" >&2
  exit 1
}

required() {
  eval "required_value=\${$1:-}"
  [ -n "$required_value" ] || fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID
}

for required_name in \
  PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD GLOBAL_DATABASE_ROLE \
  WEBHOOK_SCHEMA_DATABASE_ROLE WEBHOOK_RUNTIME_DATABASE_ROLE \
  WEBHOOK_KEY_WRITE_DATABASE_ROLE WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE \
  WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE \
  WEBHOOK_SCHEMA_DATABASE_PASSWORD WEBHOOK_RUNTIME_DATABASE_PASSWORD \
  WEBHOOK_KEY_WRITE_DATABASE_PASSWORD \
  WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD \
  WEBHOOK_SCHEMA_DATABASE_URL WEBHOOK_RUNTIME_DATABASE_URL \
  WEBHOOK_KEY_WRITE_DATABASE_URL WEBHOOK_KEY_LIFECYCLE_DATABASE_URL
do
  required "$required_name"
done

case "$PGPORT" in
  *[!0-9]*|'') fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID ;;
esac

for role_name in \
  "$PGUSER" "$GLOBAL_DATABASE_ROLE" \
  "$WEBHOOK_SCHEMA_DATABASE_ROLE" "$WEBHOOK_RUNTIME_DATABASE_ROLE" \
  "$WEBHOOK_KEY_WRITE_DATABASE_ROLE" "$WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE" \
  "$WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE"
do
  case "$role_name" in
    [A-Za-z_]*)
      case "$role_name" in *[!A-Za-z0-9_$-]*) fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID ;; esac
      [ "${#role_name}" -le 63 ] || fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID
      ;;
    *) fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID ;;
  esac
done

protected_roles="
$PGUSER
$GLOBAL_DATABASE_ROLE
$WEBHOOK_SCHEMA_DATABASE_ROLE
$WEBHOOK_RUNTIME_DATABASE_ROLE
$WEBHOOK_KEY_WRITE_DATABASE_ROLE
$WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE
$WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE
falcone_app
falcone_webhook_key_writer
falcone_webhook_key_lifecycle
"
[ "$(printf '%s' "$protected_roles" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" = "9" ] \
  || fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID
[ "$PGUSER" = "$WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE" ] \
  || fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID

passwords="
$WEBHOOK_SCHEMA_DATABASE_PASSWORD
$WEBHOOK_RUNTIME_DATABASE_PASSWORD
$WEBHOOK_KEY_WRITE_DATABASE_PASSWORD
$WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD
"
[ "$(printf '%s' "$passwords" | sed '/^$/d' | sort -u | wc -l | tr -d ' ')" = "4" ] \
  || fail WEBHOOK_DATABASE_BOOTSTRAP_INPUT_INVALID

attempt=0
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 120 ] || fail WEBHOOK_DATABASE_UNAVAILABLE
  sleep 2
done

server_supported="$(
  psql -X -qAt --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse \
    -c "SELECT CASE WHEN current_setting('server_version_num')::integer >= 160000 THEN 'yes' ELSE 'no' END" \
    2>/dev/null
)" || fail WEBHOOK_DATABASE_BOOTSTRAP_FAILED
[ "$server_supported" = "yes" ] || fail WEBHOOK_POSTGRESQL_16_REQUIRED

probe_login() {
  expected_role="$1"
  expected_password="$2"
  authenticated="$(
    (
      export PGUSER="$expected_role"
      export PGPASSWORD="$expected_password"
      psql -X -qAt --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse \
        -c 'SELECT CASE WHEN session_user = current_user THEN session_user ELSE NULL END'
    ) 2>/dev/null
  )" || fail WEBHOOK_DATABASE_BOUNDED_CREDENTIAL_INVALID
  [ "$authenticated" = "$expected_role" ] \
    || fail WEBHOOK_DATABASE_BOUNDED_CREDENTIAL_INVALID
}

role_exists() {
  expected_role="$1"
  role_state="$(
    (
      export WEBHOOK_DATABASE_ROLE_TO_PROBE="$expected_role"
      psql -X -qAt --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse 2>/dev/null <<'SQL'
\getenv expected_role WEBHOOK_DATABASE_ROLE_TO_PROBE
SELECT CASE
  WHEN EXISTS (SELECT FROM pg_roles WHERE rolname = :'expected_role')
  THEN 'exists'
  ELSE 'missing'
END;
SQL
    )
  )" || fail WEBHOOK_DATABASE_BOOTSTRAP_FAILED
  [ "$role_state" = "exists" ]
}

# A pre-existing bounded role is never taken over. Prove every retained
# credential through a separate password-authenticated client session before
# entering the transaction that can create roles, change memberships, grant
# schema privileges, or transfer ownership. Missing roles remain eligible for
# transactional creation with the retained credential.
if role_exists "$WEBHOOK_SCHEMA_DATABASE_ROLE"; then
  probe_login \
    "$WEBHOOK_SCHEMA_DATABASE_ROLE" "$WEBHOOK_SCHEMA_DATABASE_PASSWORD"
fi
if role_exists "$WEBHOOK_RUNTIME_DATABASE_ROLE"; then
  probe_login \
    "$WEBHOOK_RUNTIME_DATABASE_ROLE" "$WEBHOOK_RUNTIME_DATABASE_PASSWORD"
fi
if role_exists "$WEBHOOK_KEY_WRITE_DATABASE_ROLE"; then
  probe_login \
    "$WEBHOOK_KEY_WRITE_DATABASE_ROLE" "$WEBHOOK_KEY_WRITE_DATABASE_PASSWORD"
fi
if role_exists "$WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE"; then
  probe_login \
    "$WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE" \
    "$WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD"
fi

sql_error_file="$(mktemp /tmp/webhook-db-authority.XXXXXX)" \
  || fail WEBHOOK_DATABASE_BOOTSTRAP_FAILED
trap 'rm -f "$sql_error_file"' EXIT HUP INT TERM

if ! psql -X -q --set=ON_ERROR_STOP=1 --set=VERBOSITY=verbose \
  >/dev/null 2>"$sql_error_file" <<'SQL'
\getenv admin_role PGUSER
\getenv global_role GLOBAL_DATABASE_ROLE
\getenv schema_role WEBHOOK_SCHEMA_DATABASE_ROLE
\getenv runtime_role WEBHOOK_RUNTIME_DATABASE_ROLE
\getenv writer_role WEBHOOK_KEY_WRITE_DATABASE_ROLE
\getenv lifecycle_role WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE
\getenv grantor_role WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE
\getenv schema_password WEBHOOK_SCHEMA_DATABASE_PASSWORD
\getenv runtime_password WEBHOOK_RUNTIME_DATABASE_PASSWORD
\getenv writer_password WEBHOOK_KEY_WRITE_DATABASE_PASSWORD
\getenv lifecycle_password WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD
\getenv apply_mode WEBHOOK_DATABASE_BOOTSTRAP_APPLY

BEGIN;
SELECT pg_advisory_xact_lock(723661, 16);
SELECT set_config('falcone.bootstrap.admin_role', :'admin_role', true);
SELECT set_config('falcone.bootstrap.global_role', :'global_role', true);
SELECT set_config('falcone.bootstrap.schema_role', :'schema_role', true);
SELECT set_config('falcone.bootstrap.runtime_role', :'runtime_role', true);
SELECT set_config('falcone.bootstrap.writer_role', :'writer_role', true);
SELECT set_config('falcone.bootstrap.lifecycle_role', :'lifecycle_role', true);
SELECT set_config('falcone.bootstrap.grantor_role', :'grantor_role', true);

DO $bootstrap$
BEGIN
  IF current_setting('server_version_num')::integer < 160000 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2501',
      MESSAGE = 'WEBHOOK_POSTGRESQL_16_REQUIRED';
  END IF;
END
$bootstrap$;

CREATE TEMP TABLE bootstrap_expected_roles (
  role_name name PRIMARY KEY,
  can_login boolean NOT NULL,
  is_super boolean NOT NULL,
  inherit_role boolean NOT NULL
) ON COMMIT DROP;
INSERT INTO bootstrap_expected_roles VALUES
  (:'schema_role', true, false, false),
  (:'runtime_role', true, false, true),
  (:'writer_role', true, false, false),
  (:'lifecycle_role', true, false, false),
  ('falcone_app', false, false, false),
  ('falcone_webhook_key_writer', false, false, false),
  ('falcone_webhook_key_lifecycle', false, false, false);

SELECT format(
         'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE %s NOREPLICATION NOBYPASSRLS PASSWORD %L',
         :'schema_role',
         'NOINHERIT',
         :'schema_password'
       )
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'schema_role')
\gexec
SELECT format(
         'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE %s NOREPLICATION NOBYPASSRLS PASSWORD %L',
         :'runtime_role',
         'INHERIT',
         :'runtime_password'
       )
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'runtime_role')
\gexec
SELECT format(
         'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE %s NOREPLICATION NOBYPASSRLS PASSWORD %L',
         :'writer_role',
         'NOINHERIT',
         :'writer_password'
       )
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'writer_role')
\gexec
SELECT format(
         'CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE %s NOREPLICATION NOBYPASSRLS PASSWORD %L',
         :'lifecycle_role',
         'NOINHERIT',
         :'lifecycle_password'
       )
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'lifecycle_role')
\gexec
SELECT format(
         'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
         role_name
       )
  FROM bootstrap_expected_roles
 WHERE NOT can_login
   AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name)
\gexec

DO $bootstrap$
DECLARE
  invalid_count integer;
BEGIN
  SELECT count(*)
    INTO invalid_count
    FROM bootstrap_expected_roles expected
    LEFT JOIN pg_roles actual ON actual.rolname = expected.role_name
  WHERE actual.oid IS NULL
      OR actual.rolcanlogin <> expected.can_login
      OR actual.rolsuper <> expected.is_super
      OR actual.rolinherit <> expected.inherit_role
      OR actual.rolcreatedb
      OR actual.rolcreaterole
      OR actual.rolreplication
      OR actual.rolbypassrls;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2502',
      MESSAGE = 'WEBHOOK_DATABASE_ROLE_OPTION_DRIFT';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_roles
     WHERE rolname = current_user
       AND rolname = current_setting('falcone.bootstrap.admin_role')::name
       AND rolcanlogin
       AND rolsuper
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2503',
      MESSAGE = 'WEBHOOK_DATABASE_ADMIN_INVALID';
  END IF;
END
$bootstrap$;

-- The schema LOGIN is the only bounded principal permitted to create webhook
-- objects. PostgreSQL 15+ no longer grants CREATE on public to PUBLIC, so the
-- fresh-install application migration needs this explicit, provenance-checked
-- schema ACL. It does not transfer schema/database ownership or establish
-- default privileges.
DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) privilege
      JOIN pg_roles grantee ON grantee.oid = privilege.grantee
     WHERE namespace.nspname = 'public'
       AND grantee.rolname = current_setting('falcone.bootstrap.schema_role')::name
       AND privilege.grantor <> namespace.nspowner
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2504',
      MESSAGE = 'WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_GRANTOR_DRIFT';
  END IF;
END
$bootstrap$;

SELECT format(
         'GRANT USAGE, CREATE ON SCHEMA public TO %I GRANTED BY %I',
         :'schema_role',
         :'admin_role'
       )
\gexec

DO $bootstrap$
BEGIN
  IF (
    SELECT count(*)
      FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) privilege
      JOIN pg_roles grantee ON grantee.oid = privilege.grantee
     WHERE namespace.nspname = 'public'
       AND grantee.rolname = current_setting('falcone.bootstrap.schema_role')::name
       AND privilege.grantor = namespace.nspowner
       AND privilege.privilege_type IN ('USAGE', 'CREATE')
  ) <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2505',
      MESSAGE = 'WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_DRIFT';
  END IF;
END
$bootstrap$;

CREATE TEMP TABLE bootstrap_expected_memberships (
  granted_role name NOT NULL,
  member_role name NOT NULL,
  admin_option boolean NOT NULL,
  inherit_option boolean NOT NULL,
  set_option boolean NOT NULL,
  PRIMARY KEY (granted_role, member_role)
) ON COMMIT DROP;
INSERT INTO bootstrap_expected_memberships VALUES
  ('falcone_app', :'runtime_role', false, true, false),
  ('falcone_webhook_key_writer', :'writer_role', false, false, true),
  ('falcone_webhook_key_lifecycle', :'lifecycle_role', false, false, true);

CREATE TEMP TABLE bootstrap_memberships AS
SELECT granted.rolname AS granted_role,
       member.rolname AS member_role,
       grantor.rolname AS grantor_role,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
 WHERE granted.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       )
    OR member.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       );

DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT granted_role, member_role
     FROM bootstrap_memberships
     GROUP BY granted_role, member_role
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2506',
      MESSAGE = 'WEBHOOK_DATABASE_MEMBERSHIP_AMBIGUOUS';
  END IF;
END
$bootstrap$;

-- Repair only implicit legacy memberships safely attributable to the current
-- administrator. Desired-edge option/provenance drift remains fail-closed.
SELECT format(
         'REVOKE %I FROM %I GRANTED BY %I',
         actual.granted_role,
         actual.member_role,
         :'admin_role'
       )
  FROM bootstrap_memberships actual
  LEFT JOIN bootstrap_expected_memberships expected
    ON expected.granted_role = actual.granted_role
   AND expected.member_role = actual.member_role
 WHERE actual.grantor_role = :'admin_role'
   AND expected.granted_role IS NULL
   AND (
     actual.granted_role IN (
       'falcone_app',
       'falcone_webhook_key_writer',
       'falcone_webhook_key_lifecycle'
     )
     AND actual.member_role IN (:'admin_role', :'global_role')
   )
\gexec

TRUNCATE bootstrap_memberships;
INSERT INTO bootstrap_memberships
SELECT granted.rolname,
       member.rolname,
       grantor.rolname,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
 WHERE granted.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       )
    OR member.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       );

DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM bootstrap_memberships actual
      LEFT JOIN bootstrap_expected_memberships expected
        ON expected.granted_role = actual.granted_role
       AND expected.member_role = actual.member_role
     WHERE expected.granted_role IS NULL
        OR actual.grantor_role
             <> current_setting('falcone.bootstrap.grantor_role')::name
        OR actual.admin_option <> expected.admin_option
        OR actual.inherit_option <> expected.inherit_option
        OR actual.set_option <> expected.set_option
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2507',
      MESSAGE = 'WEBHOOK_DATABASE_MEMBERSHIP_DRIFT';
  END IF;
END
$bootstrap$;

SELECT format(
         'GRANT %I TO %I WITH ADMIN %s, INHERIT %s, SET %s GRANTED BY %I',
         expected.granted_role,
         expected.member_role,
         CASE WHEN expected.admin_option THEN 'TRUE' ELSE 'FALSE' END,
         CASE WHEN expected.inherit_option THEN 'TRUE' ELSE 'FALSE' END,
         CASE WHEN expected.set_option THEN 'TRUE' ELSE 'FALSE' END,
         :'grantor_role'
       )
  FROM bootstrap_expected_memberships expected
 WHERE NOT EXISTS (
         SELECT 1
           FROM bootstrap_memberships actual
          WHERE actual.granted_role = expected.granted_role
            AND actual.member_role = expected.member_role
       )
\gexec

-- The lifecycle hook runs before the new control-plane Deployment. On an
-- upgrade, the separately owned platform audit table therefore has to be
-- reachable before application startup can reconcile the same grant. Keep the
-- boundary exact: the global role must remain the owner, the lifecycle
-- NOLOGIN receives only SELECT/INSERT, and no C-25 login/group or PUBLIC may
-- carry a column grant or an alternate table privilege.
DO $bootstrap$
DECLARE
  audit_table oid := to_regclass('public.plan_audit_events');
  allowed_count integer;
BEGIN
  IF audit_table IS NULL THEN
    RETURN;
  END IF;

  IF (
    SELECT pg_get_userbyid(class.relowner)
      FROM pg_class class
     WHERE class.oid = audit_table
       AND class.relkind = 'r'
  ) IS DISTINCT FROM current_setting('falcone.bootstrap.global_role')::name THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2510',
      MESSAGE = 'WEBHOOK_DATABASE_AUDIT_OWNER_DRIFT';
  END IF;

  SELECT count(*)
    INTO allowed_count
    FROM pg_class class
    CROSS JOIN LATERAL aclexplode(
      COALESCE(class.relacl, acldefault('r', class.relowner))
    ) privilege
    JOIN pg_roles grantor ON grantor.oid = privilege.grantor
   WHERE class.oid = audit_table
     AND privilege.grantee = (
       SELECT oid FROM pg_roles
        WHERE rolname = 'falcone_webhook_key_lifecycle'
     )
     AND grantor.rolname
           = current_setting('falcone.bootstrap.global_role')::name
     AND privilege.privilege_type IN ('SELECT', 'INSERT')
     AND NOT privilege.is_grantable;

  IF allowed_count NOT IN (0, 2)
     OR EXISTS (
       SELECT 1
         FROM pg_class class
         CROSS JOIN LATERAL aclexplode(
           COALESCE(class.relacl, acldefault('r', class.relowner))
         ) privilege
         LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
         JOIN pg_roles grantor ON grantor.oid = privilege.grantor
        WHERE class.oid = audit_table
          AND (
            privilege.grantee = 0
            OR grantee.rolname IN (
              current_setting('falcone.bootstrap.schema_role')::name,
              current_setting('falcone.bootstrap.runtime_role')::name,
              current_setting('falcone.bootstrap.writer_role')::name,
              current_setting('falcone.bootstrap.lifecycle_role')::name,
              'falcone_app',
              'falcone_webhook_key_writer',
              'falcone_webhook_key_lifecycle'
            )
          )
          AND NOT (
            grantee.rolname = 'falcone_webhook_key_lifecycle'
            AND grantor.rolname
                  = current_setting('falcone.bootstrap.global_role')::name
            AND privilege.privilege_type IN ('SELECT', 'INSERT')
            AND NOT privilege.is_grantable
          )
     )
     OR EXISTS (
       SELECT 1
         FROM pg_attribute attribute
         CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
         LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
        WHERE attribute.attrelid = audit_table
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND (
            privilege.grantee = 0
            OR grantee.rolname IN (
              current_setting('falcone.bootstrap.schema_role')::name,
              current_setting('falcone.bootstrap.runtime_role')::name,
              current_setting('falcone.bootstrap.writer_role')::name,
              current_setting('falcone.bootstrap.lifecycle_role')::name,
              'falcone_app',
              'falcone_webhook_key_writer',
              'falcone_webhook_key_lifecycle'
            )
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2511',
      MESSAGE = 'WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT';
  END IF;
END
$bootstrap$;

SELECT format(
         'SET LOCAL ROLE %I',
         :'global_role'
       )
 WHERE to_regclass('public.plan_audit_events') IS NOT NULL
   AND NOT has_table_privilege(
     'falcone_webhook_key_lifecycle',
     to_regclass('public.plan_audit_events'),
     'SELECT,INSERT'
   )
\gexec
SELECT
  'GRANT SELECT, INSERT ON TABLE public.plan_audit_events'
  ' TO falcone_webhook_key_lifecycle'
 WHERE to_regclass('public.plan_audit_events') IS NOT NULL
   AND current_user = :'global_role'
\gexec
RESET ROLE;

DO $bootstrap$
BEGIN
  IF to_regclass('public.plan_audit_events') IS NOT NULL
     AND (
       SELECT count(*)
         FROM pg_class class
         CROSS JOIN LATERAL aclexplode(
           COALESCE(class.relacl, acldefault('r', class.relowner))
         ) privilege
         JOIN pg_roles grantee ON grantee.oid = privilege.grantee
         JOIN pg_roles grantor ON grantor.oid = privilege.grantor
        WHERE class.oid = to_regclass('public.plan_audit_events')
          AND grantee.rolname = 'falcone_webhook_key_lifecycle'
          AND grantor.rolname
                = current_setting('falcone.bootstrap.global_role')::name
          AND privilege.privilege_type IN ('SELECT', 'INSERT')
          AND NOT privilege.is_grantable
     ) <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2511',
      MESSAGE = 'WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT';
  END IF;
END
$bootstrap$;

CREATE TEMP TABLE bootstrap_objects (
  object_kind text NOT NULL,
  object_name name NOT NULL,
  PRIMARY KEY (object_kind, object_name)
) ON COMMIT DROP;
INSERT INTO bootstrap_objects VALUES
  ('table', 'webhook_subscriptions'),
  ('table', 'webhook_signing_secrets'),
  ('table', 'webhook_deliveries'),
  ('table', 'webhook_delivery_attempts'),
  ('table', 'webhook_master_key_state'),
  ('table', 'webhook_master_key_rotations'),
  ('function', 'falcone_webhook_key_write_current_id'),
  ('function', 'falcone_webhook_signing_secret_write_statement_fence'),
  ('function', 'falcone_webhook_signing_secret_write_fence');

DO $bootstrap$
DECLARE
  object_record record;
  owner_name name;
BEGIN
  FOR object_record IN
    SELECT object_kind, object_name FROM bootstrap_objects ORDER BY object_kind, object_name
  LOOP
    IF object_record.object_kind = 'table' THEN
      SELECT pg_get_userbyid(class.relowner)
        INTO owner_name
        FROM pg_class class
        JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
       WHERE namespace.nspname = 'public'
         AND class.relname = object_record.object_name
         AND class.relkind = 'r';
      IF owner_name IS NULL THEN
        CONTINUE;
      ELSIF owner_name = current_setting('falcone.bootstrap.global_role')::name THEN
        EXECUTE format(
          'ALTER %s public.%I OWNER TO %I',
          upper(object_record.object_kind),
          object_record.object_name,
          current_setting('falcone.bootstrap.schema_role')::name
        );
      ELSIF owner_name <> current_setting('falcone.bootstrap.schema_role')::name THEN
        RAISE EXCEPTION USING
          ERRCODE = 'F2508',
          MESSAGE = 'WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT';
      END IF;
    ELSE
      SELECT pg_get_userbyid(procedure.proowner)
        INTO owner_name
        FROM pg_proc procedure
        JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'public'
         AND procedure.proname = object_record.object_name
         AND procedure.pronargs = 0
         AND procedure.prokind = 'f';
      IF owner_name IS NULL THEN
        CONTINUE;
      ELSIF owner_name = current_setting('falcone.bootstrap.global_role')::name THEN
        EXECUTE format(
          'ALTER FUNCTION public.%I() OWNER TO %I',
          object_record.object_name,
          current_setting('falcone.bootstrap.schema_role')::name
        );
      ELSIF owner_name <> current_setting('falcone.bootstrap.schema_role')::name THEN
        RAISE EXCEPTION USING
          ERRCODE = 'F2508',
          MESSAGE = 'WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT';
      END IF;
    END IF;
  END LOOP;
END
$bootstrap$;

-- Inventory every object for which PostgreSQL records an ownership dependency
-- on the bounded schema LOGIN. The only roots are the six contract tables and
-- three zero-argument functions. PostgreSQL-internal relation ownership also
-- appears on row/array types, indexes, and TOAST relations; identify those by
-- catalog identity instead of allowing a user-creatable object kind broadly.
-- In particular, no sequence, enum, domain, range, standalone composite type,
-- view, statistics object, collation, text-search object, schema, or database
-- is an allowed independent ownership root.
CREATE TEMP TABLE bootstrap_allowed_owner_objects (
  database_id oid NOT NULL,
  class_id oid NOT NULL,
  object_id oid NOT NULL,
  object_sub_id integer NOT NULL DEFAULT 0,
  PRIMARY KEY (database_id, class_id, object_id, object_sub_id)
) ON COMMIT DROP;

INSERT INTO bootstrap_allowed_owner_objects (
  database_id, class_id, object_id, object_sub_id
)
SELECT (SELECT oid FROM pg_database WHERE datname = current_database()),
       'pg_class'::regclass,
       class.oid,
       0
  FROM pg_class class
  JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
  JOIN bootstrap_objects expected
    ON expected.object_kind = 'table'
   AND expected.object_name = class.relname
 WHERE namespace.nspname = 'public'
   AND class.relkind = 'r';

INSERT INTO bootstrap_allowed_owner_objects (
  database_id, class_id, object_id, object_sub_id
)
SELECT (SELECT oid FROM pg_database WHERE datname = current_database()),
       'pg_proc'::regclass,
       procedure.oid,
       0
  FROM pg_proc procedure
  JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
  JOIN bootstrap_objects expected
    ON expected.object_kind = 'function'
   AND expected.object_name = procedure.proname
 WHERE namespace.nspname = 'public'
   AND procedure.pronargs = 0
   AND procedure.prokind = 'f';

-- Table row types and their automatically generated array types are internal
-- consequences of the six approved relations, not independent schema roots.
INSERT INTO bootstrap_allowed_owner_objects (
  database_id, class_id, object_id, object_sub_id
)
SELECT (SELECT oid FROM pg_database WHERE datname = current_database()),
       'pg_type'::regclass,
       owned_type.oid,
       0
  FROM pg_class class
  JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
  JOIN bootstrap_objects expected
    ON expected.object_kind = 'table'
   AND expected.object_name = class.relname
  JOIN pg_type row_type ON row_type.oid = class.reltype
  JOIN pg_type owned_type
    ON owned_type.oid IN (row_type.oid, row_type.typarray)
 WHERE namespace.nspname = 'public'
   AND class.relkind = 'r'
ON CONFLICT DO NOTHING;

-- Index and TOAST owners cannot be chosen independently from their table
-- owner. Permit only dependents rooted in one of the six approved tables.
INSERT INTO bootstrap_allowed_owner_objects (
  database_id, class_id, object_id, object_sub_id
)
SELECT (SELECT oid FROM pg_database WHERE datname = current_database()),
       'pg_class'::regclass,
       dependent.object_id,
       0
  FROM (
    SELECT index.indrelid AS table_id, index.indexrelid AS object_id
      FROM pg_index index
    UNION ALL
    SELECT class.oid AS table_id, class.reltoastrelid AS object_id
      FROM pg_class class
     WHERE class.reltoastrelid <> 0
    UNION ALL
    SELECT class.oid AS table_id, toast_index.indexrelid AS object_id
      FROM pg_class class
      JOIN pg_index toast_index ON toast_index.indrelid = class.reltoastrelid
     WHERE class.reltoastrelid <> 0
  ) dependent
  JOIN pg_class class ON class.oid = dependent.table_id
  JOIN pg_namespace namespace ON namespace.oid = class.relnamespace
  JOIN bootstrap_objects expected
    ON expected.object_kind = 'table'
   AND expected.object_name = class.relname
 WHERE namespace.nspname = 'public'
   AND class.relkind = 'r'
ON CONFLICT DO NOTHING;

DO $bootstrap$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_shdepend ownership
      JOIN pg_roles owner_role ON owner_role.oid = ownership.refobjid
      LEFT JOIN bootstrap_allowed_owner_objects allowed
        ON allowed.database_id = ownership.dbid
       AND allowed.class_id = ownership.classid
       AND allowed.object_id = ownership.objid
       AND allowed.object_sub_id = ownership.objsubid
     WHERE ownership.refclassid = 'pg_authid'::regclass
       AND ownership.deptype = 'o'
       AND ownership.dbid IN (
             0,
             (SELECT oid FROM pg_database WHERE datname = current_database())
           )
       AND owner_role.rolname
             = current_setting('falcone.bootstrap.schema_role')::name
       AND allowed.object_id IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2509',
      MESSAGE = 'WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT';
  END IF;
END
$bootstrap$;

-- Final exact inventory: three membership rows, all granted by the durable
-- grantor with their PostgreSQL 16 ADMIN/INHERIT/SET options.
TRUNCATE bootstrap_memberships;
INSERT INTO bootstrap_memberships
SELECT granted.rolname,
       member.rolname,
       grantor.rolname,
       membership.admin_option,
       membership.inherit_option,
       membership.set_option
  FROM pg_auth_members membership
  JOIN pg_roles granted ON granted.oid = membership.roleid
  JOIN pg_roles member ON member.oid = membership.member
  JOIN pg_roles grantor ON grantor.oid = membership.grantor
 WHERE granted.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       )
    OR member.rolname IN (
         :'schema_role', :'runtime_role', :'writer_role', :'lifecycle_role',
         :'grantor_role', 'falcone_app', 'falcone_webhook_key_writer',
         'falcone_webhook_key_lifecycle'
       );

DO $bootstrap$
BEGIN
  IF (SELECT count(*) FROM bootstrap_memberships) <> 3
     OR EXISTS (
       SELECT 1
         FROM bootstrap_memberships actual
         FULL JOIN bootstrap_expected_memberships expected
           ON expected.granted_role = actual.granted_role
          AND expected.member_role = actual.member_role
        WHERE actual.granted_role IS NULL
           OR expected.granted_role IS NULL
           OR actual.grantor_role
                <> current_setting('falcone.bootstrap.grantor_role')::name
           OR actual.admin_option <> expected.admin_option
           OR actual.inherit_option <> expected.inherit_option
           OR actual.set_option <> expected.set_option
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'F2507',
      MESSAGE = 'WEBHOOK_DATABASE_MEMBERSHIP_DRIFT';
  END IF;
END
$bootstrap$;

\if :apply_mode
COMMIT;
\else
ROLLBACK;
\endif
SQL
then
  # psql/server diagnostics remain suppressed. Only errors deliberately raised
  # by this script may cross the process boundary. Each deliberate error has a
  # private SQLSTATE/message pair; arbitrary server text containing one of the
  # stable messages must remain the generic failure.
  bootstrap_failure=WEBHOOK_DATABASE_BOOTSTRAP_FAILED
  while IFS= read -r sql_error_line; do
    case "$sql_error_line" in
      'ERROR:  F2501: WEBHOOK_POSTGRESQL_16_REQUIRED')
        bootstrap_failure=WEBHOOK_POSTGRESQL_16_REQUIRED ;;
      'ERROR:  F2502: WEBHOOK_DATABASE_ROLE_OPTION_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_ROLE_OPTION_DRIFT ;;
      'ERROR:  F2503: WEBHOOK_DATABASE_ADMIN_INVALID')
        bootstrap_failure=WEBHOOK_DATABASE_ADMIN_INVALID ;;
      'ERROR:  F2504: WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_GRANTOR_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_GRANTOR_DRIFT ;;
      'ERROR:  F2505: WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_SCHEMA_PRIVILEGE_DRIFT ;;
      'ERROR:  F2506: WEBHOOK_DATABASE_MEMBERSHIP_AMBIGUOUS')
        bootstrap_failure=WEBHOOK_DATABASE_MEMBERSHIP_AMBIGUOUS ;;
      'ERROR:  F2507: WEBHOOK_DATABASE_MEMBERSHIP_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_MEMBERSHIP_DRIFT ;;
      'ERROR:  F2508: WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_OBJECT_OWNER_DRIFT ;;
      'ERROR:  F2509: WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_SCHEMA_OWNER_SCOPE_DRIFT ;;
      'ERROR:  F2510: WEBHOOK_DATABASE_AUDIT_OWNER_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_AUDIT_OWNER_DRIFT ;;
      'ERROR:  F2511: WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT')
        bootstrap_failure=WEBHOOK_DATABASE_AUDIT_PRIVILEGE_DRIFT ;;
      *) continue ;;
    esac
    break
  done <"$sql_error_file"
  fail "$bootstrap_failure"
fi
rm -f "$sql_error_file"
trap - EXIT HUP INT TERM

if [ "$bootstrap_mode" = "verify" ]; then
  printf '%s\n' 'WEBHOOK_DATABASE_BOOTSTRAP_VERIFIED'
  exit 0
fi

probe_login "$WEBHOOK_SCHEMA_DATABASE_ROLE" "$WEBHOOK_SCHEMA_DATABASE_PASSWORD"
probe_login "$WEBHOOK_RUNTIME_DATABASE_ROLE" "$WEBHOOK_RUNTIME_DATABASE_PASSWORD"
probe_login "$WEBHOOK_KEY_WRITE_DATABASE_ROLE" "$WEBHOOK_KEY_WRITE_DATABASE_PASSWORD"
probe_login "$WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE" "$WEBHOOK_KEY_LIFECYCLE_DATABASE_PASSWORD"

printf '%s\n' 'WEBHOOK_DATABASE_BOOTSTRAP_READY'
