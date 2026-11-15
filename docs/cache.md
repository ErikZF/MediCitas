# Availability cache

**English** · [Español](cache.es.md)

appointments-service caches the **free windows of one professional on one day** in Redis.
RF7 (one professional, one day) and RF8 (every professional, a date range) read it first and
load missing days from PostgreSQL. They still query service associations; a cache
hit does not eliminate every database query.

## Design

| Piece | Where | What it does |
| --- | --- | --- |
| Cache-aside | `modules/availability/availability.service.ts` | Look up, compute the misses in PostgreSQL, fill. |
| Keys | `cache/agenda-cache.ts` | `avail:v1:{clinic:professional}:g<gen>:v<ver>:<date>` |
| Invalidation | booking, lifecycle and schedule services | After `COMMIT`, bump a counter. |
| Circuit breaker | `cache/circuit-breaker.ts` | After 3 failures Redis is skipped for 5 s; requests go to PostgreSQL. |
| Wiring | `cache/redis.ts` | `CACHE_ENABLED`, `REDIS_URL`, `CACHE_TTL_SECONDS` |

**Two counters in the key name.**

- `gen` (per professional) is bumped when working hours or blocks change, which moves every day of that professional to new keys.
- `ver` (per professional and day) is bumped by booking, cancelling, rescheduling or recording an outcome.

Readers read both counters **before** reading PostgreSQL and fill the key built from them.
A writer that commits in between bumps a counter before answering, so a late fill lands on a
key nobody will read again and expires with its TTL. Because of that, a plain `SET` is enough
and no Lua compare-and-set is needed. The TTL (default 600 s) only cleans up orphaned keys; it
is not what keeps the cache correct.

**Writers that do not know the clinic's time zone** (cancel, outcome) invalidate the UTC date
and its two neighbours (`possibleLocalDates`). The extra invalidations are cheap.

A failed invalidation makes the affected process bypass the cache:

- A failed invalidation is retried once.
- If it still fails, it is queued, and the breaker opens.
- Before the cache is trusted again, the queue is replayed.
- If more than 1000 invalidations pile up, the pod skips the cache for one TTL so that every older value has expired.

If the process dies between `COMMIT` and invalidation, the in-memory queue is lost.
When caching is enabled, each transaction that changes an agenda also inserts an
`AgendaChanged` event in the `outbox` table, in the same transaction
([`db/agenda-outbox.ts`](../services/appointments-service/db/agenda-outbox.ts)):

| Write | Event payload |
| --- | --- |
| Booking | `{ professionalId, dates: [day] }` |
| Rescheduling | one event for the old day and one for the new day (they may be two professionals) |
| Cancelling, recording an outcome | `{ professionalId, dates: [UTC date and its neighbours] }` |
| Working hours, blocks | `{ professionalId, dates: null }` (every day: bumps `gen`) |

A relay in every pod ([`cache/agenda-relay.ts`](../services/appointments-service/cache/agenda-relay.ts))
claims pending events every second with `FOR UPDATE SKIP LOCKED`, applies them to Redis and
marks them published in the same transaction. If Redis fails, the transaction rolls back and
the events wait for the next pass. It runs as `medicitas_relay` and only takes
`AgendaChanged`: `AuditRecorded` events belong to the audit relay.

The direct invalidation runs after commit and before the response. The relay retries
pending invalidations; its one-second polling interval is not a bound on stale data.
A process can die after commit, or one process can fail to invalidate while another
still reads Redis. The breaker and queue are local to each process. Other processes can read a stale
entry until its pending invalidation is applied. Ordinary versioned fills
protect later lookups after a successful counter bump; they do not make a read
already in flight atomic with a concurrent write. Events are written only with caching enabled.

## Measuring it

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
TEST_REDIS_URL=redis://localhost:6379 \
npm run measure:availability -w services/appointments-service
```

The script runs the same workload twice, once without a cache (`CACHE_ENABLED=false`) and once
with Redis. Each run gets its own throwaway database with the same seed:

- 2 professionals, Monday to Friday 08:00–12:00 and 13:00–17:00, over 20 weekdays.
- 6 booked appointments per professional per day.
- A one-hour block every fifth day.

The request mix is 80 % RF7 and 20 % RF8, spread round-robin over every day and professional.
200 warm-up requests come first, then 2000 measured requests with 20 in flight. You can change
these with `MEASURE_REQUESTS` and `MEASURE_CONCURRENCY`.

*Agenda queries per request* counts the SQL statements that touch `working_hours`,
`schedule_block` or `appointment`, which is the work the cache is meant to save.

## Recorded results

These are previously reported medians of three runs on a 2 vCPU / 7 GB Linux
container with PostgreSQL 16 and Redis 7. Compose currently uses PostgreSQL 18.

| Cache | p50 | p95 | p99 | Requests/s | Agenda queries per request | Hit rate |
| --- | --- | --- | --- | --- | --- | --- |
| Off (`CACHE_ENABLED=false`) | 35.4 ms | 57.6 ms | 71.6 ms | 521 | 3.00 | — |
| On (Redis) | 20.6 ms | 30.9 ms | 41.6 ms | 904 | 0.00 | 100.0 % |

With the cache on:

- p50 and p95 are about 45 % lower.
- Throughput is about 1.7× higher.
- No agenda queries reach PostgreSQL once the cache is warm.

## Caveats

- **The hit rate is a best case.** Nothing writes during the measurement. In real use every booking bumps a day counter, so the next read of that day is a miss.
- **The latency that remains is not agenda work.** RF7 still checks in PostgreSQL that the professional offers the service. The measurement helper injects tenant context, so it measures RLS setup and JSON serialisation but not real Keycloak JWT verification.
- **clinics-service and users-service are in-memory stand-ins**, so these numbers isolate appointments-service and its database.
- The numbers describe that local workload. Network placement, writes, replicas
  and dependency latency can change the result.
- Use PostgreSQL 18 and Redis in a disposable test instance. The helper creates and
  drops databases and requires an administrative test login. The Bash environment
  assignment above is not PowerShell syntax; see [test setup](ci-cd.md).
