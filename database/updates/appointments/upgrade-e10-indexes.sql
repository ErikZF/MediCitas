-- Card E10: replace the appointments_db indexes with the ones justified in docs/indexes.md.
-- Manual, non-destructive upgrade for an existing database; new databases get it from init.sql.
-- Run as the schema owner. Repeatable.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- No appointment lasts more than a day (I3); queries use it to bound starts_at.
ALTER TABLE public.appointment DROP CONSTRAINT IF EXISTS appointment_within_one_day;
ALTER TABLE public.appointment ADD CONSTRAINT appointment_within_one_day CHECK (duration_minutes <= 1440);

DROP INDEX IF EXISTS public.idx_working_hours_clinic_id, public.idx_working_hours_professional_id,
                     public.idx_schedule_block_clinic_id, public.idx_schedule_block_professional_id,
                     public.idx_prof_service_professional_id, public.idx_prof_service_clinic_id,
                     public.idx_appointment_clinic_id, public.idx_appointment_professional_id,
                     public.idx_appointment_patient_id, public.idx_appointment_status,
                     public.idx_clinical_note_appointment_id, public.idx_clinical_note_clinic_id,
                     public.idx_clinical_note_professional_id;

CREATE INDEX IF NOT EXISTS idx_schedule_block_professional_starts_at ON public.schedule_block (clinic_id, professional_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointment_professional_starts_at ON public.appointment (clinic_id, professional_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointment_clinic_starts_at ON public.appointment (clinic_id, starts_at) INCLUDE (status);
CREATE INDEX IF NOT EXISTS idx_appointment_patient_starts_at ON public.appointment (clinic_id, patient_id, starts_at);

COMMIT;

ANALYZE public.appointment, public.schedule_block;
