-- =====================================================================
-- MediCitas - Users Database - Microservice: Users
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

CREATE OR REPLACE FUNCTION app_current_professional_id() RETURNS uuid AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_professional_id', true), '')::uuid;
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

-- ---------------------------------------------------------------------
-- role: system roles
-- ---------------------------------------------------------------------
CREATE TABLE role (
    role_code   VARCHAR(32)  PRIMARY KEY,
    description VARCHAR(128) NOT NULL
);

INSERT INTO role (role_code, description) VALUES
    ('platform_admin', 'Platform administrator: registers clinics, no access to clinical data'),
    ('clinic_admin',   'Clinic administrator: users, professionals, services and audit log'),
    ('receptionist',   'Reception: patients and appointment schedule'),
    ('professional',   'Health professional: own schedule and clinical notes');

-- ---------------------------------------------------------------------
-- app_user: link between the Keycloak identity and the domain
-- Credentials live in Keycloak. platform_admin is the only role without clinic.
-- clinic_id is a logical reference to the Clinics microservice.
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    app_user_id  UUID PRIMARY KEY DEFAULT gen_uuid_v7(),
    keycloak_sub TEXT        NOT NULL UNIQUE,                  -- "sub" claim of the token
    clinic_id    UUID,                                         -- Logical reference to Clinics Service (NULL only for platform_admin)
    role_code    VARCHAR(32) NOT NULL REFERENCES role (role_code),
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,            -- logical deletion
    CHECK ((role_code = 'platform_admin') = (clinic_id IS NULL))
);

CREATE INDEX idx_app_user_clinic_id ON app_user (clinic_id);

-- ---------------------------------------------------------------------
-- professional: healthcare professionals linked to app_user
-- ---------------------------------------------------------------------
CREATE TABLE professional (
    professional_id UUID NOT NULL DEFAULT gen_uuid_v7(),
    clinic_id       UUID         NOT NULL,                     -- Logical reference to Clinics Service
    app_user_id     UUID         NOT NULL REFERENCES app_user (app_user_id),
    full_name       VARCHAR(128) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    PRIMARY KEY (clinic_id, professional_id),
    UNIQUE (clinic_id, app_user_id)
);

CREATE INDEX idx_professional_clinic_id ON professional (clinic_id);

-- ---------------------------------------------------------------------
-- professional_specialty: a professional may have several specialties (N:M)
-- specialty_id is a logical reference to the specialty catalog in Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE professional_specialty (
    professional_id UUID NOT NULL,
    specialty_id    UUID NOT NULL,                              -- Logical reference to Clinics Service
    clinic_id       UUID NOT NULL,                              -- Logical reference to Clinics Service
    PRIMARY KEY (clinic_id, professional_id, specialty_id),
    FOREIGN KEY (clinic_id, professional_id)
        REFERENCES professional (clinic_id, professional_id)
        ON DELETE CASCADE
);

CREATE INDEX idx_professional_specialty_specialty_id ON professional_specialty (specialty_id);
CREATE INDEX idx_professional_specialty_clinic_id ON professional_specialty (clinic_id);

-- ---------------------------------------------------------------------
-- patient: clinic patient registry
-- clinic_id is a logical reference to Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE patient (
    patient_id     UUID NOT NULL DEFAULT gen_uuid_v7(),
    clinic_id      UUID         NOT NULL,                      -- Logical reference to Clinics Service
    identification VARCHAR(32)  NOT NULL,                      -- national id / passport
    full_name      VARCHAR(128) NOT NULL,
    birth_date     DATE         NOT NULL,
    phone          VARCHAR(32),
    email          VARCHAR(128),
    PRIMARY KEY (clinic_id, patient_id),
    UNIQUE (clinic_id, identification)
);

CREATE INDEX idx_patient_clinic_id ON patient (clinic_id);

-- =====================================================================
-- Row Level Security (RLS) - Users Service
-- =====================================================================

-- 1. role (Global catalog)
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;

CREATE POLICY role_select_policy ON role
    FOR SELECT
    USING (true);

CREATE POLICY role_write_policy ON role
    FOR ALL
    USING (false)
    WITH CHECK (false);

-- 2. app_user
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;

CREATE POLICY app_user_select_policy ON app_user
    FOR SELECT
    USING (
        app_is_platform_admin()
        OR clinic_id = app_current_clinic_id()
        OR app_user_id = app_current_user_id()
    );

