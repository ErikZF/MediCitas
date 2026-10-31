-- =====================================================================
-- MediCitas(OLTP) Relational schema
-- Engine: PostgreSQL 17
-- =====================================================================


-- btree_gist: lets one GiST index mix "=" (uuid) with "&&" (time ranges),
-- needed by the EXCLUDE constraints on appointment (I1, I2)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- timerange: range of times of day, used to forbid overlapping working hours
CREATE TYPE timerange AS RANGE (subtype = time);

-- ------------------------------------------------------------------
-- clinic 
-- --------------------------------------------------------------------
CREATE TABLE clinic (
    clinic_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier VARCHAR(32)  NOT NULL UNIQUE,   
    name       VARCHAR(128) NOT NULL,
    time_zone  TEXT         NOT NULL,
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE
);


-- ---------------------------------------------------------------------
-- role: system roles (natural key: stable, short and meaningful code)
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
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    app_user_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    keycloak_sub TEXT        NOT NULL UNIQUE,                  -- "sub" claim of the token
    clinic_id    UUID        REFERENCES clinic (clinic_id),    -- NULL only for platform_admin
    role_code    VARCHAR(32) NOT NULL REFERENCES role (role_code),
    is_active    BOOLEAN     NOT NULL DEFAULT TRUE,            -- logical deletion
    CHECK ((role_code = 'platform_admin') = (clinic_id IS NULL)),
    UNIQUE (app_user_id, clinic_id),          -- target of composite FKs (same-clinic checks)
    UNIQUE (app_user_id, clinic_id, role_code) -- target of composite FK from professional (role check)
);


-- ---------------------------------------------------------------------
-- specialty: global catalog shared by every clinic
-- ---------------------------------------------------------------------
CREATE TABLE specialty (
    specialty_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(128) NOT NULL UNIQUE
);


-- ---------------------------------------------------------------------
-- service: clinic catalog 
-- ---------------------------------------------------------------------
CREATE TABLE service (
    service_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id        UUID NOT NULL REFERENCES clinic (clinic_id),
    specialty_id     UUID NOT NULL REFERENCES specialty (specialty_id),
    name             VARCHAR(128) NOT NULL,
    duration_minutes INT  NOT NULL CHECK (duration_minutes > 0),
    UNIQUE (clinic_id, name),
    UNIQUE (service_id, clinic_id),          -- target of composite FKs
    UNIQUE (service_id, specialty_id)        -- target of composite FKs
);


-- ---------------------------------------------------------------------
-- professional 
-- ---------------------------------------------------------------------
CREATE TABLE professional (
    professional_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID NOT NULL REFERENCES clinic (clinic_id),
    app_user_id     UUID NOT NULL UNIQUE,                 -- 1:1, a professional always has a login
    full_name       VARCHAR(128) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    role_code       VARCHAR(32)  NOT NULL DEFAULT 'professional'
                    CHECK (role_code = 'professional'),   -- deliberate denormalization for the FK below
    UNIQUE (professional_id, clinic_id),                  -- target of composite FKs
    -- the login user must belong to the SAME clinic and have the role 'professional'
    FOREIGN KEY (app_user_id, clinic_id, role_code) REFERENCES app_user (app_user_id, clinic_id, role_code)
);


-- ---------------------------------------------------------------------
-- professional_specialty: a professional may have several specialties (N:M)
-- ---------------------------------------------------------------------
CREATE TABLE professional_specialty (
    professional_id UUID NOT NULL REFERENCES professional (professional_id),
    specialty_id    UUID NOT NULL REFERENCES specialty (specialty_id),
    PRIMARY KEY (professional_id, specialty_id)
);


-- --------------------------------------------------------------------
-- professional_service 
-- ---------------------------------------------------------------------
CREATE TABLE professional_service (
    professional_id UUID NOT NULL,
    service_id      UUID NOT NULL,
    clinic_id       UUID NOT NULL,   -- deliberate denormalization: engine checks same clinic
    specialty_id    UUID NOT NULL,   -- deliberate denormalization: engine checks the professional has the service's specialty
    PRIMARY KEY (professional_id, service_id),
    FOREIGN KEY (professional_id, clinic_id)    REFERENCES professional (professional_id, clinic_id),
    FOREIGN KEY (service_id, clinic_id)         REFERENCES service (service_id, clinic_id),
    FOREIGN KEY (service_id, specialty_id)      REFERENCES service (service_id, specialty_id),
    FOREIGN KEY (professional_id, specialty_id) REFERENCES professional_specialty (professional_id, specialty_id)
);


