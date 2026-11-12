// Cache of the free windows of one professional on one day (card E8, invariant I8).
//
// Cache-aside: readers look here first and fill on a miss; writers invalidate after
// their COMMIT. A key carries two counters in its name:
//
//   avail:v1:{clinic:professional}:g<gen>:v<ver>:<date>
//
//   gen  per professional. Bumped when a rule or a range changes (working hours,
//        blocks): every day of that professional moves to new keys at once.
//   ver  per professional and day. Bumped when one day changes (booking, cancelling,
//        rescheduling, recording an outcome).
//
// Why a reader can never leave a stale value where others will read it: it reads the
// counters BEFORE reading PostgreSQL and fills the key built from them. If a booking
// commits in between, the writer bumps a counter before answering 201, so every later
// reader looks for a different key; the late write lands on a key nobody reads and
// expires with its TTL. Because the counters are part of the key name, a plain SET is
// enough: no compare-and-set (Lua) is needed.
//
// The {...} hash tag keeps every key of a professional in the same Redis Cluster slot.

import type { Redis } from 'ioredis';
import type { Interval } from '../domain/availability.ts';
import { CircuitBreaker, type BreakerState } from './circuit-breaker.ts';

export interface DayRef {
  professionalId: string;
  date: string;
}

export interface CacheLookup {
  hits: Array<DayRef & { windows: Interval[] }>;
  /** `key` is where to store what PostgreSQL returns; null when the cache is not in use. */
  misses: Array<DayRef & { key: string | null }>;
}

export interface AgendaCache {
  lookup(clinicId: string, professionalIds: readonly string[], dates: readonly string[]): Promise<CacheLookup>;
  fill(entries: ReadonlyArray<{ key: string; windows: Interval[] }>): Promise<void>;
  /** After COMMIT: these days of one professional changed. Never throws. */
  dayChanged(clinicId: string, professionalId: string, dates: readonly string[]): Promise<void>;
  /** After COMMIT: a rule or a range changed (working hours, blocks). Never throws. */
  professionalChanged(clinicId: string, professionalId: string): Promise<void>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  failures: number;
}

export interface RedisAgendaCacheOptions {
  /** Safety net for orphaned keys; not what keeps the cache correct. Default 600 s. */
  ttlSeconds?: number;
  /** Prepended to every key (tests use it to run in parallel). */
  namespace?: string;
  breaker?: CircuitBreaker;
  now?: () => number;
}

// Day counters must outlive any value built from them: if a counter expired while a
// value keyed on it still existed, a later reader could pick that value up again.
const DAY_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;
const MAX_PENDING = 1000;

type Invalidation = () => Promise<unknown>;

