-- =====================================================================
-- MediCitas - Appointments Database - Microservice: Appointments & Schedule
-- Engine: PostgreSQL 17
-- =====================================================================

-- btree_gist: lets one GiST index mix "=" (uuid) with "&&" (time ranges)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- timerange: range of times of day, used to forbid overlapping working hours
CREATE TYPE timerange AS RANGE (subtype = time);

-- ---------------------------------------------------------------------
-- working_hours: weekly schedule of a professional
-- professional_id is a logical reference to Users Service
-- ---------------------------------------------------------------------
CREATE TABLE working_hours (
    working_hours_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

CREATE INDEX idx_working_hours_professional_id ON working_hours (professional_id);

-- ---------------------------------------------------------------------
-- schedule_block: vacation / leave of a professional (RF6)
-- professional_id is a logical reference to Users Service
-- ---------------------------------------------------------------------
CREATE TABLE schedule_block (
    schedule_block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    professional_id   UUID        NOT NULL,                    -- Logical reference to Users Service
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    reason            VARCHAR(256),
    CHECK (starts_at < ends_at)
);

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