CREATE POLICY app_user_insert_policy ON app_user
    FOR INSERT
    WITH CHECK (
        (app_is_platform_admin() AND role_code = 'platform_admin' AND clinic_id IS NULL)
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id() AND role_code <> 'platform_admin')
    );

CREATE POLICY app_user_update_policy ON app_user
    FOR UPDATE
    USING (
        app_is_platform_admin()
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id() AND role_code <> 'platform_admin')
        OR app_user_id = app_current_user_id()
    )
    WITH CHECK (
        app_is_platform_admin()
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id() AND role_code <> 'platform_admin')
    );

CREATE POLICY app_user_delete_policy ON app_user
    FOR DELETE
    USING (false);

-- 3. professional
ALTER TABLE professional ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional FORCE ROW LEVEL SECURITY;

CREATE POLICY professional_select_policy ON professional
    FOR SELECT
    USING (app_is_platform_admin() OR clinic_id = app_current_clinic_id());

CREATE POLICY professional_insert_policy ON professional
    FOR INSERT
    WITH CHECK (
        app_is_platform_admin()
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id())
    );

CREATE POLICY professional_update_policy ON professional
    FOR UPDATE
    USING (
        app_is_platform_admin()
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id())
        OR (app_current_role() = 'professional' AND clinic_id = app_current_clinic_id() AND app_user_id = app_current_user_id())
    )
    WITH CHECK (
        app_is_platform_admin()
        OR (app_current_role() = 'clinic_admin' AND clinic_id = app_current_clinic_id())
        OR (app_current_role() = 'professional' AND clinic_id = app_current_clinic_id() AND app_user_id = app_current_user_id())
    );

CREATE POLICY professional_delete_policy ON professional
    FOR DELETE
    USING (false);

-- 4. professional_specialty
ALTER TABLE professional_specialty ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_specialty FORCE ROW LEVEL SECURITY;

CREATE POLICY prof_spec_select_policy ON professional_specialty
    FOR SELECT
    USING (
        app_is_platform_admin()
        OR
        professional_specialty.clinic_id = app_current_clinic_id()
    );

CREATE POLICY prof_spec_modify_policy ON professional_specialty
    FOR ALL
    USING (
        app_is_platform_admin()
        OR (
            app_current_role() = 'clinic_admin'
            AND
            clinic_id = app_current_clinic_id()
        )
    )
    WITH CHECK (
        app_is_platform_admin()
        OR (
            app_current_role() = 'clinic_admin'
            AND
            clinic_id = app_current_clinic_id()
        )
    );

-- 5. patient (Sensitive domain data - Strict tenant isolation I5, platform_admin has NO access)
ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient FORCE ROW LEVEL SECURITY;

CREATE POLICY patient_select_policy ON patient
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY patient_insert_policy ON patient
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    );

CREATE POLICY patient_update_policy ON patient
    FOR UPDATE
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    );

CREATE POLICY patient_delete_policy ON patient
    FOR DELETE
    USING (false);

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

GRANT SELECT ON role TO db_admin, db_receptionist, db_professional, medicitas_app;
GRANT SELECT, INSERT, UPDATE ON app_user, professional, patient TO db_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON professional_specialty TO db_admin;

GRANT SELECT ON app_user, professional, professional_specialty TO db_receptionist;
GRANT SELECT, INSERT, UPDATE ON patient TO db_receptionist;

GRANT SELECT ON professional_specialty, patient TO db_professional;
GRANT SELECT, UPDATE ON app_user, professional TO db_professional;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medicitas_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app;

-- outbox: RF18 contact audit events for the new users database.
-- N10 owns relay delivery and its separate consumer permissions.

CREATE TABLE public.outbox (
    event_id UUID NOT NULL DEFAULT gen_uuid_v7(),
    clinic_id UUID NOT NULL,
    aggregate_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    PRIMARY KEY (clinic_id, event_id)
);

ALTER TABLE public.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_insert_policy ON public.outbox
    FOR INSERT TO medicitas_app
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role()
            IN ('clinic_admin', 'receptionist', 'professional')
    );

REVOKE ALL ON public.outbox FROM PUBLIC, medicitas_app;
GRANT INSERT ON public.outbox TO medicitas_app;
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
