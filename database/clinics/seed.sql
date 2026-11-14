-- =====================================================================
-- MediCitas - Clinics Database Seed Data
-- Runs automatically after init.sql in /docker-entrypoint-initdb.d
-- =====================================================================

INSERT INTO clinic (clinic_id, identifier, name, time_zone, is_active) VALUES
    ('019a0000-0000-7000-8000-000000000101', 'clinic-sj-01',    'Central San Jose Clinic',  'America/Costa_Rica', true),
    ('019a0000-0000-7000-8000-000000000102', 'clinic-curri-02', 'East Curridabat Clinic',   'America/Costa_Rica', true)
ON CONFLICT (clinic_id) DO NOTHING;

INSERT INTO specialty (specialty_id, name) VALUES
    ('019a0000-0000-7000-8000-000000000201', 'General Medicine'),
    ('019a0000-0000-7000-8000-000000000202', 'Cardiology'),
    ('019a0000-0000-7000-8000-000000000203', 'Pediatrics'),
    ('019a0000-0000-7000-8000-000000000204', 'Dermatology')
ON CONFLICT (specialty_id) DO NOTHING;

INSERT INTO service (clinic_id, service_id, specialty_id, name, duration_minutes, is_active) VALUES
    ('019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000301', '019a0000-0000-7000-8000-000000000201', 'General Consultation',   30, true),
    ('019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000302', '019a0000-0000-7000-8000-000000000202', 'Cardiology Evaluation',  45, true),
    ('019a0000-0000-7000-8000-000000000101', '019a0000-0000-7000-8000-000000000303', '019a0000-0000-7000-8000-000000000203', 'Pediatric Checkup',      30, true),
    ('019a0000-0000-7000-8000-000000000102', '019a0000-0000-7000-8000-000000000304', '019a0000-0000-7000-8000-000000000201', 'General Consultation',   30, true),
    ('019a0000-0000-7000-8000-000000000102', '019a0000-0000-7000-8000-000000000305', '019a0000-0000-7000-8000-000000000204', 'Dermatology Screening',  30, true)
ON CONFLICT (clinic_id, service_id) DO NOTHING;
