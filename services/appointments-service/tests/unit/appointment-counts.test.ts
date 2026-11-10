import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, test, vi } from 'vitest';
import type { Database, TenantContext } from '@medicitas/db';
import { ForbiddenError, ValidationError } from '../../domain/errors.ts';
import { countAppointmentsByStatus } from '../../modules/appointment-counts/appointment-counts.service.ts';

const ctx: TenantContext = {
  clinicId: '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01',
  userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04',
  role: 'clinic_admin',
};
const range = { from: '2027-01-04T00:00:00-06:00', to: '2027-01-05T00:00:00-06:00' };
const emptyCounts = { booked: 0, attended: 0, no_show: 0, cancelled: 0, rescheduled: 0 };

// Real Drizzle query construction and withTenantTx; only the pg driver is a stub.
// These tests do not execute SQL or establish that PostgreSQL enforces RLS.
function recordingDatabase() {
  const query = vi.fn(async (_statement: { text: string }, _params?: unknown[]) => ({ rows: [] }));
  const db = drizzle({ client: { query } as unknown as pg.Client }) as Database;
  return { db, query };
}

describe('RF21 input validation', () => {
  test.each([
    { name: 'submillisecond boundary', input: { ...range, from: '2027-01-04T00:00:00.0001Z' } },
    { name: 'equal instants with different offsets', input: { from: range.from, to: '2027-01-04T06:00:00Z' } },
    { name: 'reversed range', input: { from: range.to, to: range.from } },
    { name: 'client-supplied foreign clinic', input: { ...range, clinicId: '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02' } },
  ])('rejects $name before accessing the database', async ({ input }) => {
    const { db, query } = recordingDatabase();
    await assert.rejects(countAppointmentsByStatus({ db }, ctx, input), ValidationError);
    assert.equal(query.mock.calls.length, 0);
  });

  test('compares absolute instants rather than the lexical order of offsets', async () => {
    const { db } = recordingDatabase();
    const result = await countAppointmentsByStatus({ db }, ctx, {
      from: '2027-01-04T09:00:00+02:00',
      to: '2027-01-04T08:00:00Z',
    });
    assert.deepEqual(result, { counts: emptyCounts, total: 0 });
  });

  test('cannot run a clinic-wide count without a clinic', async () => {
    const { db, query } = recordingDatabase();
    await assert.rejects(countAppointmentsByStatus({ db }, { ...ctx, clinicId: null, role: 'platform_admin' }, range), ForbiddenError);
    assert.equal(query.mock.calls.length, 0);
  });
});

describe('RF21 query construction (pg driver stub)', () => {
  test('uses a read-only tenant transaction and one parameterized aggregate with both bounds', async () => {
    const { db, query } = recordingDatabase();
    await countAppointmentsByStatus({ db }, ctx, range);
    const statements = query.mock.calls.map(([statement, params]) => ({ sql: statement.text, params }));
    assert.match(statements[0]!.sql, /read committed.*read only/);
    const context = statements.find((s) => s.sql.includes('app_set_session_context'))!;
    assert.deepEqual(context.params, [ctx.clinicId, ctx.userId, ctx.role, null]);
    assert.ok(statements.some((s) => s.sql === 'set local role "medicitas_app"'));
    const aggregates = statements.filter((s) => s.sql.includes('count(*)'));
    assert.equal(aggregates.length, 1);
    assert.match(aggregates[0]!.sql, /"clinic_id" = \$1/);
    assert.match(aggregates[0]!.sql, /"starts_at" >= \$2/);
    assert.match(aggregates[0]!.sql, /"starts_at" < \$3/);
    assert.match(aggregates[0]!.sql, /group by/);
    assert.deepEqual(aggregates[0]!.params, [ctx.clinicId, '2027-01-04T06:00:00.000Z', '2027-01-05T06:00:00.000Z']);
  });
});
