// Card E10: every index justified by the plan of the query it serves (core module 8).
//
//   TEST_DATABASE_URL=postgres://… npm run explain:indexes -w services/appointments-service
//
// Loads appointments_db and logs_db with a realistic volume (3 clinics, 15 professionals
// each, two years of appointments, a busy audit log), then runs the real queries of RF7,
// RF8, RF16, RF19, RF20 and RF21 as medicitas_app, with RLS on, twice:
//
//   before  the indexes of the schema before card E10, and the queries as they were
//   after   the schema in init.sql now, and the queries as the services send them now
//
// and prints EXPLAIN (ANALYZE, BUFFERS) for each one as Markdown (docs/indexes.md).

import { readFileSync } from 'node:fs';
import pg from 'pg';

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error('Set TEST_DATABASE_URL.');
  process.exit(1);
}
const RUNS = Number(process.env.EXPLAIN_RUNS ?? 5);

const CLINICS = ['0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01', '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02', '7d2b4f6a-8c1e-4a3d-9b5f-2e7c1a9d4b03'];
const CLINIC = CLINICS[0]!;
const USER = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
// Deterministic ids, the same expressions the seed below uses.
const uuidOf = (text: string) => `md5('${text}')::uuid`;

// ---------------------------------------------------------------------------------------
// Schema states
// ---------------------------------------------------------------------------------------

/** The indexes card E10 removes or replaces, as they were in init.sql before. */
const BEFORE_INDEXES = {
  appointments: `
    DROP INDEX IF EXISTS idx_appointment_professional_starts_at, idx_appointment_clinic_starts_at,
                         idx_appointment_patient_starts_at, idx_schedule_block_professional_starts_at;
    CREATE INDEX IF NOT EXISTS idx_working_hours_clinic_id ON working_hours (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_working_hours_professional_id ON working_hours (professional_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_block_clinic_id ON schedule_block (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_block_professional_id ON schedule_block (professional_id);
    CREATE INDEX IF NOT EXISTS idx_prof_service_professional_id ON professional_service (professional_id);
    CREATE INDEX IF NOT EXISTS idx_prof_service_clinic_id ON professional_service (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_clinic_id ON appointment (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_professional_id ON appointment (professional_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_patient_id ON appointment (patient_id);
    CREATE INDEX IF NOT EXISTS idx_appointment_status ON appointment (status);
    CREATE INDEX IF NOT EXISTS idx_clinical_note_appointment_id ON clinical_note (appointment_id);
    CREATE INDEX IF NOT EXISTS idx_clinical_note_clinic_id ON clinical_note (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_clinical_note_professional_id ON clinical_note (professional_id);`,
  logs: `
    DROP INDEX IF EXISTS idx_audit_log_clinic_occurred_at, idx_audit_log_clinic_patient, idx_audit_log_clinic_user;
    CREATE INDEX IF NOT EXISTS idx_audit_log_clinic_id ON audit_log (clinic_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_app_user_id ON audit_log (app_user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_patient_id ON audit_log (patient_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log (occurred_at);`,
};

// ---------------------------------------------------------------------------------------
// Seed: realistic volume, every row valid under the real constraints
// ---------------------------------------------------------------------------------------

const SEED_APPOINTMENTS = `
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

const SEED_LOGS = `
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

// ---------------------------------------------------------------------------------------
// Queries, as the services send them (with RLS adding clinic_id = app_current_clinic_id())
// ---------------------------------------------------------------------------------------

interface Query {
  id: string; title: string; db: 'appointments' | 'logs'; before: string; after: string;
  /** Runs as this professional instead of clinic_admin (clinical notes are only theirs). */
  asProfessional?: boolean;
}

const PROF = uuidOf(`prof-${CLINIC}-3`);
const PROFS = [3, 8, 13].map((n) => uuidOf(`prof-${CLINIC}-${n}`)).join(', ');
const PATIENT = uuidOf(`patient-${CLINIC}-700`);
const SERVICE = uuidOf(`service-${CLINIC}-3`);
const DAY = `'2027-03-10T06:00:00Z'::timestamptz`;
const NEXT_DAY = `'2027-03-11T06:00:00Z'::timestamptz`;
const WEEK_END = `'2027-03-17T06:00:00Z'::timestamptz`;
/** The lower bound the services add now (domain/appointment-bounds.ts). */
const SINCE = (from: string) => `starts_at > ${from} - interval '1 day'`;
const AGENDA = 'appointment_id, professional_id, patient_id, service_id, starts_at, ends_at, status';
const same = (sql: string) => ({ before: sql, after: sql });

