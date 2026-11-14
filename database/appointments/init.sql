-- =====================================================================
-- MediCitas - Appointments Database - Microservice: Appointments & Schedule
-- Engine: PostgreSQL 17
-- =====================================================================

-- btree_gist: lets one GiST index mix "=" (uuid) with "&&" (time ranges)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- timerange: range of times of day, used to forbid overlapping working hours
CREATE TYPE timerange AS RANGE (subtype = time);

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

-- ---------------------------------------------------------------------
-- working_hours: weekly schedule of a professional
-- professional_id is a logical reference to Users Service
-- clinic_id is a logical reference to Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE working_hours (
    working_hours_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id        UUID     NOT NULL,                        -- Logical reference to Clinics Service
    professional_id  UUID     NOT NULL,                        -- Logical reference to Users Service
    weekday          SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Sunday
    start_time       TIME     NOT NULL,
    end_time         TIME     NOT NULL,
    CHECK (start_time < end_time),   -- shifts crossing midnight are not supported
    CONSTRAINT no_overlap_working_hours EXCLUDE USING gist (
        professional_id                       WITH =,
        weekday                               WITH =,
        timerange(start_time, end_time, '[)') WITH &&
    )
);

CREATE INDEX idx_working_hours_clinic_id ON working_hours (clinic_id);
CREATE INDEX idx_working_hours_professional_id ON working_hours (professional_id);

-- ---------------------------------------------------------------------
-- schedule_block: vacation / leave of a professional (RF6)
-- professional_id is a logical reference to Users Service
-- clinic_id is a logical reference to Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE schedule_block (
    schedule_block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id         UUID        NOT NULL,                    -- Logical reference to Clinics Service
    professional_id   UUID        NOT NULL,                    -- Logical reference to Users Service
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    reason            VARCHAR(256),
    CHECK (starts_at < ends_at)
);

CREATE INDEX idx_schedule_block_clinic_id ON schedule_block (clinic_id);
CREATE INDEX idx_schedule_block_professional_id ON schedule_block (professional_id);

-- ---------------------------------------------------------------------
-- professional_service: services that a professional provides
-- References to professional (Users), service (Clinics), clinic (Clinics), specialty (Clinics)
-- ---------------------------------------------------------------------
CREATE TABLE professional_service (
    professional_id UUID NOT NULL,                             -- Logical reference to Users Service
    service_id      UUID NOT NULL,                             -- Logical reference to Clinics Service
    clinic_id       UUID NOT NULL,                             -- Logical reference to Clinics Service
    specialty_id    UUID NOT NULL,                             -- Logical reference to Clinics Service
    PRIMARY KEY (professional_id, service_id)
);

CREATE INDEX idx_prof_service_professional_id ON professional_service (professional_id);
CREATE INDEX idx_prof_service_clinic_id ON professional_service (clinic_id);

-- ---------------------------------------------------------------------
-- appointment: RF9 to RF13
-- References:
-- clinic_id (Clinics Service)
-- professional_id (Users Service)
-- patient_id (Users Service)
-- service_id (Clinics Service)
-- created_by / cancelled_by (Users Service)
-- ---------------------------------------------------------------------
CREATE TABLE appointment (
    appointment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id           UUID        NOT NULL,                  -- Logical reference to Clinics Service
    professional_id     UUID        NOT NULL,                  -- Logical reference to Users Service
    patient_id          UUID        NOT NULL,                  -- Logical reference to Users Service
    service_id          UUID        NOT NULL,                  -- Logical reference to Clinics Service
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,
    duration_minutes    INT         NOT NULL CHECK (duration_minutes > 0), -- snapshot of the service duration at booking (I4)
    status              VARCHAR(16) NOT NULL DEFAULT 'booked'
                        CHECK (status IN ('booked', 'attended', 'no_show', 'cancelled', 'rescheduled')),
    cancel_reason       VARCHAR(256),                          -- RF11
    cancelled_by        UUID,                                  -- Logical reference to Users Service (app_user_id)
    rescheduled_from_id UUID UNIQUE REFERENCES appointment (appointment_id), -- RF10: an appointment is replaced at most once
    created_by          UUID        NOT NULL,                  -- Logical reference to Users Service (app_user_id)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (starts_at < ends_at),
    CHECK (ends_at = starts_at + make_interval(mins => duration_minutes)),   -- I4
    -- I1: a professional never has two active appointments that overlap.
    -- Enforced by the engine, also under concurrency.
    -- '[)' = start included, end excluded: back-to-back appointments are allowed.
    CONSTRAINT no_overlap_professional EXCLUDE USING gist (
        professional_id                     WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'booked'),
    -- I2: a patient never has two active appointments that overlap.
    CONSTRAINT no_overlap_patient EXCLUDE USING gist (
        patient_id                          WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'booked')
);

