-- Grant the executor the outbox operations needed by writes, relay, and purge.
-- Change: finish-flow-audit-kafka-publication (#1045)
--
-- Safe to re-run after the runtime creates the table. Data-plane roles must
-- never inherit access, including on installations with old blanket grants.
-- psql supplies executor_role from the same secret used by the executor.
SELECT set_config('flow_audit.executor_role', :'executor_role', false);
DO $$
DECLARE
  data_role text;
  executor_role text := current_setting('flow_audit.executor_role');
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
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = executor_role) THEN
    RAISE EXCEPTION 'flow audit executor role % does not exist', executor_role;
  END IF;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.flow_audit_outbox TO %I', executor_role);
END
$$;
