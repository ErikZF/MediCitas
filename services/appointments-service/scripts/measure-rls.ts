// Module for groups of three, option 2: Row-Level Security as a second multi-tenancy
// strategy, compared with the discriminator column on the same queries.
//
//   TEST_DATABASE_URL=postgres://… npm run measure:rls -w services/appointments-service
//
// Loads the same volume as explain-indexes.ts (scripts/lib/volume.ts) and runs every query
// three ways against the same data and the same indexes:
//
//   column  the query carries clinic_id = '<clinic>' (and the professional, for notes);
//           RLS is bypassed with a role that has BYPASSRLS. Isolation lives in the code.
//   rls     the query has no tenant filter at all; only the policies of init.sql keep the
//           other clinics out, from the context set by app_set_session_context().
//   both    what the services do: the filter in the query and the policies in the engine.
//
// Then it rewrites the policies of the throwaway databases so that every context function
// is wrapped in a scalar subquery, `(SELECT app_current_role())`, and measures `rls` and
// `both` again. PostgreSQL evaluates such a subquery once per query (an InitPlan) instead
// of once per row; init.sql is not touched.
//
// For each one it prints the median time, the buffers, the plan and the rows returned, and
// checks that every way returns the same rows. Output: Markdown (docs/rls-comparison.md).

import type pg from 'pg';
import { CLINIC, CLINICS, createDatabase, describeNodes, type PlanNode, SEED_APPOINTMENTS, SEED_LOGS, USER, uuidOf } from './lib/volume.ts';

const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  console.error('Set TEST_DATABASE_URL.');
  process.exit(1);
}
const RUNS = Number(process.env.MEASURE_RUNS ?? 7);

/** A role that keeps every privilege of medicitas_app but is not subject to RLS. */
const NO_RLS_ROLE = 'medicitas_measure_norls';

type Strategy = 'column' | 'rls' | 'both' | 'rls-cached' | 'both-cached';
const STRATEGIES: Strategy[] = ['column', 'rls', 'both'];
const CACHED: Strategy[] = ['rls-cached', 'both-cached'];
const ALL: Strategy[] = [...STRATEGIES, ...CACHED];

interface Query {
  id: string;
  title: string;
  db: 'appointments' | 'logs';
  /** `{{T}}` marks where the tenant filter goes, `{{P}}` the professional filter of notes. */
  sql: string;
  asProfessional?: boolean;
}

const PROF = uuidOf(`prof-${CLINIC}-3`);
const PROFS = [3, 8, 13].map((n) => uuidOf(`prof-${CLINIC}-${n}`)).join(', ');
const PATIENT = uuidOf(`patient-${CLINIC}-700`);
const SERVICE = uuidOf(`service-${CLINIC}-3`);
const DAY = `'2027-03-10T06:00:00Z'::timestamptz`;
const NEXT_DAY = `'2027-03-11T06:00:00Z'::timestamptz`;
const WEEK_END = `'2027-03-17T06:00:00Z'::timestamptz`;
const SINCE = (from: string) => `starts_at > ${from} - interval '1 day'`;
const AGENDA = 'appointment_id, professional_id, patient_id, service_id, starts_at, ends_at, status';

const QUERIES: Query[] = [
  {
    id: 'rf7-appointments', db: 'appointments', title: 'RF7 · booked appointments of one professional on one day',
    sql: `SELECT professional_id, starts_at, ends_at FROM appointment
          WHERE {{T}} professional_id IN (${PROF}) AND status = 'booked'
            AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY} AND ${SINCE(DAY)}`,
  },
  {
    id: 'rf8-appointments', db: 'appointments', title: 'RF8 · booked appointments of three professionals over a week',
    sql: `SELECT professional_id, starts_at, ends_at FROM appointment
          WHERE {{T}} professional_id IN (${PROFS}) AND status = 'booked'
            AND starts_at < ${WEEK_END} AND ends_at > ${DAY} AND ${SINCE(DAY)}`,
  },
  {
    id: 'rf7-blocks', db: 'appointments', title: 'RF7 · blocks of one professional on one day',
    sql: `SELECT professional_id, starts_at, ends_at FROM schedule_block
          WHERE {{T}} professional_id IN (${PROF}) AND starts_at < ${NEXT_DAY} AND ends_at > ${DAY}`,
  },
  {
    id: 'rf7-working-hours', db: 'appointments', title: 'RF7 · weekly working hours of one professional',
    sql: `SELECT professional_id, weekday, start_time, end_time FROM working_hours WHERE {{T}} professional_id IN (${PROF})`,
  },
  {
    id: 'rf8-offering', db: 'appointments', title: 'RF8 · professionals who offer a service',
    sql: `SELECT professional_id FROM professional_service WHERE {{T}} service_id = ${SERVICE}`,
  },
  {
    id: 'rf20-clinic', db: 'appointments', title: 'RF20 · agenda of the whole clinic for one day',
    sql: `SELECT ${AGENDA} FROM appointment
          WHERE {{T}} starts_at < ${NEXT_DAY} AND ends_at > ${DAY} AND ${SINCE(DAY)}
          ORDER BY starts_at, professional_id, appointment_id`,
  },
  {
    id: 'rf16', db: 'appointments', title: 'RF16 · appointment history of one patient',
    sql: `SELECT appointment_id, professional_id, service_id, starts_at, ends_at, status, rescheduled_from_id FROM appointment
          WHERE {{T}} patient_id = ${PATIENT} ORDER BY starts_at DESC, appointment_id DESC`,
  },
  {
    id: 'rf21', db: 'appointments', title: 'RF21 · appointments by status in one month',
    sql: `SELECT status, count(*) FROM appointment
          WHERE {{T}} starts_at >= '2027-03-01T06:00:00Z' AND starts_at < '2027-04-01T06:00:00Z' GROUP BY status`,
  },
  {
    id: 'rf15', db: 'appointments', title: 'RF15 · clinical note of one appointment', asProfessional: true,
    sql: `SELECT * FROM clinical_note WHERE {{T}} {{P}} appointment_id = '{{NOTE_APPOINTMENT}}' LIMIT 1`,
  },
  {
    id: 'rf19-patient', db: 'logs', title: 'RF19 · audit log of one patient',
    sql: `SELECT * FROM audit_log WHERE {{T}} patient_id = ${uuidOf(`patient-${CLINIC}-4242`)} ORDER BY occurred_at, audit_log_id`,
  },
  {
    id: 'rf19-day', db: 'logs', title: 'RF19 · whole audit log of the clinic for one day',
    sql: `SELECT * FROM audit_log WHERE {{T}} occurred_at >= '2026-10-01' AND occurred_at < '2026-10-02' ORDER BY occurred_at, audit_log_id`,
  },
];

