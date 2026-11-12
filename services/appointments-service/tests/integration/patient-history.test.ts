import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type TenantContext } from '@medicitas/db';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { appointment } from '../../db/schema.ts';
import { getPatientAppointmentHistory } from '../../modules/patient-history/patient-history.service.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const clinicA = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
const clinicB = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
const patient = 'b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06';
const otherPatient = 'c3d5f7a9-2b4c-4d6e-9f8a-0b1c2d3e4f07';
const foreignPatient = 'a4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';
const professional = '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05';
const otherProfessional = '4b9f6d2e-8a3c-4e0b-8d7f-6c5b3a9e2f06';
const service = 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';
const ctxA: TenantContext = { clinicId: clinicA, userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04', role: 'receptionist' };
const ctxB: TenantContext = { ...ctxA, clinicId: clinicB };
const id = (n: number) => `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const fixtures = [
  { n: 1, clinicId: clinicA, patientId: patient, status: 'rescheduled', startsAt: '2026-01-04T18:00:00.000Z' },
  { n: 2, clinicId: clinicA, patientId: patient, status: 'attended', startsAt: '2026-01-04T16:00:00.000Z' },
  { n: 3, clinicId: clinicA, patientId: patient, status: 'no_show', startsAt: '2026-01-04T16:00:00.000Z' },
  { n: 4, clinicId: clinicA, patientId: patient, status: 'cancelled', startsAt: '2026-01-04T20:00:00.000Z' },
  { n: 5, clinicId: clinicA, patientId: patient, status: 'booked', startsAt: '2099-01-04T10:00:00.000Z' },
  { n: 6, clinicId: clinicA, patientId: otherPatient, status: 'booked', startsAt: '2026-01-05T10:00:00.000Z' },
  // Same patient id in another clinic deliberately challenges tenant isolation.
  { n: 7, clinicId: clinicB, patientId: patient, status: 'cancelled', startsAt: '2099-01-04T11:00:00.000Z' },
  { n: 8, clinicId: clinicB, patientId: foreignPatient, status: 'attended', startsAt: '2026-01-05T12:00:00.000Z' },
];

// Internal query only: no HTTP or JWT claim. The existing helper applies the real
// appointments schema. One pooled connection also exercises tenant context reuse.
describe.skipIf(!url)('RF16 patient history against PostgreSQL and RLS (I5)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;

  beforeAll(async () => {
    database = await createTestDatabase(url as string, 'rf16', 1);
    for (const fixture of fixtures) {
      await database.pool.query(`
        INSERT INTO appointment (appointment_id, clinic_id, professional_id, patient_id, service_id,
          starts_at, ends_at, duration_minutes, status, rescheduled_from_id, cancel_reason, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '30 minutes',
          30, $7, $8, $9, $10)
      `, [id(fixture.n), fixture.clinicId, fixture.n === 2 ? otherProfessional : professional,
        fixture.patientId, service, fixture.startsAt, fixture.status,
        fixture.n === 5 ? id(1) : null, fixture.status === 'cancelled' ? 'Private cancellation reason' : null, ctxA.userId]);
    }
  });

  afterAll(async () => { await database?.drop(); });

  test('returns all five current states, future appointments and separate replacements in stable descending order', async () => {
    // Explicit order: later instant first; id 3 before id 2 breaks the timestamp tie.
    const expected = [5, 4, 1, 3, 2].map((n) => {
      const fixture = fixtures.find((row) => row.n === n)!;
      return {
        appointmentId: id(n),
        professionalId: n === 2 ? otherProfessional : professional,
        serviceId: service,
        startsAt: fixture.startsAt,
        endsAt: new Date(Date.parse(fixture.startsAt) + 30 * 60_000).toISOString(),
        status: fixture.status,
        rescheduledFromId: n === 5 ? id(1) : null,
      };
    });
    assert.deepEqual(await getPatientAppointmentHistory(database, ctxA, patient), expected);
    // RF16 is clinic-scoped: a professional can read entries of another professional.
    assert.deepEqual(await getPatientAppointmentHistory(database, {
      ...ctxA, role: 'professional', professionalId: professional,
    }, patient), expected);
  });

  test('separates patients and clinics, with RLS independently hiding a foreign row even without a clinic predicate', async () => {
    const ids = async (ctx: TenantContext, patientId: string) => (
      await getPatientAppointmentHistory(database, ctx, patientId)
    ).map((row) => row.appointmentId);
    assert.deepEqual(await ids(ctxA, otherPatient), [id(6)]);
    assert.deepEqual(await ids(ctxB, patient), [id(7)]);
    assert.deepEqual(await ids(ctxA, patient), [id(5), id(4), id(1), id(3), id(2)]);

    await withTenantTx(database.db, ctxA, async (tx) => {
      const result = await tx.execute(sql`select current_user as role,
        row_security_active('appointment'::regclass) as rls,
        current_setting('transaction_read_only') as read_only`);
      assert.deepEqual(result.rows, [{ role: MEDICITAS_APP_ROLE, rls: true, read_only: 'on' }]);
      const visible = await tx.select({ appointmentId: appointment.appointmentId }).from(appointment)
        .where(eq(appointment.patientId, patient)).orderBy(appointment.appointmentId);
      assert.deepEqual(visible.map((row) => row.appointmentId), [1, 2, 3, 4, 5].map(id));
    }, { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
  });

  test('returns the same empty list for an unknown patient and one with appointments only in another clinic', async () => {
    assert.deepEqual(await getPatientAppointmentHistory(database, ctxA, id(99)), []);
    assert.deepEqual(await getPatientAppointmentHistory(database, ctxA, foreignPatient), []);
    assert.deepEqual(await getPatientAppointmentHistory(database, ctxB, otherPatient), []);
  });
});