const QUERIES: Query[] = [
  {
    id: 'rf7-appointments', db: 'appointments',
    title: 'RF7 · booked appointments of one professional on one day',
    before: `SELECT professional_id, starts_at, ends_at FROM appointment
             WHERE professional_id IN (${PROF}) AND status = 'booked' AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}`,
    after: `SELECT professional_id, starts_at, ends_at FROM appointment
            WHERE professional_id IN (${PROF}) AND status = 'booked' AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}
              AND ${SINCE(DAY)}`,
  },
  {
    id: 'rf8-appointments', db: 'appointments',
    title: 'RF8 · booked appointments of three professionals over a week',
    before: `SELECT professional_id, starts_at, ends_at FROM appointment
             WHERE professional_id IN (${PROFS}) AND status = 'booked' AND starts_at < ${WEEK_END} AND ends_at > ${DAY}`,
    after: `SELECT professional_id, starts_at, ends_at FROM appointment
            WHERE professional_id IN (${PROFS}) AND status = 'booked' AND starts_at < ${WEEK_END} AND ends_at > ${DAY}
              AND ${SINCE(DAY)}`,
  },
  {
    id: 'rf7-blocks', db: 'appointments', title: 'RF7 · blocks of one professional on one day',
    ...same(`SELECT professional_id, starts_at, ends_at FROM schedule_block
             WHERE professional_id IN (${PROF}) AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}`),
  },
  {
    id: 'rf7-working-hours', db: 'appointments', title: 'RF7 · weekly working hours of one professional',
    ...same(`SELECT professional_id, weekday, start_time, end_time FROM working_hours WHERE professional_id IN (${PROF})`),
  },
  {
    id: 'rf7-offered', db: 'appointments', title: 'RF7/RF9 · does the professional offer the service',
    ...same(`SELECT 1 FROM professional_service WHERE professional_id = ${PROF} AND service_id = ${SERVICE} LIMIT 1`),
  },
  {
    id: 'rf8-offering', db: 'appointments', title: 'RF8 · professionals who offer a service',
    ...same(`SELECT professional_id FROM professional_service WHERE service_id = ${SERVICE}`),
  },
  {
    id: 'rf20-clinic', db: 'appointments',
    title: 'RF20 · agenda of the whole clinic for one day',
    before: `SELECT ${AGENDA} FROM appointment
             WHERE clinic_id = '${CLINIC}' AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}
             ORDER BY starts_at, professional_id, appointment_id`,
    after: `SELECT ${AGENDA} FROM appointment
            WHERE clinic_id = '${CLINIC}' AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY} AND ${SINCE(DAY)}
            ORDER BY starts_at, professional_id, appointment_id`,
  },
  {
    id: 'rf20-professional', db: 'appointments',
    title: 'RF20 · agenda of one professional for one day',
    before: `SELECT ${AGENDA} FROM appointment
             WHERE clinic_id = '${CLINIC}' AND professional_id = ${PROF} AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}
             ORDER BY starts_at, professional_id, appointment_id`,
    after: `SELECT ${AGENDA} FROM appointment
            WHERE clinic_id = '${CLINIC}' AND professional_id = ${PROF} AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}
              AND ${SINCE(DAY)}
            ORDER BY starts_at, professional_id, appointment_id`,
  },
  {
    id: 'rf16', db: 'appointments', title: 'RF16 · appointment history of one patient',
    ...same(`SELECT appointment_id, professional_id, service_id, starts_at, ends_at, status, rescheduled_from_id FROM appointment
             WHERE clinic_id = '${CLINIC}' AND patient_id = ${PATIENT} ORDER BY starts_at DESC, appointment_id DESC`),
  },
  {
    id: 'rf21', db: 'appointments', title: 'RF21 · appointments by status in one month',
    ...same(`SELECT status, count(*) FROM appointment
             WHERE clinic_id = '${CLINIC}' AND starts_at >= '2027-03-01T06:00:00Z' AND starts_at < '2027-04-01T06:00:00Z'
             GROUP BY status`),
  },
  {
    id: 'rf15', db: 'appointments', title: 'RF15 · clinical note of one appointment', asProfessional: true,
    ...same(`SELECT * FROM clinical_note WHERE appointment_id = '{{NOTE_APPOINTMENT}}' LIMIT 1`),
  },
  {
    id: 'rf19-patient', db: 'logs', title: 'RF19 · audit log of one patient',
    ...same(`SELECT * FROM audit_log WHERE clinic_id = '${CLINIC}' AND patient_id = ${uuidOf(`patient-${CLINIC}-4242`)}
             ORDER BY occurred_at, audit_log_id`),
  },
  {
    id: 'rf19-user-week', db: 'logs', title: 'RF19 · audit log of one user in one week',
    ...same(`SELECT * FROM audit_log WHERE clinic_id = '${CLINIC}' AND app_user_id = ${uuidOf(`user-${CLINIC}-7`)}
             AND occurred_at >= '2026-10-01' AND occurred_at < '2026-10-08' ORDER BY occurred_at, audit_log_id`),
  },
  {
    id: 'rf19-day', db: 'logs', title: 'RF19 · whole audit log of the clinic for one day',
    ...same(`SELECT * FROM audit_log WHERE clinic_id = '${CLINIC}'
             AND occurred_at >= '2026-10-01' AND occurred_at < '2026-10-02' ORDER BY occurred_at, audit_log_id`),
  },
];

