-- RF18: lets the audit relay (audit-service) read and mark contact audit events.
-- Manual, non-destructive upgrade for an existing users_db; new databases get it from init.sql.
-- Run as the schema owner, after upgrade-patient-audit-outbox.sql. Repeatable.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medicitas_relay') THEN
        CREATE ROLE medicitas_relay;
    END IF;
    EXECUTE format('GRANT medicitas_relay TO %I', CURRENT_USER);
END
$$;

GRANT USAGE ON SCHEMA public TO medicitas_relay;
GRANT SELECT, UPDATE (published_at) ON public.outbox TO medicitas_relay;

DROP POLICY IF EXISTS outbox_relay_select_policy ON public.outbox;
CREATE POLICY outbox_relay_select_policy ON public.outbox
    FOR SELECT TO medicitas_relay
    USING (true);

DROP POLICY IF EXISTS outbox_relay_update_policy ON public.outbox;
CREATE POLICY outbox_relay_update_policy ON public.outbox
    FOR UPDATE TO medicitas_relay
    USING (true)
    WITH CHECK (true);

COMMIT;