export class RedisAgendaCache implements AgendaCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, failures: 0 };
  private readonly ttl: number;
  private readonly namespace: string;
  private readonly breaker: CircuitBreaker;
  private readonly now: () => number;
  /** Invalidations that failed and must be applied before the cache is trusted again. */
  private pending: Invalidation[] = [];
  /** When pending invalidations were dropped: skip the cache until every older value expired. */
  private bypassUntil = 0;

  constructor(private readonly redis: Redis, options: RedisAgendaCacheOptions = {}) {
    this.ttl = options.ttlSeconds ?? 600;
    this.namespace = options.namespace ?? '';
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.now = options.now ?? Date.now;
    if (this.ttl >= DAY_COUNTER_TTL_SECONDS) {
      throw new Error('The cache TTL must be shorter than the life of the day counters.');
    }
  }

  get breakerState(): BreakerState {
    return this.breaker.current;
  }

  private base(clinicId: string, professionalId: string): string {
    return `${this.namespace}avail:v1:{${clinicId}:${professionalId}}`;
  }

  /** May this pod read and write cached values right now? */
  private async usable(): Promise<boolean> {
    if (this.now() < this.bypassUntil || !this.breaker.allows()) {
      return false;
    }
    if (this.breaker.current === 'half-open' && this.pending.length > 0) {
      // Before trusting Redis again, apply what it missed.
      try {
        for (const invalidation of [...this.pending]) {
          await invalidation();
          this.pending.shift();
        }
        this.breaker.succeeded();
      } catch {
        this.stats.failures += 1;
        this.breaker.trip();
        return false;
      }
    }
    return true;
  }

  async lookup(clinicId: string, professionalIds: readonly string[], dates: readonly string[]): Promise<CacheLookup> {
    const uncached = (): CacheLookup => ({
      hits: [],
      misses: professionalIds.flatMap((professionalId) => dates.map((date) => ({ professionalId, date, key: null }))),
    });
    if (professionalIds.length === 0 || dates.length === 0 || !(await this.usable())) {
      return uncached();
    }

    try {
      // 1. The counters, read BEFORE anyone reads PostgreSQL.
      const counters = this.redis.pipeline();
      for (const professionalId of professionalIds) {
        const base = this.base(clinicId, professionalId);
        counters.mget(`${base}:gen`, ...dates.map((date) => `${base}:ver:${date}`));
      }
      const keys = unwrap(await counters.exec()).map((values, p) => {
        const [gen, ...vers] = values as Array<string | null>;
        const base = this.base(clinicId, professionalIds[p]!);
        return dates.map((date, d) => `${base}:g${gen ?? 0}:v${vers[d] ?? 0}:${date}`);
      });

      // 2. The values under those keys.
      const values = this.redis.pipeline();
      for (const professionalKeys of keys) values.mget(...professionalKeys);
      const found = unwrap(await values.exec());

      const result: CacheLookup = { hits: [], misses: [] };
      professionalIds.forEach((professionalId, p) => {
        dates.forEach((date, d) => {
          const raw = (found[p] as Array<string | null>)[d];
          if (raw == null) {
            result.misses.push({ professionalId, date, key: keys[p]![d]! });
          } else {
            result.hits.push({ professionalId, date, windows: decode(raw) });
          }
        });
      });
      this.breaker.succeeded();
      this.stats.hits += result.hits.length;
      this.stats.misses += result.misses.length;
      return result;
    } catch {
      this.stats.failures += 1;
      this.breaker.failed();
      return uncached();
    }
  }

  async fill(entries: ReadonlyArray<{ key: string; windows: Interval[] }>): Promise<void> {
    if (entries.length === 0 || !(await this.usable())) return;
    try {
      const pipeline = this.redis.pipeline();
      for (const entry of entries) pipeline.set(entry.key, encode(entry.windows), 'EX', this.ttl);
      unwrap(await pipeline.exec());
    } catch {
      // A value that was not stored is just a miss next time.
      this.stats.failures += 1;
      this.breaker.failed();
    }
  }

  async dayChanged(clinicId: string, professionalId: string, dates: readonly string[]): Promise<void> {
    if (dates.length === 0) return;
    const base = this.base(clinicId, professionalId);
    await this.invalidate(async () => {
      const transaction = this.redis.multi();
      for (const date of new Set(dates)) {
        transaction.incr(`${base}:ver:${date}`).expire(`${base}:ver:${date}`, DAY_COUNTER_TTL_SECONDS);
      }
      unwrap(await transaction.exec());
    });
  }

  async professionalChanged(clinicId: string, professionalId: string): Promise<void> {
    const base = this.base(clinicId, professionalId);
    await this.invalidate(async () => {
      await this.redis.incr(`${base}:gen`);
    });
  }

  // The data already committed, so a failed invalidation cannot fail the request. Until it
  // is applied, this pod stops reading the cache: slower answers, never stale ones.
  private async invalidate(invalidation: Invalidation): Promise<void> {
    try {
      // Retry once: most failures are a blip.
      await invalidation().catch(() => invalidation());
    } catch {
      this.stats.failures += 1;
      this.breaker.trip();
      this.pending.push(invalidation);
      if (this.pending.length > MAX_PENDING) {
        // Too much to replay: wait until every value written before now has expired.
        this.pending = [];
        this.bypassUntil = this.now() + this.ttl * 1000;
      }
    }
  }
}

/** Throws the first command error of a pipeline or transaction; returns the results. */
function unwrap(results: Array<[Error | null, unknown]> | null): unknown[] {
  if (results === null) throw new Error('Redis transaction aborted.');
  return results.map(([error, value]) => {
    if (error) throw error;
    return value;
  });
}

const encode = (windows: Interval[]) => JSON.stringify(windows.map((w) => [w.start, w.end]));
const decode = (raw: string): Interval[] => (JSON.parse(raw) as Array<[number, number]>).map(([start, end]) => ({ start, end }));

/**
 * The calendar dates an instant can fall on in any time zone (UTC−12 to UTC+14): the
 * UTC date and its neighbours. Lets a writer that does not know the clinic's zone
 * invalidate the right day by invalidating three.
 */
export function possibleLocalDates(instant: Date): string[] {
  const day = 24 * 60 * 60 * 1000;
  return [-1, 0, 1].map((offset) => new Date(instant.getTime() + offset * day).toISOString().slice(0, 10));
}
