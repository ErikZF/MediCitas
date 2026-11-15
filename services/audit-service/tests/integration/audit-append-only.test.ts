import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.ts';

// Invariant I6: the audit log admits no modification and no deletion by the application.
// The engine enforces it, not the code: the role the services use has no UPDATE or
// DELETE privilege, RLS has no policy that would let a row be changed, and triggers
// reject UPDATE, DELETE and TRUNCATE even for the owner of the table.
const url = process.env.TEST_DATABASE_URL;

const CLINIC = '019a0000-0000-7000-8000-00000000a001';
const OTHER_CLINIC = '019a0000-0000-7000-8000-00000000b002';
const USER = '019a0000-0000-7000-8000-0000000000c1';
const PATIENT = '019a0000-0000-7000-8000-0000000000d1';

describe.skipIf(!url)('audit_log is append-only at engine level (I6)', () => {
  let logs: Awaited<ReturnType<typeof createTestDatabase>>;
  let id: string;

  // Runs a statement as the application role, inside a clinic context, and rolls back.
  async function asApp(sql: string, params: unknown[] = [], clinic = CLINIC) {
    const client: pg.PoolClient = await logs.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT app_set_session_context($1, $2, 'clinic_admin', NULL, true)`, [clinic, USER]);
      await client.query('SET LOCAL ROLE medicitas_app');
      return await client.query(sql, params);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  const count = async () => Number((await logs.pool.query('SELECT count(*) AS n FROM audit_log')).rows[0].n);

  beforeAll(async () => {
    logs = await createTestDatabase(url as string);
    id = randomUUID();
    await logs.pool.query(
      `INSERT INTO audit_log (audit_log_id, clinic_id, app_user_id, patient_id, action, resource, resource_id)
       VALUES ($1, $2, $3, $4, 'read', 'clinical_note', $5)`,
      [id, CLINIC, USER, PATIENT, randomUUID()],
    );
  });

  afterAll(async () => { await logs?.drop(); });

  test('the application role can append an event of its own clinic', async () => {
    const inserted = await asApp(
      `INSERT INTO audit_log (clinic_id, app_user_id, patient_id, action, resource, resource_id)
       VALUES ($1, $2, $3, 'create', 'patient_contact', $3) RETURNING audit_log_id`,
      [CLINIC, USER, PATIENT],
    );
    assert.equal(inserted.rowCount, 1);
  });

  test('it cannot append an event for another clinic (RLS, I5)', async () => {
    await assert.rejects(asApp(
      `INSERT INTO audit_log (clinic_id, app_user_id, patient_id, action, resource, resource_id)
       VALUES ($1, $2, $3, 'create', 'patient_contact', $3)`,
      [OTHER_CLINIC, USER, PATIENT],
    ), /row-level security/);
  });

  test.each([
    ['UPDATE', `UPDATE audit_log SET action = 'update'`],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
  ])('the application role cannot %s it (no privilege)', async (_op, sql) => {
    await assert.rejects(asApp(sql), /permission denied/);
    assert.equal(await count(), 1);
  });

  test.each([
    ['UPDATE', `UPDATE audit_log SET action = 'update'`],
    ['DELETE', 'DELETE FROM audit_log'],
    ['TRUNCATE', 'TRUNCATE audit_log'],
  ])('not even the owner of the table can %s it (trigger)', async (op, sql) => {
    await assert.rejects(logs.pool.query(sql), new RegExp(`append-only: ${op} is not allowed`));
    const row = (await logs.pool.query('SELECT action FROM audit_log WHERE audit_log_id = $1', [id])).rows[0];
    assert.equal(row.action, 'read');
  });
});
