-- =====================================================================
-- MediCitas - Clinics Database - Microservice: Clinics
-- Engine: PostgreSQL 17
-- =====================================================================

-- --------------------------------------------------------------------
-- clinic
-- --------------------------------------------------------------------
CREATE TABLE clinic (
    clinic_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier VARCHAR(32)  NOT NULL UNIQUE,
    name       VARCHAR(128) NOT NULL,
    time_zone  TEXT         NOT NULL,
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE
);

-- --------------------------------------------------------------------
-- specialty: global catalog shared by every clinic
-- --------------------------------------------------------------------
CREATE TABLE specialty (
    specialty_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name         VARCHAR(128) NOT NULL UNIQUE
);

-- --------------------------------------------------------------------
-- service: clinic catalog
-- --------------------------------------------------------------------
CREATE TABLE service (
    service_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id        UUID NOT NULL REFERENCES clinic (clinic_id),
    specialty_id     UUID NOT NULL REFERENCES specialty (specialty_id),
    name             VARCHAR(128) NOT NULL,
    duration_minutes INT  NOT NULL CHECK (duration_minutes > 0),
    UNIQUE (clinic_id, name)
);

CREATE INDEX idx_service_clinic_id ON service (clinic_id);
CREATE INDEX idx_service_specialty_id ON service (specialty_id);