// ---------------------------------------------------------------------------------------

async function createDatabase(label: string, schemaFile: string): Promise<{ pool: pg.Pool; drop: () => Promise<void> }> {
  const name = `medicitas_${label}_${process.pid}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(adminUrl!);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
  await pool.query(readFileSync(new URL(`../../../database/${schemaFile}/init.sql`, import.meta.url), 'utf8'));
  return {
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}

interface PlanNode { 'Node Type': string; 'Index Name'?: string; Plans?: PlanNode[] }
interface Measured { ms: number; sharedHit: number; sharedRead: number; nodes: string; text: string }

function describeNodes(node: PlanNode): string[] {
  const own = node['Index Name'] ? `${node['Node Type']} (${node['Index Name']})` : node['Node Type'];
  return [own, ...(node.Plans ?? []).flatMap(describeNodes)];
}

/** EXPLAIN as medicitas_app with the clinic context loaded, so RLS is part of the plan. */
let note = { appointmentId: '', professionalId: '' };

async function explain(pool: pg.Pool, query: Query, phase: 'before' | 'after'): Promise<Measured> {
  const sql = query[phase].replace('{{NOTE_APPOINTMENT}}', note.appointmentId);
  const context = query.asProfessional
    ? `'${CLINIC}', '${USER}', 'professional', '${note.professionalId}'`
    : `'${CLINIC}', '${USER}', 'clinic_admin', NULL`;
  const client = await pool.connect();
  try {
    const run = async <T>(statement: string): Promise<T> => {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query(`SELECT app_set_session_context(${context}, true)`);
        await client.query('SET LOCAL ROLE medicitas_app');
        return (await client.query(statement)).rows as T;
      } finally {
        await client.query('ROLLBACK');
      }
    };
    const timings: number[] = [];
    let json: { Plan: PlanNode & { 'Shared Hit Blocks': number; 'Shared Read Blocks': number }; 'Execution Time': number } | undefined;
    for (let i = 0; i < RUNS; i += 1) {
      const rows = await run<Array<{ 'QUERY PLAN': Array<typeof json> }>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      json = rows[0]!['QUERY PLAN'][0]!;
      timings.push(json!['Execution Time']);
    }
    const text = (await run<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`))
      .map((r) => r['QUERY PLAN']).join('\n');
    timings.sort((a, b) => a - b);
    return {
      ms: timings[Math.floor(timings.length / 2)]!,
      sharedHit: json!.Plan['Shared Hit Blocks'],
      sharedRead: json!.Plan['Shared Read Blocks'],
      nodes: [...new Set(describeNodes(json!.Plan))].join(' → '),
      text,
    };
  }
  finally {
    client.release();
  }
}

