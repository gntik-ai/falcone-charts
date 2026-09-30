-- Remove inherited tenant data-role privileges from the platform Flow audit outbox.
-- The executor creates this table and revokes grants atomically at boot. This
-- migration also repairs tables created by older executors or default privileges.
-- Safe to replay before or after the executor creates the table.
DO $$
DECLARE
  data_role text;
BEGIN
  IF to_regclass('public.flow_audit_outbox') IS NULL THEN
    RETURN;
  END IF;

  REVOKE ALL PRIVILEGES ON TABLE public.flow_audit_outbox FROM PUBLIC;
  FOREACH data_role IN ARRAY ARRAY['falcone_service', 'falcone_anon'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = data_role) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.flow_audit_outbox FROM %I', data_role
      );
    END IF;
  END LOOP;
END
$$;
