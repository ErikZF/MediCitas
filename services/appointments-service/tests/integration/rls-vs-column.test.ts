import assert from 'node:assert/strict';
import pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.ts';

// Module for groups of three, option 2: the same isolation attempts against the two
// strategies (docs/rls-comparison.md).
//
//   column  isolation lives in the query: `WHERE clinic_id = …`. Simulated with a role
//           that keeps the privileges of medicitas_app but has BYPASSRLS.
//   rls     isolation lives in the engine: the policies of init.sql filter by the clinic of
//           the session context, whatever the query says.
//
// The column strategy is correct only while every query is. These tests show what happens
// when one is not: a forgotten WHERE, or a clinic id taken from the request.
const url = process.env.TEST_DATABASE_URL;

const CLINIC_A = '019a0000-0000-7000-8000-00000000aa01';
const CLINIC_B = '019a0000-0000-7000-8000-00000000bb02';
const USER_A = '019a0000-0000-7000-8000-0000000000a1';
const PROF_A = '019a0000-0000-7000-8000-0000000000a2';
const PROF_B = '019a0000-0000-7000-8000-0000000000b2';
const PATIENT = '019a0000-0000-7000-8000-0000000000c1';
const SERVICE = '019a0000-0000-7000-8000-0000000000d1';
const NO_RLS = 'medicitas_test_column_only';

describe.skipIf(!url)('column discriminator vs RLS: the same leak attempts (I5)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;

  type Strategy = 'column' | 'rls';

  /** Runs statements as one strategy, logged in as reception of clinic A, and rolls back. */
  async function as<T = Record<string, unknown>>(strategy: Strategy, sql: string, params: unknown[] = [], context = true) {
    const client: pg.PoolClient = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (strategy === 'column') {
        await client.query(`SET LOCAL ROLE ${NO_RLS}`);
      } else {
        if (context) await client.query(`SELECT app_set_session_context($1, $2, 'receptionist', NULL, true)`, [CLINIC_A, USER_A]);
        await client.query('SET LOCAL ROLE medicitas_app');
      }
      return await client.query<T & pg.QueryResultRow>(sql, params);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const clinicsSeen = async (strategy: Strategy, sql: string, params: unknown[] = [], context = true) =>
    (await as<{ clinic_id: string }>(strategy, sql, params, context)).rows.map((r) => r.clinic_id).sort();

  const insertFor = (clinic: string) => [
    `INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, created_by)
     VALUES ($1, $2, $3, $4, '2027-05-03T15:00:00Z', '2027-05-03T15:30:00Z', 30, $5)`,
    [clinic, clinic === CLINIC_A ? PROF_A : PROF_B, PATIENT, SERVICE, USER_A],
  ] as const;

  beforeAll(async () => {
    db = await createTestDatabase(url as string, 'rls_vs_column');
    await db.pool.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${NO_RLS}') THEN
          CREATE ROLE ${NO_RLS} NOLOGIN BYPASSRLS;
        END IF;
      END $$;
      GRANT medicitas_app TO ${NO_RLS};`);
    // One appointment in each clinic, inserted by the owner (seed).
    for (const [clinic, prof] of [[CLINIC_A, PROF_A], [CLINIC_B, PROF_B]] as const) {
      await db.pool.query(
        `INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, created_by)
         VALUES ($1, $2, $3, $4, '2027-05-04T15:00:00Z', '2027-05-04T15:30:00Z', 30, $5)`,
        [clinic, prof, PATIENT, SERVICE, USER_A]);
    }
  });

  afterAll(async () => {
    await db?.drop();
    const admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP ROLE IF EXISTS ${NO_RLS}`).catch(() => undefined);
    await admin.end();
  });

  test('both are correct while the query carries the right filter', async () => {
    const sql = 'SELECT clinic_id FROM appointment WHERE clinic_id = $1';
    assert.deepEqual(await clinicsSeen('column', sql, [CLINIC_A]), [CLINIC_A]);
    assert.deepEqual(await clinicsSeen('rls', sql, [CLINIC_A]), [CLINIC_A]);
  });

  test('a query that forgot the filter: the column strategy returns every clinic, RLS only its own', async () => {
    const sql = 'SELECT clinic_id FROM appointment';
    assert.deepEqual(await clinicsSeen('column', sql), [CLINIC_A, CLINIC_B], 'the leak RLS exists to prevent');
    assert.deepEqual(await clinicsSeen('rls', sql), [CLINIC_A]);
  });

  test('a clinic id taken from the request (manipulated parameter): the column strategy obeys it, RLS ignores it', async () => {
    const sql = 'SELECT clinic_id FROM appointment WHERE clinic_id = $1';
    assert.deepEqual(await clinicsSeen('column', sql, [CLINIC_B]), [CLINIC_B], 'reception of A reads clinic B');
    assert.deepEqual(await clinicsSeen('rls', sql, [CLINIC_B]), []);
  });

  test('writing a row for another clinic: the column strategy accepts it, RLS rejects it', async () => {
    const [sql, params] = insertFor(CLINIC_B);
    assert.equal((await as('column', sql, [...params])).rowCount, 1);
    await assert.rejects(as('rls', sql, [...params]), /row-level security/);
    const [own, ownParams] = insertFor(CLINIC_A);
    assert.equal((await as('rls', own, [...ownParams])).rowCount, 1, 'its own clinic is fine');
  });

  test("changing or deleting another clinic's rows: the column strategy does it, RLS touches nothing", async () => {
    const update = `UPDATE appointment SET status = 'cancelled', cancel_reason = 'x' WHERE clinic_id = $1`;
    assert.equal((await as('column', update, [CLINIC_B])).rowCount, 1);
    assert.equal((await as('rls', update, [CLINIC_B])).rowCount, 0);
  });

  test('a session without tenant context: RLS fails closed and sees nothing', async () => {
    assert.deepEqual(await clinicsSeen('rls', 'SELECT clinic_id FROM appointment', [], false), []);
  });

  test('the owner data is intact after every attempt', async () => {
    const { rows } = await db.pool.query(`SELECT clinic_id, status FROM appointment ORDER BY clinic_id`);
    assert.deepEqual(rows, [{ clinic_id: CLINIC_A, status: 'booked' }, { clinic_id: CLINIC_B, status: 'booked' }]);
  });
});
