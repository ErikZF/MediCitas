import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Database, TenantContext } from '@medicitas/db';
import { beforeEach, test, vi, type TestContext } from 'vitest';
import { createApp } from '../../app.ts';
import { countAppointmentsByStatus, type AppointmentCounts } from '../../modules/appointment-counts/appointment-counts.service.ts';

vi.mock('../../modules/appointment-counts/appointment-counts.service.ts', () => ({
  countAppointmentsByStatus: vi.fn(),
}));

// The context resolver and query are test doubles; @medicitas/auth uses its real matrix.
// No JWT authentication is exercised here.
// Real counts and tenant isolation stay in appointment-counts.test.ts against PostgreSQL.
const ctx: TenantContext = {
  clinicId: '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01',
  userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04',
  role: 'clinic_admin',
};
const range = { from: '2027-01-04T00:00:00-06:00', to: '2027-01-05T00:00:00-06:00' };
const result: AppointmentCounts = {
  counts: { booked: 1, attended: 0, no_show: 0, cancelled: 0, rescheduled: 0 }, total: 1,
};
const db = {} as Database; // The query function is mocked, so no database is accessed here.
const count = vi.mocked(countAppointmentsByStatus);

beforeEach(() => {
  count.mockReset();
  count.mockResolvedValue(result);
});

async function request(t: TestContext, identity: TenantContext | null, query = range) {
  const app = createApp({
    resolveContext: () => identity,
    appointmentCounts: { db },
    // Mount the real booking router too: /:appointmentId must not swallow /counts.
    booking: { db, catalog: { getBookableService: vi.fn() }, patients: { assertInClinic: vi.fn() } },
  });
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
  const response = await fetch(`http://127.0.0.1:${address.port}/appointments/counts?${new URLSearchParams(query)}`);
  return response;
}

test('200: counts precedes the booking id route and permits clinic_admin and receptionist', async (t) => {
  for (const role of ['clinic_admin', 'receptionist'] as const) {
    const identity: TenantContext = { ...ctx, role };
    const response = await request(t, identity);
    assert.equal(response.status, 200, role);
    assert.deepEqual(await response.json(), result);
    assert.deepEqual(count.mock.lastCall, [{ db }, identity, range]);
  }
  assert.equal(count.mock.calls.length, 2);
});

test('401: a request without identity never reaches the query', async (t) => {
  const response = await request(t, null);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Authentication required.' });
  assert.equal(count.mock.calls.length, 0);
});

test('403: professional and platform_admin cannot count clinic-wide appointments', async (t) => {
  const identities: TenantContext[] = [
    { ...ctx, role: 'professional', professionalId: '9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03' },
    { ...ctx, role: 'platform_admin', clinicId: null },
  ];
  for (const identity of identities) {
    const response = await request(t, identity);
    assert.equal(response.status, 403, identity.role);
    assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'forbidden' });
  }
  assert.equal(count.mock.calls.length, 0);
});

test('422: an invalid range is rejected after authorization and before the query', async (t) => {
  const response = await request(t, ctx, { from: range.to, to: range.from });
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'invalid_request' });
  assert.equal(count.mock.calls.length, 0);
});
