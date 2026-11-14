BEGIN;
-- Existing rows keep their original ownership and roles.
ALTER TABLE public.app_user ADD COLUMN IF NOT EXISTS is_first_admin boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_first_admin_per_clinic
    ON public.app_user (clinic_id) WHERE is_first_admin;

CREATE OR REPLACE FUNCTION public.app_clinic_has_users(target uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
    SELECT EXISTS (SELECT 1 FROM public.app_user WHERE clinic_id = target);
$$;

DROP POLICY IF EXISTS app_user_first_admin_insert ON public.app_user;
CREATE POLICY app_user_first_admin_insert ON public.app_user FOR INSERT TO medicitas_app
WITH CHECK (app_is_platform_admin() AND app_current_clinic_id() IS NULL
    AND clinic_id IS NOT NULL AND role_code = 'clinic_admin' AND is_first_admin
    AND NOT public.app_clinic_has_users(clinic_id));
COMMIT;
