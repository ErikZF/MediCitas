import assert from 'node:assert/strict';
import { once } from 'node:events';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { Database } from '@medicitas/db';
import { RedisAgendaCache, type AgendaCache } from '../../cache/agenda-cache.ts';
import { relayAgendaChanges } from '../../cache/agenda-relay.ts';
import { createRedisClient } from '../../cache/redis.ts';
import { adminA, CLINIC_A, patient, PROF_1, receptionA, SERVICE_30, startBookingApp, type BookingApp } from '../helpers/booking-app.ts';

// Card E14 against real Redis and PostgreSQL. The service runs with a cache whose
// after-COMMIT invalidations are lost, as if the process died right after each COMMIT.
// The AgendaChanged events written in the same transactions let the relay repair it.
const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

const HOURS = [{ weekday: 1, startTime: '08:00', endTime: '12:00' }];
const MONDAY = '2027-04-05';
const LATER_MONDAY = '2027-04-12';

describe.skipIf(!url || !redisUrl)('agenda relay (E14): lost invalidations are applied from the outbox', () => {
  let app: BookingApp;
  let redis: Redis;
  let cache: RedisAgendaCache;
  let db: Database;
  const namespace = `relay:${process.pid}:`;

  const slots = async (date: string) => {
    const result = await app.call('GET', `/availability/professionals/${PROF_1}?serviceId=${SERVICE_30}&date=${date}`, receptionA);
    assert.equal(result.status, 200);
    return (result.body.slots as Array<{ startsAt: string }>).map((s) => s.startsAt);
  };
  const pending = async () => (await app.pool.query(
    `SELECT event_type, payload FROM outbox WHERE published_at IS NULL ORDER BY created_at`)).rows;

  beforeAll(async () => {
    redis = createRedisClient(redisUrl as string);
    if (redis.status !== 'ready') await once(redis, 'ready');
    cache = new RedisAgendaCache(redis, { namespace });
    // Reads and fills work; the direct invalidations after COMMIT never reach Redis.
    const losing: AgendaCache = {
      lookup: (...args) => cache.lookup(...args),
      fill: (entries) => cache.fill(entries),
      dayChanged: async () => {},
      professionalChanged: async () => {},
      applyDayChanged: (...args) => cache.applyDayChanged(...args),
      applyProfessionalChanged: (...args) => cache.applyProfessionalChanged(...args),
    };
    app = await startBookingApp({ adminUrl: url as string, label: 'relay', timeZone: 'UTC', workingHours: HOURS, cache: losing });
    db = drizzle({ client: app.pool }) as unknown as Database;
  });

  afterAll(async () => {
    await app?.close();
    if (redis) {
      const keys = await redis.keys(`${namespace}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });

  test('a booking whose invalidation was lost shows a stale slot until the relay runs', async () => {
    const listed = await slots(MONDAY);                        // now cached
    const booked = await app.call('POST', '/appointments', receptionA, {
      professionalId: PROF_1, patientId: patient(1), serviceId: SERVICE_30, startsAt: listed[0],
    });
    assert.equal(booked.status, 201);

    // The gap E14 closes: without the relay, the taken slot is still offered.
    assert.ok((await slots(MONDAY)).includes(listed[0]!));
    assert.deepEqual(await pending(), [{ event_type: 'AgendaChanged', payload: { professionalId: PROF_1, dates: [MONDAY] } }]);

    assert.equal(await relayAgendaChanges(db, cache), 1);
    assert.ok(!(await slots(MONDAY)).includes(listed[0]!), 'the relay invalidated the day');
    assert.deepEqual(await pending(), []);
    assert.equal(await relayAgendaChanges(db, cache), 0, 'an applied event is not applied again');
  });

  test('a new block moves every cached day of the professional', async () => {
    const before = await slots(LATER_MONDAY);
    const block = await app.call('POST', `/professionals/${PROF_1}/blocks`, adminA, {
      startsAt: `${LATER_MONDAY}T08:00:00Z`, endsAt: `${LATER_MONDAY}T12:00:00Z`,
    });
    assert.equal(block.status, 201);
    assert.deepEqual(await slots(LATER_MONDAY), before, 'stale until the relay runs');

    assert.equal(await relayAgendaChanges(db, cache), 1);
    assert.deepEqual(await slots(LATER_MONDAY), []);
  });

  test('if Redis fails, the events stay pending; other event types are never touched', async () => {
    await app.pool.query(
      `INSERT INTO outbox (clinic_id, aggregate_id, event_type, payload) VALUES ($1, $2, 'AuditRecorded', '{}')`,
      [CLINIC_A, PROF_1]);
    const booked = await app.call('POST', '/appointments', receptionA, {
      professionalId: PROF_1, patientId: patient(2), serviceId: SERVICE_30, startsAt: `${MONDAY}T10:00:00Z`,
    });
    assert.equal(booked.status, 201);

    const down = async () => { throw new Error('Redis is down'); };
    const failing: AgendaCache = {
      lookup: down, fill: down, dayChanged: down, professionalChanged: down,
      applyDayChanged: down, applyProfessionalChanged: down,
    };
    await assert.rejects(relayAgendaChanges(db, failing));
    assert.deepEqual((await pending()).map((e) => e.event_type), ['AuditRecorded', 'AgendaChanged']);

    assert.equal(await relayAgendaChanges(db, cache), 1);
    assert.deepEqual((await pending()).map((e) => e.event_type), ['AuditRecorded'], 'audit events belong to the audit relay');
  });
});
