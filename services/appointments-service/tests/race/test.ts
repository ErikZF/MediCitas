import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { patient, PROF_1, PROF_2, receptionA, SERVICE_30, startBookingApp, type BookingApp } from '../helpers/booking-app.ts';

// The guiding question of the assignment, as a reproducible test:
// "Two receptionists book the last slot at exactly the same time. What does the system do?"
//
// Every request goes through HTTP to the real service, which books against the real
// schema with its EXCLUDE constraints. The expected answer never changes: exactly one
// 201, every other request 409, and one row in the database.
const url = process.env.TEST_DATABASE_URL;
const ITERATIONS = 100;

// One slot per iteration, 30 minutes apart, starting on 2027-03-01 (UTC).
const slot = (n: number) => new Date(Date.UTC(2027, 2, 1) + n * 30 * 60_000).toISOString();

describe.skipIf(!url)('race for the last slot (I1, I2)', () => {
  let app: BookingApp;

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'race',
      timeZone: 'UTC',
      // Open all day, every day: only the race decides the outcome.
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '24:00' })),
      maxConnections: 20,
    });
  });

  afterAll(async () => { await app?.close(); });

  const bookingsAt = (startsAt: string, professionalId: string) =>
    app.pool.query(
      `SELECT count(*)::int AS n FROM appointment WHERE professional_id = $1 AND starts_at = $2 AND status = 'booked'`,
      [professionalId, startsAt],
    ).then((r) => r.rows[0].n as number);

  test(`two receptionists, same slot, ${ITERATIONS} times: always exactly one 201 and one 409`, async () => {
    for (let i = 0; i < ITERATIONS; i += 1) {
      const startsAt = slot(i);
      // Both requests are built first and sent together.
      const results = await Promise.all([1, 2].map((n) => app.call('POST', '/appointments', receptionA, {
        professionalId: PROF_1, patientId: patient(1000 + i * 2 + n), serviceId: SERVICE_30, startsAt,
      })));
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409], `iteration ${i}`);
      assert.equal(results.find((r) => r.status === 409)?.body.code, 'slot_taken');
      assert.equal(await bookingsAt(startsAt, PROF_1), 1, `iteration ${i}`);
    }
  }, 120_000);

  test('fifty receptionists, same slot: one 201, forty-nine 409', async () => {
    const startsAt = slot(ITERATIONS + 10);
    const results = await Promise.all(Array.from({ length: 50 }, (_, n) => app.call('POST', '/appointments', receptionA, {
      professionalId: PROF_1, patientId: patient(5000 + n), serviceId: SERVICE_30, startsAt,
    })));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(results.filter((r) => r.status === 409 && r.body.code === 'slot_taken').length, 49);
    assert.equal(await bookingsAt(startsAt, PROF_1), 1);
  }, 60_000);

  test('the same patient with two professionals at once: one 201, one 409 patient_overlap', async () => {
    const startsAt = slot(ITERATIONS + 20);
    const results = await Promise.all([PROF_1, PROF_2].map((professionalId) => app.call('POST', '/appointments', receptionA, {
      professionalId, patientId: patient(9000), serviceId: SERVICE_30, startsAt,
    })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)?.body.code, 'patient_overlap');
  });

  test('after every race, no professional has two overlapping booked appointments (I1)', async () => {
    const overlaps = await app.pool.query(`
      SELECT count(*)::int AS n
      FROM appointment a JOIN appointment b
        ON a.professional_id = b.professional_id
       AND a.appointment_id < b.appointment_id
       AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
      WHERE a.status = 'booked' AND b.status = 'booked'`);
    assert.equal(overlaps.rows[0].n, 0);
  });
});
