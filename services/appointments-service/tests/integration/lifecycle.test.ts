import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { TenantContext } from '@medicitas/db';
import {
  CLINIC_A, patient, PROF_1, PROF_2, receptionA, receptionB, SERVICE_30, startBookingApp, USER,
  type BookingApp,
} from '../helpers/booking-app.ts';

// RF10-RF13 over HTTP against the real appointments schema. The tests share one agenda
// and run in order: the clock moves forward halfway, so the outcomes can be recorded.
const url = process.env.TEST_DATABASE_URL;

// 2027-01-04 is a Monday. Costa Rica is UTC-6: 08:00 local = 14:00Z.
const at = (localTime: string) => new Date(`2027-01-04T${localTime}:00-06:00`).toISOString();
const professional = (professionalId: string): TenantContext => ({ clinicId: CLINIC_A, userId: USER, role: 'professional', professionalId });

describe.skipIf(!url)('appointment life cycle (RF10-RF13)', () => {
  let app: BookingApp;
  let clock = new Date('2026-01-01T00:00:00Z');

  const book = async (professionalId: string, patientNumber: number, localTime: string) => {
    const result = await app.call('POST', '/appointments', receptionA, {
      professionalId, patientId: patient(patientNumber), serviceId: SERVICE_30, startsAt: at(localTime),
    });
    assert.equal(result.status, 201, `booking ${localTime}`);
    return result.body.appointmentId as string;
  };
  const statusOf = async (appointmentId: string) =>
    (await app.call('GET', `/appointments/${appointmentId}`, receptionA)).body.status;
  const action = (appointmentId: string, name: string, body: unknown, ctx: TenantContext = receptionA) =>
    app.call('POST', `/appointments/${appointmentId}/${name}`, ctx, body);

  // Filled as the tests go.
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'lifecycle',
      timeZone: 'America/Costa_Rica',
      workingHours: [{ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '13:00', endTime: '17:00' }],
      now: () => clock,
    });
  });

  afterAll(async () => { await app?.close(); });

  describe('before the appointments start', () => {
    test('RF11: cancel keeps the reason and who cancelled, and frees the time', async () => {
      const id = await book(PROF_1, 1, '08:00');
      const result = await action(id, 'cancel', { reason: 'Patient travelling' });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'cancelled');
      assert.equal(result.body.cancelReason, 'Patient travelling');
      const stored = await app.pool.query('SELECT cancelled_by FROM appointment WHERE appointment_id = $1', [id]);
      assert.equal(stored.rows[0].cancelled_by, USER);

      ids.rebooked = await book(PROF_1, 2, '08:00');

      const again = await action(id, 'cancel', { reason: 'Retry' });
      assert.equal(again.status, 409);
      assert.equal(again.body.code, 'invalid_transition');
    });

    test('RF11: the reason is required and nothing else is accepted', async () => {
      for (const body of [{}, { reason: '   ' }, { reason: 'x', status: 'booked' }]) {
        assert.equal((await action(ids.rebooked!, 'cancel', body)).status, 422, JSON.stringify(body));
      }
    });

    test('RF10: the old appointment becomes rescheduled and the new one points to it', async () => {
      const id = await book(PROF_1, 3, '08:30');
      const result = await action(id, 'reschedule', { startsAt: at('09:00') });
      assert.equal(result.status, 201);
      assert.equal(result.body.rescheduledFromId, id);
      assert.equal(result.body.startsAt, at('09:00'));
      assert.equal(result.body.endsAt, at('09:30'));
      assert.equal(result.body.status, 'booked');
      assert.equal(await statusOf(id), 'rescheduled');
      ids.rescheduledAway = id;
      ids.moved = result.body.appointmentId as string;
    });

    test('RF10: moving 15 minutes later may overlap the appointment being replaced', async () => {
      const result = await action(ids.moved!, 'reschedule', { startsAt: at('09:15') });
      assert.equal(result.status, 201);
    });

    test('RF10: to another professional', async () => {
      const id = await book(PROF_1, 4, '10:00');
      const result = await action(id, 'reschedule', { startsAt: at('10:00'), professionalId: PROF_2 });
      assert.equal(result.status, 201);
      assert.equal(result.body.professionalId, PROF_2);
      ids.withProf2 = result.body.appointmentId as string;
    });

    test('RF10: a taken or invalid new time rolls back and the old appointment stays booked', async () => {
      ids.late = await book(PROF_1, 5, '11:00');

      const taken = await action(ids.late, 'reschedule', { startsAt: at('08:00') });
      assert.equal(taken.status, 409);
      assert.equal(taken.body.code, 'slot_taken');
      assert.equal(await statusOf(ids.late), 'booked');

      const lunch = await action(ids.late, 'reschedule', { startsAt: at('12:00') });
      assert.equal(lunch.status, 422);
      assert.equal(lunch.body.code, 'outside_working_hours');
      assert.equal(await statusOf(ids.late), 'booked');

      const replacements = await app.pool.query('SELECT count(*)::int AS n FROM appointment WHERE rescheduled_from_id = $1', [ids.late]);
      assert.equal(replacements.rows[0].n, 0);
    });

    test('RF13: an appointment that was already rescheduled cannot be rescheduled again', async () => {
      const result = await action(ids.rescheduledAway!, 'reschedule', { startsAt: at('16:00') });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'invalid_transition');
    });

    test('two receptionists reschedule the same appointment at once: one 201, one 409', async () => {
      const id = await book(PROF_2, 6, '13:00');
      const results = await Promise.all(['14:00', '15:00'].map((time) => action(id, 'reschedule', { startsAt: at(time) })));
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      assert.equal(results.find((r) => r.status === 409)?.body.code, 'invalid_transition');
      const replacements = await app.pool.query('SELECT count(*)::int AS n FROM appointment WHERE rescheduled_from_id = $1', [id]);
      assert.equal(replacements.rows[0].n, 1);
    });

    test('RF12: no outcome before the appointment starts', async () => {
      const result = await action(ids.late!, 'outcome', { outcome: 'attended' });
      assert.equal(result.status, 422);
      assert.equal(result.body.code, 'appointment_not_started');
    });
  });

  describe('after the morning appointments started', () => {
    beforeAll(() => { clock = new Date(at('13:30')); });

    test('RF12: attended, and then the status is final (RF13)', async () => {
      const result = await action(ids.late!, 'outcome', { outcome: 'attended' });
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'attended');

      for (const [name, body] of [['outcome', { outcome: 'no_show' }], ['cancel', { reason: 'Late' }], ['reschedule', { startsAt: at('16:00') }]] as const) {
        const refused = await action(ids.late!, name, body);
        assert.equal(refused.status, 409, name);
        assert.equal(refused.body.code, 'invalid_transition', name);
      }
    });

    test('RF13 inside the engine: the trigger refuses the change even without the service', async () => {
      await assert.rejects(
        app.pool.query(`UPDATE appointment SET status = 'booked' WHERE appointment_id = $1`, [ids.late]),
        /Invalid status transition/,
      );
    });

    test('an appointment that already started cannot be cancelled or rescheduled', async () => {
      const cancel = await action(ids.withProf2!, 'cancel', { reason: 'Late' });
      assert.equal(cancel.body.code, 'appointment_started');
      const reschedule = await action(ids.withProf2!, 'reschedule', { startsAt: at('16:00') });
      assert.equal(reschedule.body.code, 'appointment_started');
    });

    test('RF12: a professional records the outcome of their own appointments only', async () => {
      const own = await action(ids.rebooked!, 'outcome', { outcome: 'no_show' }, professional(PROF_1));
      assert.equal(own.status, 200);
      assert.equal(own.body.status, 'no_show');

      const other = await action(ids.withProf2!, 'outcome', { outcome: 'attended' }, professional(PROF_1));
      assert.equal(other.status, 403);
      assert.equal(await statusOf(ids.withProf2!), 'booked');
    });
  });

  test('permissions: professionals cannot cancel or reschedule; platform_admin cannot act; another clinic sees nothing', async () => {
    const id = await book(PROF_1, 7, '16:30');
    assert.equal((await action(id, 'cancel', { reason: 'x' }, professional(PROF_1))).status, 403);
    assert.equal((await action(id, 'reschedule', { startsAt: at('16:00') }, professional(PROF_1))).status, 403);
    assert.equal((await action(id, 'cancel', { reason: 'x' }, { clinicId: null, userId: USER, role: 'platform_admin' })).status, 403);
    assert.equal((await action(id, 'cancel', { reason: 'x' }, receptionB)).status, 404);
    assert.equal((await action(patient(404), 'cancel', { reason: 'x' })).status, 404);
    assert.equal(await statusOf(id), 'booked');
  });
});
