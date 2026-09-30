-- Grant the executor only the outbox table operations needed by the relay.
-- Safe to re-run after the runtime creates the table. Data-plane roles must
-- never inherit access, including on installations with old blanket grants.
DO $$
DECLARE
  data_role text;
BEGIN
  IF to_regclass('public.flow_audit_outbox') IS NULL THEN
    RAISE EXCEPTION 'flow_audit_outbox is absent; apply source schema first';
  END IF;

  REVOKE ALL PRIVILEGES ON TABLE public.flow_audit_outbox FROM PUBLIC;
  FOREACH data_role IN ARRAY ARRAY['falcone_service', 'falcone_anon'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = data_role) THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.flow_audit_outbox FROM %I', data_role);
    END IF;
  END LOOP;

  -- The shared chart's executor connects as the POSTGRESQL_USERNAME app role.
  -- It owns the runtime-created table on fresh installs; this grant also
  -- reconciles an existing table owned by an administrator.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'falcone') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_audit_outbox TO falcone;
  END IF;
END
$$;
