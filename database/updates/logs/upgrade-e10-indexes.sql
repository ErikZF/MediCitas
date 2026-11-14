-- Card E10: replace the logs_db indexes with the ones justified in docs/indexes.md.
-- Manual, non-destructive upgrade for an existing database; new databases get it from init.sql.
-- Run as the schema owner. Repeatable.
BEGIN;
SET LOCAL lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_audit_log_clinic_id, public.idx_audit_log_app_user_id,
                     public.idx_audit_log_patient_id, public.idx_audit_log_occurred_at;

CREATE INDEX IF NOT EXISTS idx_audit_log_clinic_occurred_at ON public.audit_log (clinic_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_clinic_patient ON public.audit_log (clinic_id, patient_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_clinic_user ON public.audit_log (clinic_id, app_user_id, occurred_at);

COMMIT;

ANALYZE public.audit_log;
