#!/bin/sh
#
# Control-plane init gate. It authenticates only as the bounded schema LOGIN and
# waits until the authority bootstrap has installed the exact PostgreSQL 16 role
# graph. It never receives the global or PostgreSQL administrator credential.

set -eu

fail() {
  printf '%s\n' 'WEBHOOK_DATABASE_PRINCIPAL_GATE_FAILED' >&2
  exit 1
}

for required_name in \
  PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD WEBHOOK_SCHEMA_DATABASE_ROLE \
  WEBHOOK_RUNTIME_DATABASE_ROLE WEBHOOK_KEY_WRITE_DATABASE_ROLE \
  WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE \
  WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE
do
  eval "required_value=\${$required_name:-}"
  [ -n "$required_value" ] || fail
done

attempt=0
while [ "$attempt" -lt 120 ]; do
  attempt=$((attempt + 1))
  result="$(
    psql -X -qAt --set=ON_ERROR_STOP=1 --set=VERBOSITY=terse <<'SQL' 2>/dev/null
\getenv schema_role WEBHOOK_SCHEMA_DATABASE_ROLE
\getenv runtime_role WEBHOOK_RUNTIME_DATABASE_ROLE
\getenv writer_role WEBHOOK_KEY_WRITE_DATABASE_ROLE
\getenv lifecycle_role WEBHOOK_KEY_LIFECYCLE_DATABASE_ROLE
\getenv grantor_role WEBHOOK_DATABASE_AUTHORITY_GRANTOR_ROLE
WITH expected(granted_role, member_role, admin_option, inherit_option, set_option) AS (
  VALUES
    ('falcone_app'::name, :'runtime_role'::name, false, true, false),
    ('falcone_webhook_key_writer'::name, :'writer_role'::name, false, false, true),
    ('falcone_webhook_key_lifecycle'::name, :'lifecycle_role'::name, false, false, true)
),
actual AS (
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
           'falcone_app',
           'falcone_webhook_key_writer',
           'falcone_webhook_key_lifecycle',
           :'schema_role',
           :'runtime_role',
           :'writer_role',
           :'lifecycle_role',
           :'grantor_role'
         )
      OR member.rolname IN (
           'falcone_app',
           'falcone_webhook_key_writer',
           'falcone_webhook_key_lifecycle',
           :'schema_role',
           :'runtime_role',
           :'writer_role',
           :'lifecycle_role',
           :'grantor_role'
         )
),
bounded_roles AS (
  SELECT count(*) AS role_count
    FROM pg_roles
   WHERE rolname IN (
           :'schema_role',
           :'runtime_role',
           :'writer_role',
           :'lifecycle_role'
         )
     AND rolcanlogin
     AND NOT rolsuper
     AND NOT rolcreatedb
     AND NOT rolcreaterole
     AND NOT rolreplication
     AND NOT rolbypassrls
     AND rolinherit = (rolname = :'runtime_role')
),
fixed_roles AS (
  SELECT count(*) AS role_count
    FROM pg_roles
   WHERE rolname IN (
           'falcone_app',
           'falcone_webhook_key_writer',
           'falcone_webhook_key_lifecycle'
         )
     AND NOT rolcanlogin
     AND NOT rolsuper
     AND NOT rolcreatedb
     AND NOT rolcreaterole
     AND NOT rolreplication
     AND NOT rolbypassrls
     AND NOT rolinherit
),
grantor AS (
  SELECT count(*) AS role_count
    FROM pg_roles
   WHERE rolname = :'grantor_role'
     AND rolcanlogin
     AND rolsuper
)
SELECT CASE
  WHEN current_setting('server_version_num')::integer >= 160000
   AND session_user = current_user
   AND session_user = :'schema_role'
   AND (SELECT role_count FROM bounded_roles) = 4
   AND (SELECT role_count FROM fixed_roles) = 3
   AND (SELECT role_count FROM grantor) = 1
   AND (SELECT count(*) FROM actual) = 3
   AND NOT EXISTS (
     (SELECT granted_role, member_role, admin_option, inherit_option, set_option
        FROM actual
       WHERE grantor_role = :'grantor_role')
     EXCEPT
     SELECT * FROM expected
   )
   AND NOT EXISTS (
     SELECT * FROM expected
     EXCEPT
     SELECT granted_role, member_role, admin_option, inherit_option, set_option
       FROM actual
      WHERE grantor_role = :'grantor_role'
   )
  THEN 'ready'
  ELSE 'wait'
END;
SQL
  )" || result=wait

  if [ "$result" = "ready" ]; then
    printf '%s\n' 'WEBHOOK_DATABASE_PRINCIPAL_GATE_READY'
    exit 0
  fi
  sleep 2
done

fail
