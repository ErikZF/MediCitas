import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { adminA, patient, PROF_1, receptionA, SERVICE_30, startBookingApp, type BookingApp } from '../helpers/booking-app.ts';

// Invariant I3 under concurrency: a booking and a schedule block for the same time,
// sent together. Whichever wins, nobody is left out:
//
//   booking first  -> the block is stored and returns the booking as a conflict (RF6)
//   block first    -> the booking is rejected with 422 professional_unavailable
//
// What must never happen is a booked appointment inside a block that did not report
// it. Without the agenda lock (booking: shared, block: exclusive), the booking could
// check the blocks before the block commits, and the block could look for conflicts
// before the booking commits: both succeed and neither sees the other.
const url = process.env.TEST_DATABASE_URL;
const ITERATIONS = 60;

const slot = (n: number) => new Date(Date.UTC(2027, 5, 1) + n * 60 * 60_000);

describe.skipIf(!url)('race between a booking and a schedule block (I3)', () => {
  let app: BookingApp;

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'block_race',
      timeZone: 'UTC',
      workingHours: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '24:00' })),
      maxConnections: 10,
    });
  });

  afterAll(async () => { await app?.close(); });

  test(`${ITERATIONS} races: the block always reports the booking that beat it`, async () => {
    const outcomes = { bookingFirst: 0, blockFirst: 0 };
    for (let i = 0; i < ITERATIONS; i += 1) {
      const startsAt = slot(i);
      const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
      const [booking, block] = await Promise.all([
        app.call('POST', '/appointments', receptionA, {
          professionalId: PROF_1, patientId: patient(20_000 + i), serviceId: SERVICE_30, startsAt: startsAt.toISOString(),
        }),
        app.call('POST', `/professionals/${PROF_1}/blocks`, adminA, {
          startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason: 'Reunión',
        }),
      ]);

      assert.equal(block.status, 201, `iteration ${i}: the block is always stored`);
      const conflicts = (block.body.conflicts as Array<{ appointmentId: string }>).map((c) => c.appointmentId);
      if (booking.status === 201) {
        outcomes.bookingFirst += 1;
        assert.deepEqual(conflicts, [booking.body.appointmentId], `iteration ${i}: the block must report the booking`);
      } else {
        outcomes.blockFirst += 1;
        assert.equal(booking.status, 422, `iteration ${i}`);
        assert.equal(booking.body.code, 'professional_unavailable', `iteration ${i}`);
        assert.deepEqual(conflicts, [], `iteration ${i}`);
      }
    }
    // Both orders are legitimate; the assertion above is what matters.
    assert.equal(outcomes.bookingFirst + outcomes.blockFirst, ITERATIONS);
  }, 120_000);
});
