-- =====================================================================
-- MediCitas - Logs Database Seed Data
-- Runs automatically after init.sql in /docker-entrypoint-initdb.d
-- IDs are aligned with users_db and appointments_db.
-- =====================================================================

INSERT INTO audit_log (
    clinic_id, audit_log_id, app_user_id, patient_id, action, resource, resource_id, occurred_at
) VALUES
    (
        '019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000a01',
        '019a0000-0000-7000-8000-000000000404', '019a0000-0000-7000-8000-000000000601',
        'create', 'clinical_note', '019a0000-0000-7000-8000-000000000901', '2026-11-10T14:36:00Z'
    ),
    (
        '019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000a02',
        '019a0000-0000-7000-8000-000000000403', '019a0000-0000-7000-8000-000000000601',
        'read', 'patient_contact', '019a0000-0000-7000-8000-000000000601', '2026-11-12T15:50:00Z'
    )
ON CONFLICT (clinic_id, audit_log_id) DO NOTHING;
