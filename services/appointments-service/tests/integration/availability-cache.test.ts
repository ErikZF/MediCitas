import assert from 'node:assert/strict';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { Redis } from 'ioredis';
import { RedisAgendaCache } from '../../cache/agenda-cache.ts';
import { createRedisClient } from '../../cache/redis.ts';
import {
  adminA, CLINIC_A, patient, PROF_1, PROF_2, receptionA, SERVICE_30, startBookingApp,
  type BookingApp,
} from '../helpers/booking-app.ts';

// E8 against a real Redis and the real schema: the cache serves repeated reads, and no
// read made after a 201 ever shows the slot that was just taken (I8).
const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

// Mondays in 2027, one per test so they never share a cached day. Costa Rica is UTC-6.
const at = (date: string, time: string) => new Date(`${date}T${time}:00-06:00`).toISOString();
const MONDAYS = ['2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25', '2027-02-01', '2027-02-08', '2027-02-15'];
const HOURS = [{ weekday: 1, startTime: '08:00', endTime: '12:00' }, { weekday: 1, startTime: '13:00', endTime: '17:00' }];

async function ready(client: Redis): Promise<Redis> {
  if (client.status !== 'ready') await once(client, 'ready');
  return client;
}

describe.skipIf(!url || !redisUrl)('availability cache (E8, I8)', () => {
  let app: BookingApp;
  let redis: Redis;
  let cache: RedisAgendaCache;
  const namespace = `test:${process.pid}:`;

  const slots = async (professionalId: string, date: string) => {
    const result = await app.call('GET', `/availability/professionals/${professionalId}?serviceId=${SERVICE_30}&date=${date}`, receptionA);
    assert.equal(result.status, 200);
    return (result.body.slots as Array<{ startsAt: string }>).map((s) => s.startsAt);
  };
  const book = (professionalId: string, patientNumber: number, startsAt: string) =>
    app.call('POST', '/appointments', receptionA, { professionalId, patientId: patient(patientNumber), serviceId: SERVICE_30, startsAt });

  beforeAll(async () => {
    redis = await ready(createRedisClient(redisUrl as string));
    cache = new RedisAgendaCache(redis, { namespace });
    app = await startBookingApp({ adminUrl: url as string, label: 'cache', timeZone: 'America/Costa_Rica', workingHours: HOURS, cache });
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });

  test('the second read of a day is served from Redis', async () => {
    const before = { ...cache.stats };
    const first = await slots(PROF_1, MONDAYS[0]!);
    const second = await slots(PROF_1, MONDAYS[0]!);
    assert.deepEqual(second, first);
    assert.equal(cache.stats.misses - before.misses, 1);
    assert.equal(cache.stats.hits - before.hits, 1);
  });

  test('I8: a slot booked right after it was listed is gone at once', async () => {
    const listed = await slots(PROF_1, MONDAYS[0]!);           // cached
    const booked = await book(PROF_1, 1, listed[0]!);
    assert.equal(booked.status, 201);
    const after = await slots(PROF_1, MONDAYS[0]!);
    assert.ok(!after.includes(listed[0]!));
    assert.equal(after.length, listed.length - 1);
  });

  test('a reader that read before the booking cannot hand its stale copy to anyone', async () => {
    const day = MONDAYS[1]!;
    // The reader reads the counters (and, say, PostgreSQL) before the booking commits...
    const lookup = await cache.lookup(CLINIC_A, [PROF_2], [day]);
    const staleKey = lookup.misses[0]!.key!;
    // ...the booking commits and bumps the day...
    assert.equal((await book(PROF_2, 2, at(day, '09:00'))).status, 201);
    // ...and the reader writes its stale copy late, with the whole day free.
    await cache.fill([{ key: staleKey, windows: [{ start: Date.parse(at(day, '08:00')), end: Date.parse(at(day, '17:00')) }] }]);

    assert.equal(await redis.exists(staleKey), 1, 'the stale copy is in Redis');
    assert.ok(!(await slots(PROF_2, day)).includes(at(day, '09:00')), 'but nobody reads it');
  });

  test('cancelling frees the slot at once', async () => {
    const day = MONDAYS[2]!;
    const booked = await book(PROF_1, 3, at(day, '10:00'));
    assert.ok(!(await slots(PROF_1, day)).includes(at(day, '10:00')));    // now cached without 10:00
    const cancelled = await app.call('POST', `/appointments/${booked.body.appointmentId}/cancel`, receptionA, { reason: 'Paciente avisó' });
    assert.equal(cancelled.status, 200);
    assert.ok((await slots(PROF_1, day)).includes(at(day, '10:00')));
  });

  test('rescheduling updates both days, even for another professional', async () => {
    const [from, to] = [MONDAYS[3]!, MONDAYS[4]!];
    const booked = await book(PROF_1, 4, at(from, '11:00'));
    await slots(PROF_1, from);
    await slots(PROF_2, to);                                              // both days cached
    const moved = await app.call('POST', `/appointments/${booked.body.appointmentId}/reschedule`, receptionA,
      { startsAt: at(to, '14:00'), professionalId: PROF_2 });
    assert.equal(moved.status, 201);
    assert.ok((await slots(PROF_1, from)).includes(at(from, '11:00')));
    assert.ok(!(await slots(PROF_2, to)).includes(at(to, '14:00')));
  });

  test('reads and bookings interleaved: no read after a 201 shows that slot', async () => {
    const day = MONDAYS[5]!;
    await slots(PROF_1, day);
    for (let i = 0; i < 16; i += 1) {
      const startsAt = new Date(Date.parse(at(day, '08:00')) + i * 30 * 60_000 + (i >= 8 ? 60 * 60_000 : 0)).toISOString();
      const [booked] = await Promise.all([book(PROF_1, 100 + i, startsAt), slots(PROF_1, day), slots(PROF_1, day)]);
      assert.equal(booked.status, 201, startsAt);
      assert.ok(!(await slots(PROF_1, day)).includes(startsAt), startsAt);
    }
    assert.deepEqual(await slots(PROF_1, day), [], 'the whole day is booked');
  });

  test('a block or a new weekly schedule applies at once to every cached day', async () => {
    const [d1, d2] = [MONDAYS[6]!, MONDAYS[1]!];
    await slots(PROF_2, d1);
    await slots(PROF_2, d2);                                              // two days cached

    const blocked = await app.call('POST', `/professionals/${PROF_2}/blocks`, adminA, { startsAt: at(d1, '13:00'), endsAt: at(d1, '17:00') });
    assert.equal(blocked.status, 201);
    assert.equal((await slots(PROF_2, d1)).length, 8, 'the afternoon is gone');

    const replaced = await app.call('PUT', `/professionals/${PROF_2}/working-hours`, adminA,
      { workingHours: [{ weekday: 1, startTime: '08:00', endTime: '09:00' }] });
    assert.equal(replaced.status, 200);
    assert.deepEqual(await slots(PROF_2, d2), [at(d2, '08:00'), at(d2, '08:30')], 'was 15 slots, cached');
  });
});

describe.skipIf(!url)('availability with Redis unreachable', () => {
  let app: BookingApp;
  let redis: Redis;
  let cache: RedisAgendaCache;

  beforeAll(async () => {
    redis = createRedisClient('redis://127.0.0.1:1');
    cache = new RedisAgendaCache(redis);
    app = await startBookingApp({ adminUrl: url as string, label: 'nocache', timeZone: 'America/Costa_Rica', workingHours: HOURS, cache });
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
  });

  test('reads come from PostgreSQL and bookings still answer 201', async () => {
    const day = MONDAYS[0]!;
    const read = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${SERVICE_30}&date=${day}`, receptionA);
    assert.equal(read.status, 200);
    assert.equal((read.body.slots as unknown[]).length, 16);

    const booked = await app.call('POST', '/appointments', receptionA, { professionalId: PROF_1, patientId: patient(1), serviceId: SERVICE_30, startsAt: at(day, '08:00') });
    assert.equal(booked.status, 201);
    assert.equal(cache.breakerState, 'open', 'the lost invalidation opens the breaker');
    assert.ok(cache.stats.failures > 0);
  });
});
