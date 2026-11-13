-- Run as the schema owner against an initialized users_db, before enabling RF14.
-- Repeatable: preserves patient/professional data and queued/published events.
-- N10 owns relay delivery and its separate consumer permissions.
BEGIN;

CREATE TABLE IF NOT EXISTS public.outbox (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id UUID NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ
);

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_insert_policy ON public.outbox;
CREATE POLICY outbox_insert_policy ON public.outbox
    FOR INSERT TO medicitas_app
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role()
            IN ('clinic_admin', 'receptionist', 'professional')
    );

REVOKE ALL ON public.outbox FROM PUBLIC, medicitas_app;
GRANT INSERT ON public.outbox TO medicitas_app;

COMMIT;
