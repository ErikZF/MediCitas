// Card E8: availability latency with the Redis cache off and on.
//
//   TEST_DATABASE_URL=postgres://… TEST_REDIS_URL=redis://… npm run measure:availability -w services/appointments-service
//
// Each mode gets its own throwaway database with the same seed (two professionals,
// four weeks of split shifts, booked appointments and a few blocks) and the same
// request mix: receptionists looking at RF7 (one professional, one day) and RF8 (every
// professional, one week). The service runs in-process over real HTTP; clinics-service
// and users-service are in-memory stand-ins, so the numbers isolate the database work.

import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { Redis } from 'ioredis';
import { RedisAgendaCache } from '../cache/agenda-cache.ts';
import { createRedisClient } from '../cache/redis.ts';
import { CLINIC_A, patient, PROF_1, PROF_2, receptionA, SERVICE_30, startBookingApp, USER, type BookingApp } from '../tests/helpers/booking-app.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
const REQUESTS = Number(process.env.MEASURE_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.MEASURE_CONCURRENCY ?? 20);
const WARMUP = Math.min(200, Math.floor(REQUESTS / 10));

if (!databaseUrl || !redisUrl) {
  console.error('Set TEST_DATABASE_URL and TEST_REDIS_URL.');
  process.exit(1);
}

// Twenty weekdays in March 2027 (UTC, Monday to Friday 08:00–12:00 and 13:00–17:00).
const DAYS = Array.from({ length: 28 }, (_, i) => new Date(Date.UTC(2027, 2, 1 + i)))
  .filter((d) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5)
  .map((d) => d.toISOString().slice(0, 10));
const HOURS = [1, 2, 3, 4, 5].flatMap((weekday) => [
  { weekday, startTime: '08:00', endTime: '12:00' },
  { weekday, startTime: '13:00', endTime: '17:00' },
]);
// SQL statements that read the agenda itself (what the cache is meant to save).
const AGENDA_SQL = /\b(working_hours|schedule_block|appointment)\b/;

async function seed(app: BookingApp): Promise<void> {
  let n = 0;
  for (const [p, professionalId] of [PROF_1, PROF_2].entries()) {
    for (const [d, day] of DAYS.entries()) {
      // Six booked appointments a day, at different times per professional.
      for (const time of ['08:00', '09:00', '10:30', '13:00', '14:30', '16:00']) {
        const startsAt = new Date(`${day}T${time}:00Z`).getTime() + p * 30 * 60_000;
        await app.pool.query(
          `INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, status, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 30, 'booked', $7)`,
          [CLINIC_A, professionalId, patient(++n), SERVICE_30, new Date(startsAt), new Date(startsAt + 30 * 60_000), USER],
        );
      }
      if (d % 5 === 2) {
        await app.pool.query(
          `INSERT INTO schedule_block (clinic_id, professional_id, starts_at, ends_at, reason) VALUES ($1, $2, $3, $4, 'Reunión')`,
          [CLINIC_A, professionalId, `${day}T11:00:00Z`, `${day}T12:00:00Z`],
        );
      }
    }
  }
  await app.pool.query('ANALYZE');
}

/** The mix: four RF7 reads for every RF8 read, spread over every professional and day. */
function request(i: number): string {
  if (i % 5 === 4) {
    const week = Math.floor(i / 5) % 4;
    return `/availability?serviceId=${SERVICE_30}&from=${DAYS[week * 5]}&to=${DAYS[week * 5 + 4]}`;
  }
  const professionalId = i % 2 === 0 ? PROF_1 : PROF_2;
  return `/availability/professionals/${professionalId}?serviceId=${SERVICE_30}&date=${DAYS[Math.floor(i / 2) % DAYS.length]}`;
}

/** Counts the agenda queries the service sends, by wrapping every pooled connection. */
function countAgendaQueries(app: BookingApp): { count: number } {
  const counter = { count: 0 };
  const wrapped = new WeakSet<object>();
  app.pool.on('acquire', (client) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
      const first = args[0] as string | { text?: string } | undefined;
      const text = typeof first === 'string' ? first : first?.text ?? '';
      if (AGENDA_SQL.test(text)) counter.count += 1;
      return query(...args);
    };
  });
  return counter;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;

async function run(label: string, cache: RedisAgendaCache | undefined) {
  const app = await startBookingApp({ adminUrl: databaseUrl!, label, timeZone: 'UTC', workingHours: HOURS, maxConnections: CONCURRENCY, cache });
  try {
    await seed(app);
    const agendaQueries = countAgendaQueries(app);
    const fire = async (from: number, count: number, out?: number[]) => {
      let next = from;
      await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < from + count) {
          const path = request(next++);
          const start = performance.now();
          const response = await app.call('GET', path, receptionA);
          if (response.status !== 200) throw new Error(`${path} answered ${response.status}`);
          out?.push(performance.now() - start);
        }
      }));
    };

    await fire(0, WARMUP);                                   // warm up both PostgreSQL and Redis
    const queriesBefore = agendaQueries.count;
    const statsBefore = cache ? { ...cache.stats } : undefined;
    const latencies: number[] = [];
    const started = performance.now();
    await fire(WARMUP, REQUESTS, latencies);
    const seconds = (performance.now() - started) / 1000;
    const queries = agendaQueries.count - queriesBefore;

    latencies.sort((a, b) => a - b);
    const hits = cache && statsBefore ? cache.stats.hits - statsBefore.hits : 0;
    const misses = cache && statsBefore ? cache.stats.misses - statsBefore.misses : 0;
    return {
      label,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      throughput: REQUESTS / seconds,
      queriesPerRequest: queries / REQUESTS,
      hitRate: hits + misses > 0 ? hits / (hits + misses) : undefined,
    };
  } finally {
    await app.close();
  }
}

let redis: Redis | undefined;
try {
  const off = await run('measure_off', undefined);

  redis = createRedisClient(redisUrl);
  if (redis.status !== 'ready') await once(redis, 'ready');
  const namespace = `measure:${process.pid}:`;
  const on = await run('measure_on', new RedisAgendaCache(redis, { namespace }));
  const keys = await redis.keys(`${namespace}*`);
  if (keys.length > 0) await redis.del(...keys);

  const ms = (v: number) => `${v.toFixed(1)} ms`;
  console.log(`\n${REQUESTS} requests after ${WARMUP} warm-up, ${CONCURRENCY} concurrent, 80 % RF7 / 20 % RF8\n`);
  console.log('| Cache | p50 | p95 | p99 | Requests/s | Agenda queries per request | Hit rate |');
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of [off, on]) {
    const name = r.label === 'measure_off' ? 'Off (`CACHE_ENABLED=false`)' : 'On (Redis)';
    const hit = r.hitRate === undefined ? '—' : `${(r.hitRate * 100).toFixed(1)} %`;
    console.log(`| ${name} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.p99)} | ${r.throughput.toFixed(0)} | ${r.queriesPerRequest.toFixed(2)} | ${hit} |`);
  }
} finally {
  await redis?.quit();
}
