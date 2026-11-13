import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import type { TenantContext } from '@medicitas/db';
import { createHttpClinicCalendar } from '../../adapters/clinic-calendar.http.ts';

const ctx: TenantContext = { clinicId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002', role: 'receptionist' };
afterEach(() => vi.unstubAllGlobals());

test('rejects unsafe/missing service URLs at construction', () => {
  for (const base of [undefined, 'file:///tmp', 'https://user:password@example.test',
    'https://example.test?clinic=x', 'https://example.test#fragment']) {
    assert.throws(() => createHttpClinicCalendar(base));
  }
});

test('forwards Bearer to the fixed endpoint, disables redirects and bounds the request', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ clinicId: ctx.clinicId, timeZone: 'America/Costa_Rica' }));
  vi.stubGlobal('fetch', fetcher);
  const result = await createHttpClinicCalendar('https://clinics.test/api').getTimeZone(ctx, 'Bearer fixture');
  assert.equal(result, 'America/Costa_Rica');
  const [endpoint, options] = fetcher.mock.calls[0];
  assert.equal(endpoint.href, 'https://clinics.test/api/clinic/time-zone');
  assert.deepEqual(options.headers, { authorization: 'Bearer fixture' });
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
});

test('fails closed on foreign clinic, invalid zone, HTTP failure or timeout', async () => {
  for (const outcome of [
    Response.json({ clinicId: ctx.userId, timeZone: 'UTC' }),
    Response.json({ clinicId: ctx.clinicId, timeZone: 'invalid/zone' }),
    new Response('unavailable', { status: 503 }), new DOMException('timeout', 'TimeoutError'),
  ]) {
    vi.stubGlobal('fetch', outcome instanceof Response
      ? vi.fn().mockResolvedValue(outcome) : vi.fn().mockRejectedValue(outcome));
    await assert.rejects(createHttpClinicCalendar('https://clinics.test').getTimeZone(ctx, 'Bearer fixture'),
      { status: 503, code: 'clinic_unavailable' });
  }
});