CREATE INDEX idx_appointment_clinic_id ON appointment (clinic_id);
CREATE INDEX idx_appointment_professional_id ON appointment (professional_id);
CREATE INDEX idx_appointment_patient_id ON appointment (patient_id);
CREATE INDEX idx_appointment_status ON appointment (status);

-- ---------------------------------------------------------------------
-- Status transition trigger (RF13)
-- ---------------------------------------------------------------------
CREATE FUNCTION enforce_appointment_status_transition() RETURNS trigger AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND OLD.status <> 'booked' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_status_transition
BEFORE UPDATE OF status ON appointment
FOR EACH ROW EXECUTE FUNCTION enforce_appointment_status_transition();

-- ---------------------------------------------------------------------
-- clinical_note: RF15 - Sensitive clinical notes per appointment
-- ---------------------------------------------------------------------
CREATE TABLE clinical_note (
    clinical_note_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id     UUID        NOT NULL UNIQUE REFERENCES appointment (appointment_id),
    clinic_id          UUID        NOT NULL,                  -- Logical reference to Clinics Service
    professional_id    UUID        NOT NULL,                  -- Logical reference to Users Service
    appointment_status VARCHAR(16) NOT NULL DEFAULT 'attended'
                       CHECK (appointment_status = 'attended'),
    content            TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_clinical_note_appointment_id ON clinical_note (appointment_id);
CREATE INDEX idx_clinical_note_clinic_id ON clinical_note (clinic_id);
CREATE INDEX idx_clinical_note_professional_id ON clinical_note (professional_id);

-- ---------------------------------------------------------------------
-- outbox: Transactional outbox for domain events
-- ---------------------------------------------------------------------
CREATE TABLE outbox (
    event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id     UUID        NOT NULL,
    aggregate_id  UUID        NOT NULL,   -- appointment_id or professional_id
    event_type    VARCHAR(64) NOT NULL,   -- AgendaChanged, AppointmentBooked...
    payload       JSONB       NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at  TIMESTAMPTZ             -- NULL = pending
);

CREATE INDEX idx_outbox_pending ON outbox (created_at) WHERE published_at IS NULL;

-- ---------------------------------------------------------------------
-- idempotency_keys: E5 - Idempotency-Key store for appointment booking
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
    clinic_id       UUID         NOT NULL,
    key             VARCHAR(128) NOT NULL,
    request_hash    VARCHAR(64)  NOT NULL,
    response_status SMALLINT     NOT NULL,
    response_body   JSONB        NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ  NOT NULL DEFAULT (now() + interval '24 hours'),
    PRIMARY KEY (clinic_id, key)
);

CREATE INDEX idx_idempotency_keys_expires_at ON idempotency_keys (expires_at);

-- =====================================================================
-- Row Level Security (RLS) - Appointments Service
-- =====================================================================

-- 1. working_hours
ALTER TABLE working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours FORCE ROW LEVEL SECURITY;

CREATE POLICY working_hours_select_policy ON working_hours
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY working_hours_write_policy ON working_hours
    FOR ALL
    USING (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() = 'clinic_admin'
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() = 'clinic_admin'
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    );

-- 2. schedule_block
ALTER TABLE schedule_block ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_block FORCE ROW LEVEL SECURITY;

CREATE POLICY schedule_block_select_policy ON schedule_block
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY schedule_block_write_policy ON schedule_block
    FOR ALL
    USING (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() = 'clinic_admin'
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() = 'clinic_admin'
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    );

-- 3. professional_service
ALTER TABLE professional_service ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_service FORCE ROW LEVEL SECURITY;