let note = { appointmentId: '', professionalId: '' };

function sqlFor(query: Query, strategy: Strategy): string {
  const filtered = strategy === 'column' || strategy.startsWith('both');
  return query.sql
    .replace('{{T}}', filtered ? `clinic_id = '${CLINIC}' AND` : '')
    .replace('{{P}}', filtered ? `professional_id = '${note.professionalId}' AND` : '')
    .replace('{{NOTE_APPOINTMENT}}', note.appointmentId);
}

interface Measured { ms: number; buffers: number; rows: number; nodes: string; text: string }

async function measure(pool: pg.Pool, query: Query, strategy: Strategy): Promise<Measured> {
  const sql = sqlFor(query, strategy);
  const context = query.asProfessional
    ? `'${CLINIC}', '${USER}', 'professional', '${note.professionalId}'`
    : `'${CLINIC}', '${USER}', 'clinic_admin', NULL`;
  const client = await pool.connect();
  const run = async <T>(statement: string): Promise<T> => {
    await client.query('BEGIN READ ONLY');
    try {
      if (strategy === 'column') {
        // No tenant context at all: nothing but the WHERE of the query separates clinics.
        await client.query(`SET LOCAL ROLE ${NO_RLS_ROLE}`);
      } else {
        await client.query(`SELECT app_set_session_context(${context}, true)`);
        await client.query('SET LOCAL ROLE medicitas_app');
      }
      return (await client.query(statement)).rows as T;
    } finally {
      await client.query('ROLLBACK');
    }
  };
  try {
    type Plan = PlanNode & { 'Shared Hit Blocks': number; 'Shared Read Blocks': number; 'Actual Rows': number };
    const timings: number[] = [];
    let json: { Plan: Plan; 'Execution Time': number } | undefined;
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
      buffers: json!.Plan['Shared Hit Blocks'] + json!.Plan['Shared Read Blocks'],
      rows: json!.Plan['Actual Rows'],
      nodes: [...new Set(describeNodes(json!.Plan))].join(' → '),
      text,
    };
  } finally {
    client.release();
  }
}

