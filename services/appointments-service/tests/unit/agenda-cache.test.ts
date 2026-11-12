import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import type { Redis } from 'ioredis';
import { possibleLocalDates, RedisAgendaCache } from '../../cache/agenda-cache.ts';
import { CircuitBreaker } from '../../cache/circuit-breaker.ts';

describe('circuit breaker', () => {
  test('opens after the threshold, probes after the wait, closes on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 }, () => now);
    breaker.failed();
    assert.equal(breaker.current, 'closed');
    breaker.failed();
    assert.equal(breaker.current, 'open');
    assert.equal(breaker.allows(), false);

    now = 1000;
    assert.equal(breaker.current, 'half-open');
    assert.equal(breaker.allows(), true);
    breaker.succeeded();
    assert.equal(breaker.current, 'closed');
  });

  test('a failed probe opens it again at once', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 }, () => now);
    breaker.trip();
    now = 1000;
    breaker.failed();
    assert.equal(breaker.current, 'open');
  });
});

describe('possibleLocalDates', () => {
  test('the UTC date and its neighbours cover every time zone', () => {
    assert.deepEqual(possibleLocalDates(new Date('2027-01-04T14:00:00Z')), ['2027-01-03', '2027-01-04', '2027-01-05']);
  });
});

/** Just enough of ioredis for the cache: counts INCRs, and can be switched off. */
class FakeRedis {
  up = true;
  readonly values = new Map<string, string>();

  private run(ops: Array<() => unknown>) {
    return this.up ? Promise.resolve(ops.map((op) => [null, op()] as [null, unknown])) : Promise.reject(new Error('Redis is down'));
  }

  private batch() {
    const ops: Array<() => unknown> = [];
    const chain = {
      mget: (...keys: string[]) => { ops.push(() => keys.map((k) => this.values.get(k) ?? null)); return chain; },
      set: (key: string, value: string) => { ops.push(() => { this.values.set(key, value); return 'OK'; }); return chain; },
      incr: (key: string) => { ops.push(() => this.bump(key)); return chain; },
      expire: () => { ops.push(() => 1); return chain; },
      exec: () => this.run(ops),
    };
    return chain;
  }

  pipeline() { return this.batch(); }
  multi() { return this.batch(); }
  incr(key: string) { return this.up ? Promise.resolve(this.bump(key)) : Promise.reject(new Error('Redis is down')); }

  private bump(key: string): number {
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }
}

describe('agenda cache when an invalidation is lost', () => {
  const C = 'clinic', P = 'prof', DAY = '2027-01-04';

  test('stops using the cache, then replays the invalidation before trusting Redis again', async () => {
    let now = 0;
    const redis = new FakeRedis();
    const cache = new RedisAgendaCache(redis as unknown as Redis, {
      breaker: new CircuitBreaker({ failureThreshold: 3, openMs: 1000 }, () => now),
      now: () => now,
    });

    redis.up = false;
    await cache.dayChanged(C, P, [DAY]);                 // a booking committed, the INCR is lost
    assert.equal(cache.breakerState, 'open');

    redis.up = true;
    const whileOpen = await cache.lookup(C, [P], [DAY]);
    assert.equal(whileOpen.misses[0]!.key, null, 'while open, nothing is read from or written to Redis');

    now = 1000;                                          // half-open: the next use replays first
    const after = await cache.lookup(C, [P], [DAY]);
    assert.equal(redis.values.get(`avail:v1:{${C}:${P}}:ver:${DAY}`), '1', 'the lost INCR was applied');
    assert.equal(after.misses[0]!.key, `avail:v1:{${C}:${P}}:g0:v1:${DAY}`);
    assert.equal(cache.breakerState, 'closed');
  });

  test('a read never fails the request: Redis down means a miss', async () => {
    const redis = new FakeRedis();
    redis.up = false;
    const cache = new RedisAgendaCache(redis as unknown as Redis);
    const result = await cache.lookup(C, [P], [DAY]);
    assert.deepEqual(result, { hits: [], misses: [{ professionalId: P, date: DAY, key: null }] });
  });
});