-- ---------------------------------------------------------------------
-- working_hours: weekly schedule of a professional 
-- ---------------------------------------------------------------------
CREATE TABLE working_hours (
    working_hours_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    professional_id  UUID     NOT NULL REFERENCES professional (professional_id),
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



-- ---------------------------------------------------------------------
-- patient 
-- One row per clinic: the same person in two clinics is two patients,
-- which keeps clinic data isolated (I5).
-- ---------------------------------------------------------------------
CREATE TABLE patient (
    patient_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id      UUID         NOT NULL REFERENCES clinic (clinic_id),
    identification VARCHAR(32)  NOT NULL,      -- national id / passport
    full_name      VARCHAR(128) NOT NULL,
    birth_date     DATE         NOT NULL,
    phone          VARCHAR(32),
    email          VARCHAR(128),
    UNIQUE (clinic_id, identification),
    UNIQUE (patient_id, clinic_id)           -- target of composite FKs
);


-- ---------------------------------------------------------------------
-- schedule_block: vacation / leave of a professional (RF6)
-- Linked only to the professional (scope of RF6; one source of blocks
-- keeps availability (RF7) simple). Overlapping blocks are allowed: they
-- give the same availability and may have different reasons.
-- A block does NOT cancel existing appointments; they are listed as conflicts.
-- ---------------------------------------------------------------------
CREATE TABLE schedule_block (
    schedule_block_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    professional_id   UUID        NOT NULL REFERENCES professional (professional_id),
    starts_at         TIMESTAMPTZ NOT NULL,
    ends_at           TIMESTAMPTZ NOT NULL,
    reason            VARCHAR(256),
    CHECK (starts_at < ends_at)
);


-- ---------------------------------------------------------------------
-- appointment: RF9 to RF13
-- clinic_id is a deliberate denormalization: composite FKs force the
-- professional, the patient and the service to belong to the same clinic.
-- ends_at is the scheduled end (starts_at + service duration, I4); it is
-- stored so overlaps and availability can be computed on intervals.
-- Rescheduling (RF10), in ONE transaction: mark the old one 'rescheduled',
-- then insert the new one with rescheduled_from_id.
-- ---------------------------------------------------------------------
CREATE TABLE appointment (
    appointment_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id           UUID        NOT NULL,
    professional_id     UUID        NOT NULL,
    patient_id          UUID        NOT NULL,
    service_id          UUID        NOT NULL,
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,
    duration_minutes    INT         NOT NULL CHECK (duration_minutes > 0), -- snapshot of the service duration at booking (I4)
    status              VARCHAR(16) NOT NULL DEFAULT 'booked'
                        CHECK (status IN ('booked', 'attended', 'no_show', 'cancelled', 'rescheduled')),
    cancel_reason       VARCHAR(256),                                 -- RF11
    cancelled_by        UUID REFERENCES app_user (app_user_id),       -- RF11
    rescheduled_from_id UUID UNIQUE,                                  -- RF10: an appointment is replaced at most once
    created_by          UUID        NOT NULL REFERENCES app_user (app_user_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (starts_at < ends_at),
    CHECK (ends_at = starts_at + make_interval(mins => duration_minutes)),   -- I4
    UNIQUE (appointment_id, clinic_id),                               -- target of composite FKs
    UNIQUE (appointment_id, clinic_id, professional_id, status),      -- target of composite FK from clinical_note
    FOREIGN KEY (professional_id, clinic_id)  REFERENCES professional (professional_id, clinic_id),
    FOREIGN KEY (patient_id, clinic_id)       REFERENCES patient (patient_id, clinic_id),
    FOREIGN KEY (professional_id, service_id) REFERENCES professional_service (professional_id, service_id),
    FOREIGN KEY (rescheduled_from_id, clinic_id) REFERENCES appointment (appointment_id, clinic_id),
    -- I1: a professional never has two active appointments that overlap.
    -- Enforced by the engine, also under concurrency: a concurrent insert waits
    -- for the first transaction and then fails (SQLSTATE 23P01 -> API 409).
    -- '[)' = start included, end excluded: back-to-back appointments are allowed.
    CONSTRAINT no_overlap_professional EXCLUDE USING gist (
        professional_id                     WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'booked'),
    -- I2: a patient never has two active appointments that overlap
    -- (a patient row belongs to one clinic, so this is per clinic).
    CONSTRAINT no_overlap_patient EXCLUDE USING gist (
        patient_id                          WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
    ) WHERE (status = 'booked')
);


-- ---------------------------------------------------------------------
-- RF13: from 'booked' an appointment may move to attended, no_show,
-- cancelled or rescheduled; the four final states admit no transition.
-- RF12 (outcome only after the start time) and I3 (inside working hours,
-- outside blocks) are checked by the API inside the booking transaction.
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
-- clinical_note: RF15 - the most sensitive data of the system
-- One note per appointment, editable. The composite FK forces the note to
-- point to an ATTENDED appointment of the SAME professional and clinic.
-- Attended is a final state (RF13 trigger), so it cannot change afterwards.
-- That the requester IS that professional is checked by the API (token).
-- Every read and write is recorded in audit_log (RF18).
-- ---------------------------------------------------------------------
CREATE TABLE clinical_note (
    clinical_note_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id     UUID        NOT NULL UNIQUE,      -- one note per appointment
    clinic_id          UUID        NOT NULL,
    professional_id    UUID        NOT NULL,
    appointment_status VARCHAR(16) NOT NULL DEFAULT 'attended'
                       CHECK (appointment_status = 'attended'),  -- deliberate denormalization for the FK
    content            TEXT        NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (appointment_id, clinic_id, professional_id, appointment_status)
        REFERENCES appointment (appointment_id, clinic_id, professional_id, status)
);


-- ---------------------------------------------------------------------
-- audit_log: RF18, RF19 - append-only (I6)
-- Records who, what, about which patient and when, for every read and
-- write of clinical notes and patient contact data.
-- It NEVER stores the content of a note: the clinic admin reads this log
-- (RF19) but is not allowed to read clinical notes.
-- Protected by the engine: a trigger rejects UPDATE, DELETE and TRUNCATE;
-- the API database role will also lack UPDATE/DELETE (least privilege).
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id    UUID        NOT NULL,                       -- RF19: each admin sees only their clinic
    app_user_id  UUID        NOT NULL,                       -- who
    patient_id   UUID        NOT NULL,                       -- about which patient
    action       VARCHAR(16) NOT NULL
                 CHECK (action IN ('read', 'create', 'update')),                    -- what
    resource     VARCHAR(32) NOT NULL
                 CHECK (resource IN ('clinical_note', 'patient_contact')),
    resource_id  UUID        NOT NULL,                       -- id of the note or the patient
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),         -- when
    FOREIGN KEY (app_user_id, clinic_id) REFERENCES app_user (app_user_id, clinic_id),
    FOREIGN KEY (patient_id, clinic_id)  REFERENCES patient (patient_id, clinic_id)
);

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