const appointments = await createDatabase('explain_appt', 'appointments');
const logs = await createDatabase('explain_logs', 'logs');
try {
  console.error('Seeding (a few seconds)...');
  await appointments.pool.query(SEED_APPOINTMENTS);
  await logs.pool.query(SEED_LOGS);
  const pools = { appointments: appointments.pool, logs: logs.pool };
  const [found] = (await appointments.pool.query(
    `SELECT appointment_id, professional_id FROM clinical_note WHERE clinic_id = $1 ORDER BY appointment_id LIMIT 1`, [CLINIC])).rows;
  note = { appointmentId: found.appointment_id, professionalId: found.professional_id };
  const counts = (await appointments.pool.query(`SELECT (SELECT count(*) FROM appointment) AS a, (SELECT count(*) FROM schedule_block) AS b`)).rows[0];
  const audit = (await logs.pool.query('SELECT count(*) AS n FROM audit_log')).rows[0];

  const results: Record<string, { before: Measured; after: Measured }> = {};
  const indexSize = async () => (await appointments.pool.query(
    `SELECT pg_size_pretty(sum(pg_relation_size(indexrelid))) AS size, count(*) AS n FROM pg_index WHERE indrelid = 'appointment'::regclass`)).rows[0];

  // before: the old indexes, old queries
  for (const [db, sql] of Object.entries(BEFORE_INDEXES)) await pools[db as keyof typeof pools].query(sql);
  for (const pool of Object.values(pools)) await pool.query('VACUUM ANALYZE');
  const sizeBefore = await indexSize();
  for (const q of QUERIES) results[q.id] = { before: await explain(pools[q.db], q, 'before'), after: undefined as unknown as Measured };

  // after: rebuild the indexes exactly as init.sql has them now
  for (const [db, file] of [['appointments', 'appointments'], ['logs', 'logs']] as const) {
    const schema = readFileSync(new URL(`../../../database/${file}/init.sql`, import.meta.url), 'utf8');
    const creates = schema.match(/^CREATE INDEX[^;]+;/gm) ?? [];
    const drops = (await pools[db].query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx\\_%'`)).rows
      .map((r) => r.indexname as string)
      .filter((name) => !creates.some((c) => c.includes(` ${name} `)));
    for (const name of drops) await pools[db].query(`DROP INDEX ${name}`);
    for (const create of creates) await pools[db].query(create.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));
  }
  for (const pool of Object.values(pools)) await pool.query('VACUUM ANALYZE');
  const sizeAfter = await indexSize();
  for (const q of QUERIES) results[q.id]!.after = await explain(pools[q.db], q, 'after');

  // Markdown report
  const out: string[] = [];
  out.push(`Data: ${counts.a} appointments, ${counts.b} blocks, ${audit.n} audit events; median of ${RUNS} runs.`);
  out.push(`Indexes on \`appointment\`: ${sizeBefore.n} (${sizeBefore.size}) before, ${sizeAfter.n} (${sizeAfter.size}) after.\n`);
  out.push('| Query | Before | After | Before: plan | After: plan |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const q of QUERIES) {
    const { before, after } = results[q.id]!;
    const cell = (m: Measured) => `${m.ms.toFixed(2)} ms, ${m.sharedHit + m.sharedRead} buffers`;
    out.push(`| ${q.title} | ${cell(before)} | ${cell(after)} | ${before.nodes} | ${after.nodes} |`);
  }
  for (const q of QUERIES) {
    out.push(`\n### ${q.title}\n`);
    out.push('Before:\n\n```text\n' + results[q.id]!.before.text + '\n```\n');
    out.push('After:\n\n```text\n' + results[q.id]!.after.text + '\n```');
  }
  console.log(out.join('\n'));
} finally {
  if (process.env.EXPLAIN_KEEP === '1') {
    console.error(`Kept databases medicitas_explain_appt_${process.pid} and medicitas_explain_logs_${process.pid}.`);
    process.exit(0);
  }
  await appointments.drop();
  await logs.drop();
}
