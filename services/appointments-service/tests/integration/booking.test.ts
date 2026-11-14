import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  adminA, CLINIC_A, patient, PROF_1, PROF_2, receptionA, receptionB, SERVICE_30, SERVICE_OTHER, startBookingApp, USER,
  type BookingApp,
} from '../helpers/booking-app.ts';

// RF9 over HTTP against the real appointments schema: 201 granted, 409 slot taken, 422 invalid.
const url = process.env.TEST_DATABASE_URL;

// 2027-01-04 is a Monday. Costa Rica is UTC-6: 08:00 local = 14:00Z.
const at = (localTime: string) => `2027-01-04T${localTime}:00-06:00`;
const book = (overrides: Record<string, unknown> = {}) => ({
  professionalId: PROF_1, patientId: patient(1), serviceId: SERVICE_30, startsAt: at('09:00'), ...overrides,
});

describe.skipIf(!url)('booking (RF9)', () => {
  let app: BookingApp;

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'booking',
      timeZone: 'America/Costa_Rica',
      workingHours: [{ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '13:00', endTime: '17:00' }],
    });
    await app.pool.query(
      `INSERT INTO schedule_block (clinic_id, professional_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, 'Meeting')`,
      [CLINIC_A, PROF_2, at('10:00'), at('11:00')],
    );
  });

  afterAll(async () => { await app?.close(); });

  test('201: the appointment ends when the service says and stays booked', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ startsAt: at('08:00') }));
    assert.equal(result.status, 201);
    assert.equal(result.body.startsAt, '2027-01-04T14:00:00.000Z');
    assert.equal(result.body.endsAt, '2027-01-04T14:30:00.000Z');
    assert.equal(result.body.durationMinutes, 30);
    assert.equal(result.body.status, 'booked');

    const stored = await app.pool.query('SELECT created_by FROM appointment WHERE appointment_id = $1', [result.body.appointmentId]);
    assert.equal(stored.rows[0].created_by, USER);
    const read = await app.call('GET', `/appointments/${result.body.appointmentId}`, receptionA);
    assert.deepEqual(read.body, result.body);
  });

  test('409 slot_taken: an overlapping appointment for the same professional (I1)', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ patientId: patient(2), startsAt: at('08:15') }));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'slot_taken');
  });

  test('409 patient_overlap: the same patient with another professional at the same time (I2)', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ professionalId: PROF_2, startsAt: at('08:00') }));
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'patient_overlap');
  });

  test('back-to-back is allowed: one may start exactly when another ends', async () => {
    const result = await app.call('POST', '/appointments', adminA, book({ patientId: patient(3), startsAt: at('08:30') }));
    assert.equal(result.status, 201);
  });

  test('422: the body cannot set the end or the duration (I4)', async () => {
    for (const extra of [{ endsAt: at('11:00') }, { durationMinutes: 120 }]) {
      const result = await app.call('POST', '/appointments', receptionA, book({ startsAt: at('11:00'), ...extra }));
      assert.equal(result.status, 422, JSON.stringify(extra));
    }
  });

  test('422 outside_working_hours: before the shift, over lunch, or running past its end (I3)', async () => {
    for (const time of ['07:30', '12:00', '11:45', '16:45']) {
      const result = await app.call('POST', '/appointments', receptionA, book({ patientId: patient(4), startsAt: at(time) }));
      assert.equal(result.status, 422, time);
      assert.equal(result.body.code, 'outside_working_hours', time);
    }
  });

  test('422 outside_working_hours: a day without working hours', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ startsAt: '2027-01-05T09:00:00-06:00' }));
    assert.equal(result.body.code, 'outside_working_hours');
  });

  test('422 professional_unavailable: inside a schedule block (I3)', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ professionalId: PROF_2, patientId: patient(5), startsAt: at('10:30') }));
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'professional_unavailable');
  });

  test('422 service_not_offered: the professional does not provide that service', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ serviceId: SERVICE_OTHER, startsAt: at('13:00') }));
    assert.equal(result.body.code, 'service_not_offered');
  });

  test('422 starts_in_past', async () => {
    const result = await app.call('POST', '/appointments', receptionA, book({ startsAt: '2025-12-01T09:00:00-06:00' }));
    assert.equal(result.body.code, 'starts_in_past');
  });

  test('404: a service or patient that is not in the clinic', async () => {
    const unknownService = await app.call('POST', '/appointments', receptionA, book({ serviceId: patient(99) }));
    assert.equal(unknownService.status, 404);
    const unknownPatient = await app.call('POST', '/appointments', receptionA, book({ patientId: PROF_2 }));
    assert.equal(unknownPatient.status, 404);
  });

  test('403: professionals and platform_admin cannot book', async () => {
    const asProfessional = await app.call('POST', '/appointments', { clinicId: CLINIC_A, userId: USER, role: 'professional', professionalId: PROF_1 }, book());
    assert.equal(asProfessional.status, 403);
    const asPlatform = await app.call('POST', '/appointments', { clinicId: null, userId: USER, role: 'platform_admin' }, book());
    assert.equal(asPlatform.status, 403);
  });

  test('another clinic cannot read the appointment (404, RLS)', async () => {
    const created = await app.call('POST', '/appointments', receptionA, book({ patientId: patient(6), startsAt: at('13:00') }));
    assert.equal(created.status, 201);
    const fromB = await app.call('GET', `/appointments/${created.body.appointmentId}`, receptionB);
    assert.equal(fromB.status, 404);
  });
});
