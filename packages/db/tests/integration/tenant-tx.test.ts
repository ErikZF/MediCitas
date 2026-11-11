import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { readDbConfig } from '../../src/config.ts';
import { MEDICITAS_APP_ROLE, MEDICITAS_DB_ROLES, type TenantContext } from '../../src/context.ts';
import { DbError } from '../../src/errors.ts';
import { createDatabase } from '../../src/pool.ts';
import { withTenantTx, type Database } from '../../src/tenant-tx.ts';
import { CLINIC_A, CLINIC_B, PROFESSIONAL_A, USER_A } from '../helpers/fake-db.ts';

// Runs against a real PostgreSQL. Each run creates a throwaway database, applies the
// real appointments schema (with its RLS policies and the medicitas_app role) and
// drops it at the end. Needs a user that can create databases, for example the
// container's POSTGRES_USER:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5433/appointments_db npm run test:integration
const url = process.env.TEST_DATABASE_URL;
const schemaSql = new URL('../../../../database/appointments/init.sql', import.meta.url);

const PROFESSIONAL_B = '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05';
const PATIENT_1 = 'b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06';
const PATIENT_2 = 'c3d5f7a9-2b4c-4d6e-9f8a-0b1c2d3e4f07';
const SERVICE = 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';

const receptionistA: TenantContext = { clinicId: CLINIC_A, userId: USER_A, role: 'receptionist' };
const receptionistB: TenantContext = { clinicId: CLINIC_B, userId: USER_A, role: 'receptionist' };
const professional = (professionalId: string): TenantContext => (
  { clinicId: CLINIC_A, userId: USER_A, role: 'professional', professionalId }
);
const asApp = { dbRoles: MEDICITAS_APP_ROLE };

function appointmentValues(clinicId: string, professionalId: string, patientId: string, startsAt: string) {
  return sql`(${clinicId}, ${professionalId}, ${patientId}, ${SERVICE},
    ${startsAt}::timestamptz, ${startsAt}::timestamptz + interval '30 minutes', 30, ${USER_A})`;
}

