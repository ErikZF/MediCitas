-- =====================================================================
-- MediCitas - Logs Database - Microservice: Logs & Audit
-- Engine: PostgreSQL 17
-- =====================================================================

-- ---------------------------------------------------------------------
-- audit_log: RF18, RF19 - append-only (I6)
-- Records who, what, about which patient and when, for every read and
-- write of clinical notes and patient contact data.
-- Protected by the engine: a trigger rejects UPDATE, DELETE and TRUNCATE.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
    audit_log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clinic_id    UUID        NOT NULL,                       -- Logical reference to Clinics Service
    app_user_id  UUID        NOT NULL,                       -- Logical reference to Users Service
    patient_id   UUID        NOT NULL,                       -- Logical reference to Users Service
    action       VARCHAR(16) NOT NULL
                 CHECK (action IN ('read', 'create', 'update')),
    resource     VARCHAR(32) NOT NULL
                 CHECK (resource IN ('clinical_note', 'patient_contact')),
    resource_id  UUID        NOT NULL,                       -- id of the note or the patient
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