CREATE POLICY prof_service_select_policy ON professional_service
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY prof_service_write_policy ON professional_service
    FOR ALL
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'clinic_admin'
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'clinic_admin'
    );

-- 4. appointment (Multi-tenant I5: platform_admin has NO access)
ALTER TABLE appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment FORCE ROW LEVEL SECURITY;

CREATE POLICY appointment_select_policy ON appointment
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY appointment_insert_policy ON appointment
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    );

CREATE POLICY appointment_update_policy ON appointment
    FOR UPDATE
    USING (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() IN ('clinic_admin', 'receptionist')
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND (
            app_current_role() IN ('clinic_admin', 'receptionist')
            OR (app_current_role() = 'professional' AND professional_id = app_current_professional_id())
        )
    );

CREATE POLICY appointment_delete_policy ON appointment
    FOR DELETE
    USING (false);

-- 5. clinical_note (RF15: Most sensitive data - ONLY the professional of that appointment)
ALTER TABLE clinical_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_note FORCE ROW LEVEL SECURITY;

CREATE POLICY clinical_note_select_policy ON clinical_note
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'professional'
        AND professional_id = app_current_professional_id()
    );

CREATE POLICY clinical_note_insert_policy ON clinical_note
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'professional'
        AND professional_id = app_current_professional_id()
    );

CREATE POLICY clinical_note_update_policy ON clinical_note
    FOR UPDATE
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'professional'
        AND professional_id = app_current_professional_id()
    )
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() = 'professional'
        AND professional_id = app_current_professional_id()
    );

CREATE POLICY clinical_note_delete_policy ON clinical_note
    FOR DELETE
    USING (false);

-- 6. outbox (Transactional outbox: app roles only INSERT per clinic; medicitas_relay reads/updates all)
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_insert_policy ON outbox
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist', 'professional')
    );

CREATE POLICY outbox_delete_policy ON outbox
    FOR DELETE
    USING (false);

-- 7. idempotency_keys (E5: tenant-scoped booking idempotency)
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_select_policy ON idempotency_keys
    FOR SELECT
    USING (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    );

CREATE POLICY idempotency_keys_insert_policy ON idempotency_keys
    FOR INSERT
    WITH CHECK (
        clinic_id = app_current_clinic_id()
        AND app_current_role() IN ('clinic_admin', 'receptionist')
    );

CREATE POLICY idempotency_keys_delete_policy ON idempotency_keys
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
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'medicitas_relay') THEN
        CREATE ROLE medicitas_relay;
    END IF;
END
$$;

DO $$
BEGIN
    EXECUTE format('GRANT db_admin, db_receptionist, db_professional, medicitas_app, medicitas_relay TO %I', CURRENT_USER);
END
$$;

CREATE POLICY outbox_relay_select_policy ON outbox
    FOR SELECT
    TO medicitas_relay
    USING (true);

CREATE POLICY outbox_relay_update_policy ON outbox
    FOR UPDATE
    TO medicitas_relay
    USING (true)
    WITH CHECK (true);

GRANT USAGE ON SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app, medicitas_relay;

GRANT SELECT, INSERT, UPDATE, DELETE ON working_hours, schedule_block, professional_service, appointment TO db_admin;
GRANT INSERT ON outbox TO db_admin;
GRANT SELECT, INSERT ON idempotency_keys TO db_admin;

GRANT SELECT ON working_hours, schedule_block, professional_service TO db_receptionist;
GRANT SELECT, INSERT, UPDATE ON appointment TO db_receptionist;
GRANT INSERT ON outbox TO db_receptionist;
GRANT SELECT, INSERT ON idempotency_keys TO db_receptionist;

GRANT SELECT, INSERT, UPDATE, DELETE ON working_hours, schedule_block TO db_professional;
GRANT SELECT ON professional_service TO db_professional;
GRANT SELECT, UPDATE ON appointment TO db_professional;
GRANT SELECT, INSERT, UPDATE ON clinical_note TO db_professional;
GRANT INSERT ON outbox TO db_professional;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medicitas_app;
REVOKE SELECT, UPDATE, DELETE ON outbox FROM medicitas_app;

GRANT SELECT, UPDATE ON outbox TO medicitas_relay;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO db_admin, db_receptionist, db_professional, medicitas_app;

