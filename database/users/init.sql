-- =====================================================================
-- MediCitas - Users Database - Microservice: Users
-- Engine: PostgreSQL 17
-- =====================================================================

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
    app_user_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    professional_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id       UUID         NOT NULL,                     -- Logical reference to Clinics Service
    app_user_id     UUID         NOT NULL UNIQUE REFERENCES app_user (app_user_id),
    full_name       VARCHAR(128) NOT NULL,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_professional_clinic_id ON professional (clinic_id);

-- ---------------------------------------------------------------------
-- professional_specialty: a professional may have several specialties (N:M)
-- specialty_id is a logical reference to the specialty catalog in Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE professional_specialty (
    professional_id UUID NOT NULL REFERENCES professional (professional_id),
    specialty_id    UUID NOT NULL,                             -- Logical reference to Clinics Service
    PRIMARY KEY (professional_id, specialty_id)
);

CREATE INDEX idx_professional_specialty_specialty_id ON professional_specialty (specialty_id);

-- ---------------------------------------------------------------------
-- patient: clinic patient registry
-- clinic_id is a logical reference to Clinics Service
-- ---------------------------------------------------------------------
CREATE TABLE patient (
    patient_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id      UUID         NOT NULL,                      -- Logical reference to Clinics Service
    identification VARCHAR(32)  NOT NULL,                      -- national id / passport
    full_name      VARCHAR(128) NOT NULL,
    birth_date     DATE         NOT NULL,
    phone          VARCHAR(32),
    email          VARCHAR(128),
    UNIQUE (clinic_id, identification)
);

CREATE INDEX idx_patient_clinic_id ON patient (clinic_id);
