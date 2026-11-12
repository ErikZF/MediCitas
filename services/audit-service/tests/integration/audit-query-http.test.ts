import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Database, TenantContext } from '@medicitas/db';
import { beforeEach, test, vi, type TestContext } from 'vitest';
import { createApp } from '../../app.ts';
import { queryAuditLogs } from '../../modules/audit-query/audit-query.service.ts';

vi.mock('../../modules/audit-query/audit-query.service.ts', () => ({ queryAuditLogs: vi.fn() }));

// Actual createApp, router and permission matrix. No JWT/Keycloak is exercised.
const ctx: TenantContext = {
  clinicId: '00000000-0000-4000-8000-000000000101',
  userId: '00000000-0000-4000-8000-000000000201', role: 'clinic_admin',
};
const filters = {
  userId: '00000000-0000-4000-8000-000000000202',
  patientId: '00000000-0000-4000-8000-000000000301',
  from: '2027-01-04T00:00:00-06:00', to: '2027-01-05T00:00:00-06:00',
};
const events: Awaited<ReturnType<typeof queryAuditLogs>> = [{
  auditLogId: '00000000-0000-4000-8000-000000000001',
  clinicId: ctx.clinicId!, userId: filters.userId, patientId: filters.patientId,
  action: 'read', resource: 'patient_contact', resourceId: filters.patientId,
  occurredAt: new Date('2027-01-04T06:00:00Z'),
}];
const db = {} as Database; // No database is needed in this HTTP contract suite.
const query = vi.mocked(queryAuditLogs);

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue(events);
});

async function request(t: TestContext, identity: TenantContext | null, input: Record<string, string> = filters) {
  const app = createApp({ resolveContext: () => identity, auditQuery: { db } });
  const server = app.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return fetch(`http://127.0.0.1:${address.port}/audit/logs?${new URLSearchParams(input)}`, {
    // Deliberate spoofing: these headers cannot establish or replace the context.
    headers: { 'x-clinic-id': '00000000-0000-4000-8000-000000000999', 'x-role': 'clinic_admin' },
  });
}

test('200: clinic_admin receives events and forwards filters with the trusted context', async (t) => {
  const response = await request(t, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ ...events[0], occurredAt: events[0]!.occurredAt.toISOString() }]);
  assert.equal(query.mock.lastCall?.[0].db, db);
  assert.equal(query.mock.lastCall?.[1], ctx);
  // Express query objects have no prototype; compare filter values, not prototypes.
  assert.deepEqual({ ...query.mock.lastCall?.[2] as Record<string, unknown> }, filters);
  assert.equal(query.mock.calls.length, 1);
});

test('401: without identity, even spoofed role/clinic headers never reach the query', async (t) => {
  const response = await request(t, null);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required.' });
  assert.equal(query.mock.calls.length, 0);
});

test('403: receptionist, professional and platform_admin are rejected before the query', async (t) => {
  const identities: TenantContext[] = [
    { ...ctx, role: 'receptionist' },
    { ...ctx, role: 'professional', professionalId: '00000000-0000-4000-8000-000000000401' },
    { ...ctx, role: 'platform_admin', clinicId: null },
  ];
  for (const identity of identities) {
    const response = await request(t, identity);
    assert.equal(response.status, 403, identity.role);
    assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'forbidden' });
  }
  assert.equal(query.mock.calls.length, 0);
});

test('422: the existing service rejects invalid filters through the shared HTTP error handler', async (t) => {
  // Use the REAL service for this case: its validation rejects before using db.
  const real = await vi.importActual<typeof import('../../modules/audit-query/audit-query.service.ts')>(
    '../../modules/audit-query/audit-query.service.ts',
  );
  query.mockImplementation(real.queryAuditLogs);
  const response = await request(t, ctx, { ...filters, from: filters.to, to: filters.from });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'invalid_request' });
  assert.equal(query.mock.calls.length, 1);
});
