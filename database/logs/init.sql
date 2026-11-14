-- =====================================================================
-- MediCitas - Logs Database - Microservice: Logs & Audit
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
-- audit_log: RF18, RF19 - append-only (I6)
-- Records who, what, about which patient and when, for every read and
-- write of clinical notes and patient contact data.
-- Protected by the engine: a trigger rejects UPDATE, DELETE and TRUNCATE.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_log_id UUID NOT NULL DEFAULT gen_uuid_v7(),
    clinic_id    UUID        NOT NULL,                       -- Logical reference to Clinics Service
    app_user_id  UUID        NOT NULL,                       -- Logical reference to Users Service
    patient_id   UUID        NOT NULL,                       -- Logical reference to Users Service
    action       VARCHAR(16) NOT NULL
                 CHECK (action IN ('read', 'create', 'update')),
    resource     VARCHAR(32) NOT NULL
                 CHECK (resource IN ('clinical_note', 'patient_contact')),
    resource_id  UUID        NOT NULL,                       -- id of the note or the patient
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (clinic_id, audit_log_id)
);

CREATE INDEX idx_audit_log_clinic_id ON audit_log (clinic_id);
CREATE INDEX idx_audit_log_app_user_id ON audit_log (app_user_id);
CREATE INDEX idx_audit_log_patient_id ON audit_log (patient_id);
CREATE INDEX idx_audit_log_occurred_at ON audit_log (occurred_at);

CREATE FUNCTION reject_audit_log_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update_delete
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_change();

CREATE TRIGGER trg_audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_log_change();

-- =====================================================================
-- Row Level Security (RLS) - Logs Service
-- =====================================================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- RF19: Only the clinic_admin of the clinic may view audit logs
CREATE POLICY audit_log_select_policy ON audit_log
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'clinic_admin'
    );

-- System services logging audit events
CREATE POLICY audit_log_insert_policy ON audit_log
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        OR app_is_platform_admin()
    );

CREATE POLICY audit_log_update_policy ON audit_log
    FOR UPDATE
    USING (false);

CREATE POLICY audit_log_delete_policy ON audit_log
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

GRANT SELECT ON audit_log TO db_admin;
GRANT SELECT, INSERT ON audit_log TO medicitas_app;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app;

