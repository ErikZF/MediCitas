import assert from 'node:assert/strict';
import type { TenantContext } from '@medicitas/db';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { countAppointmentsByStatus } from '../../modules/appointment-counts/appointment-counts.service.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const clinicA = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
const clinicB = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
const ctxA: TenantContext = { clinicId: clinicA, userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04', role: 'clinic_admin' };
const ctxB: TenantContext = { ...ctxA, clinicId: clinicB };
const range = { from: '2027-01-04T06:00:00Z', to: '2027-01-05T06:00:00Z' };
const zero = { booked: 0, attended: 0, no_show: 0, cancelled: 0, rescheduled: 0 };
const expectedA = { counts: { booked: 2, attended: 1, no_show: 1, cancelled: 1, rescheduled: 1 }, total: 6 };

// Invokes the query directly: real PostgreSQL, the existing schema and RLS;
// no HTTP, JWT or RF21 role policy is claimed by this suite.
// RLS without an explicit tenant WHERE is covered in packages/db/tests/integration/tenant-tx.test.ts.
describe.skipIf(!url)('RF21 counts against PostgreSQL (including I5)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase(url as string, 'rf21');
    const fixtures: Array<[string, string, string]> = [
      [clinicA, 'booked', range.from], // Lower boundary is included.
      [clinicA, 'attended', '2027-01-04T12:00:00Z'],
      [clinicA, 'no_show', '2027-01-04T14:00:00Z'],
      [clinicA, 'cancelled', '2027-01-04T16:00:00Z'],
      [clinicA, 'rescheduled', '2027-01-04T18:00:00Z'],
      [clinicA, 'booked', '2027-01-05T05:59:59.999Z'], // Ending outside the range does not exclude it.
      [clinicA, 'booked', '2027-01-04T05:59:59.999Z'], // Overlapping the range is not enough.
      [clinicA, 'booked', range.to], // Upper boundary belongs to the next range.
      [clinicB, 'booked', range.from],
      [clinicB, 'cancelled', '2027-01-04T16:00:00Z'],
    ];
    for (const [index, [clinicId, status, startsAt]] of fixtures.entries()) {
      const resource = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await database.pool.query(`
        INSERT INTO appointment
          (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, status, created_by, created_at)
        VALUES ($1, $2, $2, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', 30, $4, $5, '2026-01-01T00:00:00Z')
      `, [clinicId, resource, startsAt, status, ctxA.userId]);
    }
  });

  afterAll(async () => { await database?.drop(); });

  test('counts all current states by starts_at with an inclusive lower and exclusive upper bound', async () => {
    assert.deepEqual(await countAppointmentsByStatus(database, ctxA, range), expectedA);
  });

  test('the other clinic gets only its own counts, not the first clinic totals', async () => {
    assert.deepEqual(await countAppointmentsByStatus(database, ctxB, range), {
      counts: { booked: 1, attended: 0, no_show: 0, cancelled: 1, rescheduled: 0 }, total: 2,
    });
  });

  test('returns all zeroes for a range with no appointments', async () => {
    assert.deepEqual(await countAppointmentsByStatus(database, ctxA, {
      from: '2028-01-01T00:00:00Z', to: '2028-01-02T00:00:00Z',
    }), { counts: zero, total: 0 });
  });

  test('equivalent UTC and explicit-offset ranges return identical counts', async () => {
    assert.deepEqual(await countAppointmentsByStatus(database, ctxA, {
      from: '2027-01-04T00:00:00-06:00', to: '2027-01-05T00:00:00-06:00',
    }), expectedA);
  });
});
