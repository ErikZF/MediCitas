import assert from 'node:assert/strict';
import { MEDICITAS_APP_ROLE, withTenantTx, type TenantContext } from '@medicitas/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { queryAuditLogs } from '../../modules/audit-query/audit-query.service.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clinicA = id(101), clinicB = id(102), userA = id(201), userB = id(202);
const patientA = id(301), patientB = id(302);
const ctxA: TenantContext = { clinicId: clinicA, userId: userA, role: 'clinic_admin' };
const ctxB: TenantContext = { ...ctxA, clinicId: clinicB };
const range = { from: '2027-01-04T00:00:00-06:00', to: '2027-01-05T00:00:00-06:00' };

describe.skipIf(!url)('RF19 query against PostgreSQL logs schema', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const read = async (input: unknown = {}, ctx = ctxA) => queryAuditLogs(database, ctx, input);
  const ids = (rows: Awaited<ReturnType<typeof read>>) => rows.map((row) => row.auditLogId);

  beforeAll(async () => {
    database = await createTestDatabase(url as string);
    // Deliberately insert tied timestamps out of ID order. The foreign clinic uses
    // the same user/patient filter values to expose a missing clinic predicate.
    const fixtures: Array<[number, string, string, string, string]> = [
      [3, clinicA, userA, patientA, '2027-01-04T12:00:00Z'],
      [2, clinicA, userB, patientA, '2027-01-04T12:00:00Z'],
      [1, clinicA, userA, patientA, '2027-01-04T06:00:00Z'],
      [4, clinicA, userA, patientB, '2027-01-05T06:00:00Z'],
      [5, clinicA, userA, patientA, '2027-01-04T05:59:59.999Z'],
      [6, clinicB, userA, patientA, '2027-01-04T06:00:00Z'],
    ];
    for (const [n, clinic, user, patient, at] of fixtures) {
      // Only fixture creation bypasses RLS. Production reads switch to medicitas_app.
      await database.pool.query(`INSERT INTO audit_log
        (audit_log_id, clinic_id, app_user_id, patient_id, action, resource, resource_id, occurred_at)
        VALUES ($1, $2, $3, $4, 'read', 'patient_contact', $4, $5)`, [id(n), clinic, user, patient, at]);
    }
  });

  afterAll(async () => { await database?.drop(); });

  test('applies user and patient filters separately and together', async () => {
    assert.deepEqual(ids(await read({ userId: userB })), [id(2)]);
    assert.deepEqual(ids(await read({ patientId: patientB })), [id(4)]);
    assert.deepEqual(ids(await read({ ...range, userId: userA, patientId: patientA })), [id(1), id(3)]);
  });

  test('includes from, excludes to and supports either bound alone as absolute instants', async () => {
    assert.deepEqual(ids(await read(range)), [id(1), id(2), id(3)]);
    assert.deepEqual(ids(await read({ from: range.to })), [id(4)]);
    assert.deepEqual(ids(await read({ to: '2027-01-04T06:00:00Z' })), [id(5)]);
  });

  test('without filters returns complete events ordered by occurred_at then ID', async () => {
    const rows = await read();
    assert.deepEqual(ids(rows), [id(5), id(1), id(2), id(3), id(4)]);
    assert.deepEqual(rows[1], {
      auditLogId: id(1), clinicId: clinicA, userId: userA, patientId: patientA,
      action: 'read', resource: 'patient_contact', resourceId: patientA,
      occurredAt: new Date('2027-01-04T06:00:00Z'),
    });
  });

  test('returns an empty list when no events match', async () => {
    assert.deepEqual(await read({ userId: userB, patientId: patientB }), []);
  });

  test('uses the context clinic and RLS independently prevents cross-clinic reads', async () => {
    assert.deepEqual(ids(await read({ ...range, userId: userA, patientId: patientA }, ctxB)), [id(6)]);
    // No WHERE clinic_id: verify the actual logs policy as well as the service filter.
    const result = await withTenantTx(database.db, ctxA,
      (tx) => tx.execute(sql`SELECT DISTINCT clinic_id FROM audit_log`),
      { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
    assert.deepEqual(result.rows, [{ clinic_id: clinicA }]);
  });
});
