-- Manual, non-destructive upgrade for an existing clinics_db; not a migration runner.
-- Review the connection target before applying as the service table owner.
-- Existing services become active. Re-running preserves already retired services.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.service
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

REVOKE DELETE ON TABLE public.service FROM medicitas_app;

COMMIT;
