import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import {
  CLINIC_A, patient, PROF_1, PROF_2, receptionA, receptionB, SERVICE_30, SERVICE_OTHER, startBookingApp, USER,
  type BookingApp,
} from '../helpers/booking-app.ts';

// RF7 and RF8 over HTTP against the real appointments schema.
const url = process.env.TEST_DATABASE_URL;

// 2027-01-04 is a Monday. Costa Rica is UTC-6: 08:00 local = 14:00Z.
const MONDAY = '2027-01-04';
const at = (localTime: string, date = MONDAY) => new Date(`${date}T${localTime}:00-06:00`).toISOString();
const starts = (body: Record<string, unknown>) => (body.slots as Array<{ startsAt: string }>).map((slot) => slot.startsAt);

describe.skipIf(!url)('availability (RF7, RF8)', () => {
  let app: BookingApp;

  const seedAppointment = (professionalId: string, patientId: string, localTime: string, status: string) =>
    app.pool.query(
      `INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '30 minutes', 30, $6, $7)`,
      [CLINIC_A, professionalId, patientId, SERVICE_30, at(localTime), status, USER],
    );

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'availability',
      timeZone: 'America/Costa_Rica',
      // Split shift on Mondays only.
      workingHours: [{ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '13:00', endTime: '17:00' }],
    });
    await seedAppointment(PROF_1, patient(1), '09:00', 'booked');
    // A cancelled appointment gives its time back.
    await seedAppointment(PROF_1, patient(2), '10:00', 'cancelled');
    await app.pool.query(
      `INSERT INTO schedule_block (clinic_id, professional_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, 'Reunión')`,
      [CLINIC_A, PROF_2, at('10:00'), at('11:00')],
    );
  });

  afterAll(async () => { await app?.close(); });

  test('RF7: the split shift in local time, minus the booked appointment', async () => {
    const result = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${SERVICE_30}&date=${MONDAY}`, receptionA);
    assert.equal(result.status, 200);
    assert.equal(result.body.durationMinutes, 30);
    assert.equal(result.body.timeZone, 'America/Costa_Rica');

    const slots = starts(result.body);
    assert.equal(slots.length, 15);
    assert.equal(slots[0], '2027-01-04T14:00:00.000Z');
    assert.equal(slots.at(-1), at('16:30'));
    assert.ok(!slots.includes(at('09:00')), 'booked');
    assert.ok(slots.includes(at('09:30')), 'back-to-back after the booked one');
    assert.ok(slots.includes(at('10:00')), 'cancelled appointments free their time');
    assert.ok(!slots.includes(at('12:00')) && !slots.includes(at('12:30')), 'lunch');
  });

  test('RF7: blocks remove their time', async () => {
    const result = await app.call('GET', `/availability/professionals/${PROF_2}?serviceId=${SERVICE_30}&date=${MONDAY}`, receptionA);
    const slots = starts(result.body);
    assert.equal(slots.length, 14);
    assert.ok(!slots.includes(at('10:00')) && !slots.includes(at('10:30')));
    assert.ok(slots.includes(at('11:00')));
  });

  test('RF7: a day without working hours, or already past, has no slots', async () => {
    for (const date of ['2027-01-05', '2025-12-29']) {
      const result = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${SERVICE_30}&date=${date}`, receptionA);
      assert.equal(result.status, 200, date);
      assert.deepEqual(result.body.slots, [], date);
    }
  });

  test('a slot listed as free can be booked, and then it is gone', async () => {
    const path = `/availability/professionals/${PROF_1}?serviceId=${SERVICE_30}&date=${MONDAY}`;
    const before = starts((await app.call('GET', path, receptionA)).body);
    const booked = await app.call('POST', '/appointments', receptionA, {
      professionalId: PROF_1, patientId: patient(3), serviceId: SERVICE_30, startsAt: before[0],
    });
    assert.equal(booked.status, 201);
    const after = starts((await app.call('GET', path, receptionA)).body);
    assert.ok(!after.includes(before[0]!));
    assert.equal(after.length, before.length - 1);
  });

  test('RF7: 422 service_not_offered, 404 for an unknown professional or service', async () => {
    const notOffered = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${SERVICE_OTHER}&date=${MONDAY}`, receptionA);
    assert.equal(notOffered.status, 422);
    assert.equal(notOffered.body.code, 'service_not_offered');

    const unknownProfessional = await app.call('GET', `/availability/professionals/${patient(9)}?serviceId=${SERVICE_30}&date=${MONDAY}`, receptionA);
    assert.equal(unknownProfessional.status, 404);
    const unknownService = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${patient(9)}&date=${MONDAY}`, receptionA);
    assert.equal(unknownService.status, 404);
  });

  test('RF8: professionals with room over a range, only the days that have slots', async () => {
    const result = await app.call('GET', `/availability?serviceId=${SERVICE_30}&from=${MONDAY}&to=2027-01-10`, receptionA);
    assert.equal(result.status, 200);
    const professionals = result.body.professionals as Array<{ professionalId: string; days: Array<{ date: string; slots: unknown[] }> }>;
    assert.deepEqual(professionals.map((p) => p.professionalId).sort(), [PROF_1, PROF_2].sort());
    for (const professional of professionals) {
      assert.deepEqual(professional.days.map((d) => d.date), [MONDAY]);
    }
    const second = professionals.find((p) => p.professionalId === PROF_2)!;
    assert.equal(second.days[0]!.slots.length, 14);
  });

  test('RF8: a service nobody offers, or a range without working hours, lists nobody', async () => {
    const nobody = await app.call('GET', `/availability?serviceId=${SERVICE_OTHER}&from=${MONDAY}&to=2027-01-10`, receptionA);
    assert.deepEqual(nobody.body.professionals, []);
    const weekend = await app.call('GET', `/availability?serviceId=${SERVICE_30}&from=2027-01-09&to=2027-01-10`, receptionA);
    assert.deepEqual(weekend.body.professionals, []);
  });

  test('RF8: 422 for an invalid range', async () => {
    for (const range of ['from=2027-01-10&to=2027-01-04', 'from=2027-01-01&to=2027-03-01', 'from=2027-02-30&to=2027-03-01', 'from=hoy&to=2027-01-04']) {
      const result = await app.call('GET', `/availability?serviceId=${SERVICE_30}&${range}`, receptionA);
      assert.equal(result.status, 422, range);
    }
    const missing = await app.call('GET', `/availability?from=${MONDAY}&to=${MONDAY}`, receptionA);
    assert.equal(missing.status, 422);
  });

  test('permissions: every clinic role can read; platform_admin cannot; another clinic sees nothing', async () => {
    const asProfessional = await app.call('GET', `/availability?serviceId=${SERVICE_30}&from=${MONDAY}&to=${MONDAY}`,
      { clinicId: CLINIC_A, userId: USER, role: 'professional', professionalId: PROF_2 });
    assert.equal(asProfessional.status, 200);
    assert.equal((asProfessional.body.professionals as unknown[]).length, 2);

    const asPlatform = await app.call('GET', `/availability?serviceId=${SERVICE_30}&from=${MONDAY}&to=${MONDAY}`,
      { clinicId: null, userId: USER, role: 'platform_admin' });
    assert.equal(asPlatform.status, 403);

    const fromB = await app.call('GET', `/availability?serviceId=${SERVICE_30}&from=${MONDAY}&to=${MONDAY}`, receptionB);
    assert.equal(fromB.status, 404);
  });
});
