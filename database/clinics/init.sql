-- =====================================================================
-- MediCitas - Clinics Database - Microservice: Clinics
-- Engine: PostgreSQL 17
-- =====================================================================

-- --------------------------------------------------------------------
-- Context & RLS Helper Functions
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_clinic_id() RETURNS uuid AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_clinic_id', true), '')::uuid;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_user_id', true), '')::uuid;
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_current_role() RETURNS text AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_role', true), '');
EXCEPTION
    WHEN OTHERS THEN RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean AS $$
BEGIN
    RETURN COALESCE(current_setting('app.current_role', true) = 'platform_admin', false);
EXCEPTION
    WHEN OTHERS THEN RETURN false;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION app_set_session_context(
    p_clinic_id uuid,
    p_user_id uuid,
    p_role text,
    p_professional_id uuid DEFAULT NULL,
    p_is_local boolean DEFAULT true
) RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_clinic_id', COALESCE(p_clinic_id::text, ''), p_is_local);
    PERFORM set_config('app.current_user_id', COALESCE(p_user_id::text, ''), p_is_local);
    PERFORM set_config('app.current_role', COALESCE(p_role, ''), p_is_local);
    PERFORM set_config('app.current_professional_id', COALESCE(p_professional_id::text, ''), p_is_local);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app_reset_session_context() RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_clinic_id', '', false);
    PERFORM set_config('app.current_user_id', '', false);
    PERFORM set_config('app.current_role', '', false);
    PERFORM set_config('app.current_professional_id', '', false);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION gen_uuid_v7() RETURNS uuid AS $$
DECLARE
    v_time_ms bigint;
    v_bytes   bytea;
BEGIN
    v_time_ms := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    v_bytes := overlay(
        uuid_send(gen_random_uuid())
        PLACING substring(int8send(v_time_ms) FROM 3 FOR 6)
        FROM 1 FOR 6
    );
    v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112);  -- version 7
    v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);  -- RFC 9562 variant
    RETURN encode(v_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- --------------------------------------------------------------------
-- clinic
-- --------------------------------------------------------------------
CREATE TABLE clinic (
    clinic_id  UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    identifier VARCHAR(32)  NOT NULL UNIQUE,
    name       VARCHAR(128) NOT NULL,
    time_zone  TEXT         NOT NULL,
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE
);

-- --------------------------------------------------------------------
-- specialty: global catalog shared by every clinic
-- --------------------------------------------------------------------
CREATE TABLE specialty (
    specialty_id UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    name         VARCHAR(128) NOT NULL UNIQUE
);

-- --------------------------------------------------------------------
-- service: clinic catalog
-- --------------------------------------------------------------------
CREATE TABLE service (
    service_id       UUID NOT NULL DEFAULT gen_uuid_v7(),
    clinic_id        UUID NOT NULL REFERENCES clinic (clinic_id),
    specialty_id     UUID NOT NULL REFERENCES specialty (specialty_id),
    name             VARCHAR(128) NOT NULL,
    duration_minutes INT  NOT NULL CHECK (duration_minutes > 0),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (clinic_id, service_id),
    UNIQUE (clinic_id, name)
);

CREATE INDEX idx_service_clinic_id ON service (clinic_id);
CREATE INDEX idx_service_specialty_id ON service (specialty_id);

-- =====================================================================
-- Row Level Security (RLS) - Clinics Service
-- =====================================================================

-- 1. clinic
ALTER TABLE clinic ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic FORCE ROW LEVEL SECURITY;

CREATE POLICY clinic_select_policy ON clinic
    FOR SELECT
    USING (app_is_platform_admin() OR clinic_id = app_current_clinic_id());

CREATE POLICY clinic_insert_policy ON clinic
    FOR INSERT
    WITH CHECK (app_is_platform_admin());

CREATE POLICY clinic_update_policy ON clinic
    FOR UPDATE
    USING (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'))
    WITH CHECK (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'));

CREATE POLICY clinic_delete_policy ON clinic
    FOR DELETE
    USING (app_is_platform_admin());

-- 2. specialty (Global catalog)
ALTER TABLE specialty ENABLE ROW LEVEL SECURITY;
ALTER TABLE specialty FORCE ROW LEVEL SECURITY;

CREATE POLICY specialty_select_policy ON specialty
    FOR SELECT
    USING (true);

CREATE POLICY specialty_modify_policy ON specialty
    FOR ALL
    USING (app_is_platform_admin())
    WITH CHECK (app_is_platform_admin());

-- 3. service
ALTER TABLE service ENABLE ROW LEVEL SECURITY;
ALTER TABLE service FORCE ROW LEVEL SECURITY;

CREATE POLICY service_select_policy ON service
    FOR SELECT
    USING (app_is_platform_admin() OR clinic_id = app_current_clinic_id());

CREATE POLICY service_insert_policy ON service
    FOR INSERT
    WITH CHECK (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'));

CREATE POLICY service_update_policy ON service
    FOR UPDATE
    USING (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'))
    WITH CHECK (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'));

CREATE POLICY service_delete_policy ON service
    FOR DELETE
    USING (app_is_platform_admin() OR (clinic_id = app_current_clinic_id() AND app_current_role() = 'clinic_admin'));

-- --------------------------------------------------------------------
-- Database Roles
-- --------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'db_admin') THEN
        CREATE ROLE db_admin;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'db_receptionist') THEN
        CREATE ROLE db_receptionist;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'db_professional') THEN
        CREATE ROLE db_professional;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medicitas_app') THEN
        CREATE ROLE medicitas_app;
    END IF;
END
$$;

DO $$
BEGIN
    EXECUTE format('GRANT db_admin, db_receptionist, db_professional, medicitas_app TO %I', CURRENT_USER);
END
$$;

GRANT USAGE ON SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON clinic, specialty, service TO db_admin, medicitas_app;
REVOKE DELETE ON TABLE public.service FROM medicitas_app;
GRANT SELECT ON clinic, specialty, service TO db_receptionist, db_professional;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app;

BEGIN;
-- Only pending registrations carry these values. Existing clinics stay active as before.
ALTER TABLE public.clinic ADD COLUMN IF NOT EXISTS bootstrap_admin_id uuid;
ALTER TABLE public.clinic ADD COLUMN IF NOT EXISTS bootstrap_username varchar(128);
COMMIT;
