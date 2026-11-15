// Realistic volume for the measurement scripts (explain-indexes.ts, measure-rls.ts):
// 3 clinics, 15 professionals each, two years of appointments and a busy audit log,
// loaded into throwaway databases built from the real init.sql files.

import { readFileSync } from 'node:fs';
import pg from 'pg';

export const CLINICS = ['0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01', '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02', '7d2b4f6a-8c1e-4a3d-9b5f-2e7c1a9d4b03'];
export const CLINIC = CLINICS[0]!;
export const USER = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
// Deterministic ids, the same expressions the seed below uses.
export const uuidOf = (text: string) => `md5('${text}')::uuid`;

// ---------------------------------------------------------------------------------------
// Seed: realistic volume, every row valid under the real constraints
// ---------------------------------------------------------------------------------------

export const SEED_APPOINTMENTS = `
  -- 15 professionals per clinic, Monday to Friday 08:00-12:00 and 13:00-17:00 (UTC).
  CREATE TEMP TABLE prof AS
    SELECT c.clinic_id, p.n, md5('prof-' || c.clinic_id || '-' || p.n)::uuid AS professional_id
    FROM unnest(ARRAY[${CLINICS.map((c) => `'${c}'::uuid`).join(', ')}]) AS c(clinic_id), generate_series(0, 14) AS p(n);

  INSERT INTO working_hours (clinic_id, professional_id, weekday, start_time, end_time)
  SELECT clinic_id, professional_id, d, t.s, t.e
  FROM prof, generate_series(1, 5) AS d, (VALUES ('08:00'::time, '12:00'::time), ('13:00', '17:00')) AS t(s, e);

  INSERT INTO professional_service (clinic_id, professional_id, service_id, specialty_id)
  SELECT clinic_id, professional_id, md5('service-' || clinic_id || '-' || (n % 5))::uuid, md5('specialty-' || (n % 5))::uuid
  FROM prof;

  -- Two years of appointments: 2025-11-17 to 2027-11-15, weekdays, 14 slots of 30 min a day.
  -- Past ones carry their outcome; future ones are mostly booked. At any instant a patient
  -- has at most one appointment per clinic, so both EXCLUDE constraints hold.
  INSERT INTO appointment (clinic_id, appointment_id, professional_id, patient_id, service_id,
                           starts_at, ends_at, duration_minutes, status, created_by)
  SELECT p.clinic_id,
         md5('appt-' || p.professional_id || '-' || d.day || '-' || s.slot)::uuid,
         p.professional_id,
         md5('patient-' || p.clinic_id || '-' || ((p.n + s.slot * 15 + d.i * 7) % 20000))::uuid,
         md5('service-' || p.clinic_id || '-' || (p.n % 5))::uuid,
         d.day + make_interval(mins => 480 + s.slot * 30 + CASE WHEN s.slot >= 8 THEN 60 ELSE 0 END),
         d.day + make_interval(mins => 510 + s.slot * 30 + CASE WHEN s.slot >= 8 THEN 60 ELSE 0 END),
         30,
         CASE
           WHEN d.day >= '2026-11-16' THEN CASE WHEN hashtext(p.professional_id::text || d.i || s.slot) % 7 = 0 THEN 'cancelled' ELSE 'booked' END
           ELSE (ARRAY['attended','attended','attended','attended','attended','attended','attended','attended',
                       'no_show','cancelled','rescheduled'])[1 + abs(hashtext(p.professional_id::text || d.i || s.slot)) % 11]
         END,
         '${USER}'
  FROM prof p,
       (SELECT day, row_number() OVER (ORDER BY day) AS i
        FROM generate_series('2025-11-17'::timestamptz, '2027-11-15', interval '1 day') AS day
        WHERE extract(isodow FROM day) <= 5) AS d,
       generate_series(0, 13) AS s(slot);

  -- A clinical note for a third of the attended appointments.
  INSERT INTO clinical_note (clinic_id, appointment_id, professional_id, content)
  SELECT clinic_id, appointment_id, professional_id, 'Consulta de control sin hallazgos.'
  FROM appointment WHERE status = 'attended' AND abs(hashtext(appointment_id::text)) % 3 = 0;

  -- A one-day block twice a month per professional.
  INSERT INTO schedule_block (clinic_id, professional_id, starts_at, ends_at, reason)
  SELECT clinic_id, professional_id, day + interval '8 hours', day + interval '17 hours', 'Permiso'
  FROM prof, generate_series('2025-11-20'::timestamptz, '2027-11-15', interval '15 days') AS day;
`;

export const SEED_LOGS = `
  -- 400 000 audit events per clinic over two years: 20 000 patients, 50 users.
  INSERT INTO audit_log (clinic_id, app_user_id, patient_id, action, resource, resource_id, occurred_at)
  SELECT c.clinic_id,
         md5('user-' || c.clinic_id || '-' || (g % 50))::uuid,
         md5('patient-' || c.clinic_id || '-' || (g % 20000))::uuid,
         (ARRAY['read', 'read', 'read', 'create', 'update'])[1 + g % 5],
         (ARRAY['clinical_note', 'patient_contact'])[1 + g % 2],
         md5('resource-' || g)::uuid,
         '2025-11-17'::timestamptz + (g * interval '157 seconds')
  FROM unnest(ARRAY[${CLINICS.map((c) => `'${c}'::uuid`).join(', ')}]) AS c(clinic_id), generate_series(1, 400000) AS g;
`;

export async function createDatabase(adminUrl: string, label: string, schemaFile: 'appointments' | 'logs'): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `medicitas_${label}_${process.pid}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
  await pool.query(readFileSync(new URL(`../../../../database/${schemaFile}/init.sql`, import.meta.url), 'utf8'));
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}

export interface PlanNode { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] }

export function describeNodes(node: PlanNode): string[] {
  const own = node['Index Name'] ? `${node['Node Type']} (${node['Index Name']})` : node['Node Type'];
  return [own, ...(node.Plans ?? []).flatMap(describeNodes)];
}
