import assert from 'node:assert/strict';
import type { Database, TenantContext } from '@medicitas/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { test, vi } from 'vitest';
import { AuditQueryValidationError } from '../../modules/audit-query/audit-query.schemas.ts';
import { queryAuditLogs } from '../../modules/audit-query/audit-query.service.ts';

const ctx: TenantContext = {
  clinicId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002', role: 'clinic_admin',
};

test('rejects equal or reversed absolute instants before opening a transaction', async () => {
  const transaction = vi.fn();
  const db = { transaction } as unknown as Database;
  for (const to of ['2027-01-04T06:00:00Z', '2027-01-04T05:00:00Z']) {
    await assert.rejects(queryAuditLogs({ db }, ctx, { from: '2027-01-04T00:00:00-06:00', to }), AuditQueryValidationError);
  }
  assert.equal(transaction.mock.calls.length, 0);
});

test('opens a read-only tenant transaction with the application database role', async () => {
  // Actual Drizzle and withTenantTx; only the pg driver is replaced to record SQL.
  const query = vi.fn(async (_statement: { text: string }, _params?: unknown[]) => ({ rows: [] }));
  const db = drizzle({ client: { query } as unknown as pg.Client }) as Database;
  await queryAuditLogs({ db }, ctx, {});
  const statements = query.mock.calls.map(([statement, params]) => ({ sql: statement.text, params }));
  assert.match(statements[0]!.sql, /read committed.*read only/);
  assert.deepEqual(statements.find((s) => s.sql.includes('app_set_session_context'))!.params,
    [ctx.clinicId, ctx.userId, ctx.role, null]);
  assert.ok(statements.some((s) => s.sql === 'set local role "medicitas_app"'));
});
