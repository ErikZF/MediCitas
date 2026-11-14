BEGIN;
-- Only pending registrations carry these values. Existing clinics stay active as before.
ALTER TABLE public.clinic ADD COLUMN IF NOT EXISTS bootstrap_admin_id uuid;
ALTER TABLE public.clinic ADD COLUMN IF NOT EXISTS bootstrap_username varchar(128);
COMMIT;