/** Wraps every call to a context function in a scalar subquery, policy by policy. */
async function cachePolicyFunctions(pool: pg.Pool): Promise<number> {
  const wrap = (expr: string | null) =>
    expr?.replace(/\b(app_current_clinic_id|app_current_user_id|app_current_role|app_current_professional_id|app_is_platform_admin)\(\)/g,
      '(SELECT $1())') ?? null;
  const { rows } = await pool.query(
    `SELECT tablename, policyname, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);
  for (const p of rows) {
    const using = wrap(p.qual);
    const check = wrap(p.with_check);
    const clauses = [using ? `USING (${using})` : '', check ? `WITH CHECK (${check})` : ''].join(' ');
    if (clauses.trim()) await pool.query(`ALTER POLICY ${p.policyname} ON ${p.tablename} ${clauses}`);
  }
  return rows.length;
}

/** What each strategy returns for a query that forgot its tenant filter. */
async function forgottenFilter(pool: pg.Pool, strategy: 'column' | 'rls'): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    if (strategy === 'column') {
      await client.query(`SET LOCAL ROLE ${NO_RLS_ROLE}`);
    } else {
      await client.query(`SELECT app_set_session_context('${CLINIC}', '${USER}', 'clinic_admin', NULL, true)`);
      await client.query('SET LOCAL ROLE medicitas_app');
    }
    const { rows } = await client.query('SELECT count(DISTINCT clinic_id)::int AS clinics FROM appointment');
    await client.query('ROLLBACK');
    return rows[0].clinics;
  } finally {
    client.release();
  }
}

const admin = await createDatabase(adminUrl, 'measure_rls_appt', 'appointments');
const logs = await createDatabase(adminUrl, 'measure_rls_logs', 'logs');
try {
  await admin.pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${NO_RLS_ROLE}') THEN
        CREATE ROLE ${NO_RLS_ROLE} NOLOGIN BYPASSRLS;
      END IF;
    END $$;
    GRANT medicitas_app TO ${NO_RLS_ROLE};`);
  await logs.pool.query(`GRANT medicitas_app TO ${NO_RLS_ROLE}`);

  console.error('Seeding (a few seconds)...');
  await admin.pool.query(SEED_APPOINTMENTS);
  await logs.pool.query(SEED_LOGS);
  for (const pool of [admin.pool, logs.pool]) await pool.query('VACUUM ANALYZE');
  const pools = { appointments: admin.pool, logs: logs.pool };
  const [found] = (await admin.pool.query(
    `SELECT appointment_id, professional_id FROM clinical_note WHERE clinic_id = $1 ORDER BY appointment_id LIMIT 1`, [CLINIC])).rows;
  note = { appointmentId: found.appointment_id, professionalId: found.professional_id };
  const counts = (await admin.pool.query('SELECT (SELECT count(*) FROM appointment) AS a')).rows[0];
  const audit = (await logs.pool.query('SELECT count(*) AS n FROM audit_log')).rows[0];
  const version = (await admin.pool.query('SHOW server_version')).rows[0].server_version;

  const results: Record<string, Record<Strategy, Measured>> = {};
  const mismatches: string[] = [];
  for (const q of QUERIES) {
    results[q.id] = {} as Record<Strategy, Measured>;
    for (const s of STRATEGIES) results[q.id]![s] = await measure(pools[q.db], q, s);
  }
  const leak = { column: await forgottenFilter(admin.pool, 'column'), rls: await forgottenFilter(admin.pool, 'rls') };

  const rewritten = (await cachePolicyFunctions(admin.pool)) + (await cachePolicyFunctions(logs.pool));
  for (const q of QUERIES) {
    for (const s of CACHED) results[q.id]![s] = await measure(pools[q.db], q, s);
    const rows = ALL.map((s) => results[q.id]![s].rows);
    if (new Set(rows).size !== 1) mismatches.push(`${q.title}: ${rows.join(' / ')}`);
  }
  const leakCached = await forgottenFilter(admin.pool, 'rls');

  const out: string[] = [];
  out.push(`Data: ${counts.a} appointments in ${CLINICS.length} clinics, ${audit.n} audit events. PostgreSQL ${version}; median of ${RUNS} runs.\n`);
  out.push('| Query | Rows | Column only | RLS only | Both (services) | RLS, cached | Both, cached |');
  out.push('| --- | ---: | --- | --- | --- | --- | --- |');
  const cell = (m: Measured) => `${m.ms.toFixed(2)} ms, ${m.buffers} buf`;
  for (const q of QUERIES) {
    const r = results[q.id]!;
    out.push(`| ${q.title} | ${r.both.rows} | ${ALL.map((s) => cell(r[s])).join(' | ')} |`);
  }
  out.push('\n| Query | Column only: plan | RLS only: plan | Both: plan | Both, cached: plan |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const q of QUERIES) {
    const r = results[q.id]!;
    out.push(`| ${q.title} | ${r.column.nodes} | ${r.rls.nodes} | ${r.both.nodes} | ${r['both-cached'].nodes} |`);
  }
  out.push(`\n${rewritten} policies rewritten for the cached columns.`);
  out.push(`A query that forgot its tenant filter (\`SELECT count(DISTINCT clinic_id) FROM appointment\`): ` +
    `column only sees ${leak.column} clinic(s), RLS sees ${leak.rls}, RLS with cached functions sees ${leakCached}.`);
  out.push(mismatches.length === 0
    ? 'Every strategy returned the same rows for every query.'
    : `Different row counts: ${mismatches.join('; ')}`);
  for (const q of QUERIES) {
    out.push(`\n### ${q.title}\n`);
    for (const s of ALL) out.push(`${s}:\n\n\`\`\`text\n${results[q.id]![s].text}\n\`\`\`\n`);
  }
  console.log(out.join('\n'));
  if (mismatches.length > 0) process.exitCode = 1;
} finally {
  await admin.drop();
  await logs.drop();
  const cleanup = new (await import('pg')).default.Pool({ connectionString: adminUrl, max: 1 });
  await cleanup.query(`DROP ROLE IF EXISTS ${NO_RLS_ROLE}`).catch(() => undefined);
  await cleanup.end();
}