describe.skipIf(!url)('withTenantTx against the real appointments schema', () => {
  const dbName = `medicitas_it_${process.pid}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let db: Database;
  let testUrl: string;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);

    const target = new URL(url as string);
    target.pathname = `/${dbName}`;
    testUrl = target.toString();

    // A single-connection pool forces connection reuse, like PgBouncer does.
    pool = new pg.Pool({ connectionString: testUrl, max: 1 });
    db = drizzle({ client: pool }) as unknown as Database;
    await pool.query(readFileSync(schemaSql, 'utf8'));

    // Seed as the connection owner (a superuser), which bypasses RLS.
    await pool.query(`
      INSERT INTO appointment (appointment_id, clinic_id, professional_id, patient_id, service_id,
                               starts_at, ends_at, duration_minutes, created_by) VALUES
        ('e1000000-0000-4000-8000-000000000001', '${CLINIC_A}', '${PROFESSIONAL_A}', '${PATIENT_1}', '${SERVICE}',
         '2026-12-01 14:00Z', '2026-12-01 14:30Z', 30, '${USER_A}'),
        ('e1000000-0000-4000-8000-000000000002', '${CLINIC_A}', '${PROFESSIONAL_B}', '${PATIENT_2}', '${SERVICE}',
         '2026-12-01 15:00Z', '2026-12-01 15:30Z', 30, '${USER_A}'),
        ('e1000000-0000-4000-8000-000000000003', '${CLINIC_B}', '${PROFESSIONAL_A}', '${PATIENT_1}', '${SERVICE}',
         '2026-12-02 14:00Z', '2026-12-02 14:30Z', 30, '${USER_A}');
      INSERT INTO clinical_note (appointment_id, clinic_id, professional_id, content) VALUES
        ('e1000000-0000-4000-8000-000000000001', '${CLINIC_A}', '${PROFESSIONAL_A}', 'note of professional A'),
        ('e1000000-0000-4000-8000-000000000002', '${CLINIC_A}', '${PROFESSIONAL_B}', 'note of professional B');
    `);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await admin.end();
    }
  });

  const appointmentClinics = (ctx: TenantContext) => withTenantTx(db, ctx, async (tx) => {
    const result = await tx.execute(sql`select clinic_id from appointment order by starts_at`);
    return result.rows.map((row) => row.clinic_id);
  }, asApp);

  test('the transaction runs in READ COMMITTED as medicitas_app', async () => {
    const row = await withTenantTx(db, receptionistA, async (tx) => {
      const result = await tx.execute(sql`select current_setting('transaction_isolation') as level, current_user as who`);
      return result.rows[0];
    }, asApp);
    assert.deepEqual(row, { level: 'read committed', who: 'medicitas_app' });
  });

  test('each clinic sees only its own appointments', async () => {
    assert.deepEqual(await appointmentClinics(receptionistA), [CLINIC_A, CLINIC_A]);
    assert.deepEqual(await appointmentClinics(receptionistB), [CLINIC_B]);
  });

  test('platform_admin sees no appointments', async () => {
    assert.deepEqual(await appointmentClinics({ clinicId: null, userId: USER_A, role: 'platform_admin' }), []);
  });

  test('cannot book in another clinic (403)', async () => {
    const error = await withTenantTx(db, receptionistA, async (tx) => {
      await tx.execute(sql`insert into appointment (clinic_id, professional_id, patient_id, service_id,
        starts_at, ends_at, duration_minutes, created_by)
        values ${appointmentValues(CLINIC_B, PROFESSIONAL_A, PATIENT_2, '2026-12-05 14:00Z')}`);
    }, asApp).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.status, 403);
  });

  test('reception cannot change working hours (403)', async () => {
    const error = await withTenantTx(db, receptionistA, async (tx) => {
      await tx.execute(sql`insert into working_hours (clinic_id, professional_id, weekday, start_time, end_time)
        values (${CLINIC_A}, ${PROFESSIONAL_A}, 1, '08:00', '12:00')`);
    }, asApp).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.status, 403);
  });

  test('a professional reads only their own clinical notes; reception reads none', async () => {
    const notes = (ctx: TenantContext) => withTenantTx(db, ctx, async (tx) => {
      const result = await tx.execute(sql`select content from clinical_note`);
      return result.rows.map((row) => row.content);
    }, asApp);

    assert.deepEqual(await notes(professional(PROFESSIONAL_A)), ['note of professional A']);
    assert.deepEqual(await notes(professional(PROFESSIONAL_B)), ['note of professional B']);
    assert.deepEqual(await notes(receptionistA), []);
  });

  test('least-privilege DB roles: receptionist and admin are denied at engine level from reading clinical_note', async () => {
    const roles = { dbRoles: MEDICITAS_DB_ROLES };

    // Receptionist has no SELECT on clinical_note
    const recError = await withTenantTx(db, receptionistA, async (tx) => {
      await tx.execute(sql`select content from clinical_note`);
    }, roles).catch((e: unknown) => e);
    assert.ok(recError instanceof DbError);
    assert.equal(recError.status, 403);

    // Admin has no SELECT on clinical_note
    const adminCtx: TenantContext = { clinicId: CLINIC_A, userId: USER_A, role: 'clinic_admin' };
    const adminError = await withTenantTx(db, adminCtx, async (tx) => {
      await tx.execute(sql`select content from clinical_note`);
    }, roles).catch((e: unknown) => e);
    assert.ok(adminError instanceof DbError);
    assert.equal(adminError.status, 403);

    // Professional has SELECT on clinical_note
    const profNotes = await withTenantTx(db, professional(PROFESSIONAL_A), async (tx) => {
      const result = await tx.execute(sql`select content from clinical_note`);
      return result.rows.map((row) => row.content);
    }, roles);
    assert.deepEqual(profNotes, ['note of professional A']);
  });

  test('neither context nor role survive the commit on a reused connection', async () => {
    await withTenantTx(db, receptionistA, async () => 'ok', asApp);
    const { rows } = await pool.query(`select coalesce(current_setting('app.current_clinic_id', true), '') as clinic,
                                              current_user = session_user as same_user`);
    assert.equal(rows[0].clinic, '');
    assert.equal(rows[0].same_user, true);
  });

  test('nor do they survive a rollback caused by an error', async () => {
    await assert.rejects(withTenantTx(db, receptionistA, async () => {
      throw new Error('domain failure');
    }, asApp));
    const { rows } = await pool.query(`select coalesce(current_setting('app.current_clinic_id', true), '') as clinic,
                                              current_user = session_user as same_user`);
    assert.equal(rows[0].clinic, '');
    assert.equal(rows[0].same_user, true);
  });

  test('createDatabase builds a working pool from environment variables', async () => {
    const parsed = new URL(testUrl);
    const config = readDbConfig('DB_TEST', 'db-package-tests', {
      DB_TEST_HOST: parsed.hostname,
      DB_TEST_NAME: parsed.pathname.slice(1),
      DB_TEST_USER: decodeURIComponent(parsed.username),
      DB_TEST_PASSWORD: decodeURIComponent(parsed.password) || 'unused',
      DB_CONNECT_PORT: parsed.port || '5432',
      DB_TEST_POOL_MAX: '2',
    });
    const handle = createDatabase(config);
    try {
      const name = await withTenantTx(handle.db, receptionistA, async (tx) => {
        const result = await tx.execute(sql`select current_setting('application_name') as name`);
        return result.rows[0]?.name;
      }, asApp);
      assert.equal(name, 'db-package-tests');
    } finally {
      await handle.close();
    }
  });

  test('two simultaneous bookings of the same slot: one wins, the other gets 409 slot_taken', async () => {
    const racePool = new pg.Pool({ connectionString: testUrl, max: 4 });
    const raceDb = drizzle({ client: racePool }) as unknown as Database;
    const book = (patientId: string) => withTenantTx(raceDb, receptionistA, async (tx) => {
      await tx.execute(sql`insert into appointment (clinic_id, professional_id, patient_id, service_id,
        starts_at, ends_at, duration_minutes, created_by)
        values ${appointmentValues(CLINIC_A, PROFESSIONAL_A, patientId, '2026-12-03 14:00Z')}`);
      return 'booked';
    }, asApp);

    try {
      const results = await Promise.allSettled([book(PATIENT_1), book(PATIENT_2)]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(won.length, 1);
      assert.equal(lost.length, 1);
      assert.ok(lost[0].reason instanceof DbError);
      assert.equal(lost[0].reason.status, 409);
      assert.equal(lost[0].reason.code, 'slot_taken');
    } finally {
      await racePool.end();
    }
  });
});
