import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { readDbConfig } from '../../src/config.ts';
import { DbError } from '../../src/errors.ts';
import { createDatabase } from '../../src/pool.ts';
import { withTenantTx, type Database } from '../../src/tenant-tx.ts';
import type { DbRoleMap, TenantContext } from '../../src/context.ts';
import { CLINIC_A, CLINIC_B } from '../helpers/fake-db.ts';

// Runs against a real Postgres. Needs a user that can create roles and schemas,
// for example the container's POSTGRES_USER:
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5433/appointments_db npm run test:integration
const url = process.env.TEST_DATABASE_URL;

const SCHEMA = 'e1_integration';
const ROLE = 'e1_integration_actor';
const PROFESSIONAL = '9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03';
const dbRoles: DbRoleMap = { receptionist: ROLE, platform_admin: ROLE };

const receptionistA: TenantContext = { clinicId: CLINIC_A, userSub: 'kc-recepcion-a', role: 'receptionist' };
const receptionistB: TenantContext = { clinicId: CLINIC_B, userSub: 'kc-recepcion-b', role: 'receptionist' };

describe.skipIf(!url)('withTenantTx contra PostgreSQL real', () => {
  let pool: pg.Pool;
  let db: Database;

  beforeAll(async () => {
    // A single-connection pool forces connection reuse, like PgBouncer does.
    pool = new pg.Pool({ connectionString: url, max: 1 });
    db = drizzle({ client: pool }) as unknown as Database;

    await pool.query(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
          EXECUTE 'DROP ROLE ${ROLE}';
        END IF;
      END $$;
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.slot (
        id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        clinic_id       UUID NOT NULL,
        professional_id UUID NOT NULL,
        starts_at       TIMESTAMPTZ NOT NULL,
        ends_at         TIMESTAMPTZ NOT NULL,
        CONSTRAINT no_overlap_professional EXCLUDE USING gist (
          clinic_id WITH =,
          professional_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        )
      );
      ALTER TABLE ${SCHEMA}.slot ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${SCHEMA}.slot FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${SCHEMA}.slot
        USING (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid)
        WITH CHECK (clinic_id = NULLIF(current_setting('app.clinic_id', true), '')::uuid);
      CREATE ROLE ${ROLE} NOLOGIN;
      GRANT USAGE ON SCHEMA ${SCHEMA} TO ${ROLE};
      GRANT SELECT, INSERT ON ${SCHEMA}.slot TO ${ROLE};
      INSERT INTO ${SCHEMA}.slot (clinic_id, professional_id, starts_at, ends_at) VALUES
        ('${CLINIC_A}', '${PROFESSIONAL}', '2026-12-01 14:00Z', '2026-12-01 14:30Z'),
        ('${CLINIC_B}', '${PROFESSIONAL}', '2026-12-01 15:00Z', '2026-12-01 15:30Z');
    `);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP ROLE IF EXISTS ${ROLE};`);
    await pool.end();
  });

  test('the transaction runs in READ COMMITTED', async () => {
    const level = await withTenantTx(db, receptionistA, async (tx) => {
      const result = await tx.execute(sql`select current_setting('transaction_isolation') as level`);
      return result.rows[0]?.level;
    });
    assert.equal(level, 'read committed');
  });

  test('with RLS and the actor role, each clinic sees only its own rows', async () => {
    const seen = async (ctx: TenantContext) => withTenantTx(db, ctx, async (tx) => {
      const result = await tx.execute(sql`select clinic_id from ${sql.identifier(SCHEMA)}.slot`);
      return result.rows.map((row) => row.clinic_id);
    }, { dbRoles });

    assert.deepEqual(await seen(receptionistA), [CLINIC_A]);
    assert.deepEqual(await seen(receptionistB), [CLINIC_B]);
  });

  test('without a clinic (platform_admin) no rows are visible', async () => {
    const rows = await withTenantTx(db, { clinicId: null, userSub: 'kc-plataforma', role: 'platform_admin' }, async (tx) => {
      const result = await tx.execute(sql`select count(*)::int as n from ${sql.identifier(SCHEMA)}.slot`);
      return result.rows[0]?.n;
    }, { dbRoles });
    assert.equal(rows, 0);
  });

  test('cannot insert rows for another clinic', async () => {
    const error = await withTenantTx(db, receptionistA, async (tx) => {
      await tx.execute(sql`insert into ${sql.identifier(SCHEMA)}.slot (clinic_id, professional_id, starts_at, ends_at)
        values (${CLINIC_B}, ${PROFESSIONAL}, '2026-12-02 14:00Z', '2026-12-02 14:30Z')`);
    }, { dbRoles }).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.status, 403);
  });

  test('neither clinic nor role survive the commit on a reused connection', async () => {
    await withTenantTx(db, receptionistA, async () => 'ok', { dbRoles });
    const { rows } = await pool.query(`select coalesce(current_setting('app.clinic_id', true), '') as clinic,
                                              current_user = session_user as same_user`);
    assert.equal(rows[0].clinic, '');
    assert.equal(rows[0].same_user, true);
  });

  test('nor do they survive a rollback caused by an error', async () => {
    await assert.rejects(withTenantTx(db, receptionistA, async () => {
      throw new Error('falla de dominio');
    }, { dbRoles }));
    const { rows } = await pool.query(`select coalesce(current_setting('app.clinic_id', true), '') as clinic,
                                              current_user = session_user as same_user`);
    assert.equal(rows[0].clinic, '');
    assert.equal(rows[0].same_user, true);
  });

  test('createDatabase builds a working pool from environment variables', async () => {
    const parsed = new URL(url as string);
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
      });
      assert.equal(name, 'db-package-tests');
    } finally {
      await handle.close();
    }
  });

  test('two simultaneous bookings of the same slot: one wins, the other gets 409 slot_taken', async () => {
    const racePool = new pg.Pool({ connectionString: url, max: 4 });
    const raceDb = drizzle({ client: racePool }) as unknown as Database;
    const book = () => withTenantTx(raceDb, receptionistA, async (tx) => {
      await tx.execute(sql`insert into ${sql.identifier(SCHEMA)}.slot (clinic_id, professional_id, starts_at, ends_at)
        values (${CLINIC_A}, ${PROFESSIONAL}, '2026-12-03 14:00Z', '2026-12-03 14:30Z')`);
      return 'booked';
    }, { dbRoles });

    try {
      const results = await Promise.allSettled([book(), book()]);
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
