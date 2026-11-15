# Concurrency: the last slot

**English** · [Español](concurrency.es.md)

> Two receptionists book the last slot of the agenda at exactly the same time.
> What does the system do, why, and how is it shown?

## The answer

One booking is granted with **201** and the other is rejected with **409 `slot_taken`**.
The database never holds two overlapping `booked` appointments for that professional (I1).
This does not depend on timing, on the number of service replicas or on the cache:
PostgreSQL decides it at the moment of the `INSERT`, through an exclusion constraint.

## What happens, step by step

```text
Receptionist A (T1)                           Receptionist B (T2)
-------------------                           -------------------
BEGIN (READ COMMITTED)                        BEGIN (READ COMMITTED)
advisory lock: professional, then patient     advisory lock on the professional:
                                                waits for T1
checks: service offered, inside working
hours, no block
INSERT appointment 09:00-09:30
COMMIT -> 201 (releases the locks)            gets the locks
                                              same checks: they pass too (none of them
                                                looks at other appointments)
                                              INSERT appointment 09:00-09:30
                                                -> the EXCLUDE finds T1's committed row
                                                -> 23P01
                                              ROLLBACK -> 409 slot_taken
```

T2 passes every check: none of them looks at other appointments. The checks are not
what protects the slot, and neither is the lock (it only puts the two inserts in line;
see [below](#why-bookings-also-wait-for-each-other)). The protection is the constraint in
[`database/appointments/init.sql`](../database/appointments/init.sql):

```sql
CONSTRAINT no_overlap_professional EXCLUDE USING gist (
    clinic_id                           WITH =,
    professional_id                     WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status = 'booked')
```

- **`EXCLUDE ... WITH &&`** forbids two rows whose intervals overlap. The engine checks it
  against rows that other transactions have inserted but not yet committed, and makes
  the second one wait for the first. If the first commits, the second fails with `23P01`;
  if the first rolls back, the second goes through.
- **`'[)'`** includes the start and excludes the end, so 09:00-09:30 and 09:30-10:00 do
  not overlap: back-to-back appointments are allowed.
- **`WHERE (status = 'booked')`** only counts active appointments. Cancelling or
  rescheduling frees the time in the same `COMMIT` (I7).
- `@medicitas/db` maps `23P01` on this constraint to **409 `slot_taken`**, and on
  `no_overlap_patient` to **409 `patient_overlap`** (I2). The client never sees SQLSTATE.

### Why bookings also wait for each other

Earlier development notes report contention in CI and local runs. Overlapping
inserts can deadlock: when two
transactions insert overlapping rows at the same moment, each one finds the *other's*
uncommitted row in the index and waits for it. That is a cycle: PostgreSQL detects it
after `deadlock_timeout` (1 s) and aborts one with `40P01`, which `withTenantTx` retries.
With fifty bookings of the same slot the cycles chain, and the race test's fifty-client
case went past 60 seconds on GitHub Actions (four cores), while passing on two-core
machines. The PostgreSQL log of a local run had one `deadlock detected` every few runs.

So bookings and rescheduling take a **transaction advisory lock on the professional and on
the patient** before inserting ([`db/locks.ts`](../services/appointments-service/db/locks.ts)).
The second writer waits for the lock, then finds the first row already **committed**, and
the constraint answers `23P01` at once: no deadlock, no 1-second wait. After the change,
eight consecutive local runs of the race tests logged zero deadlocks. The cost: bookings of
the same professional, or of the same patient, run one at a time, including non-overlapping slots. Different professionals can run in parallel when
they do not share a patient or another lock.

## Isolation level: READ COMMITTED

`withTenantTx` sets it explicitly on every transaction (`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`),
so it does not depend on what the driver or the ORM chose by default.

**It is enough** because correctness does not come from what a transaction reads. Two
transactions that read "the slot is free" at the same time is exactly the case shown
above, and the constraint resolves it at write time.

**Why not SERIALIZABLE.**

- It would also prevent the double booking, but by aborting one transaction with `40001`.
  That is a generic error: the service would have to retry and only then learn that the
  slot is taken. With the constraint, the answer is direct and specific (`slot_taken`).
- It tracks read dependencies (predicate locks), so it aborts transactions that did not
  actually conflict. Under load that means more retries and more latency.
- For local overlap checks, the constraints and locks provide the chosen guarantee.
  SERIALIZABLE would not make external catalog/patient reads part of this transaction.

**Why not REPEATABLE READ.** It gives each transaction a fixed snapshot, which does not
help: both would still see the slot as free. In PostgreSQL it can also abort an update
with `40001` when a row changed after the snapshot.

## The other invariants under concurrency

| Invariant | What enforces it | Where |
| --- | --- | --- |
| **I1** no overlap per professional | `no_overlap_professional` (EXCLUDE) | `init.sql` |
| **I2** no overlap per patient in a clinic | `no_overlap_patient` (EXCLUDE) | `init.sql` |
| **I3** checks for new bookings; later schedule changes can leave conflicts | Checks inside the transaction plus a **transaction advisory lock** per professional, taken by bookings, rescheduling and schedule changes | `db/locks.ts` |
| **I4** duration taken from catalog at booking/reschedule | The body cannot send it; `CHECK (ends_at = starts_at + duration_minutes)` | `slot-rules.ts`, `init.sql` |
| **I7** cancelling frees the slot at once | The constraints only count `booked`; the change and the release are one `COMMIT` | `init.sql`, `lifecycle.service.ts` |
| **RF13** valid transitions only | `SELECT ... FOR UPDATE` on the appointment, plus a trigger that rejects leaving a final state | `lifecycle.service.ts`, `init.sql` |

**How schedule changes are ordered.** A booking checks the blocks, and a new block looks for the
bookings it overlaps. Without coordination both can run at the same time: the booking
sees no block, the block sees no booking, and both commit. The professional's lock forces an
order: a booking and a schedule change of the same professional never run at the same
time. Whoever goes second sees the first: a booking that comes later
gets **422 `professional_unavailable`**, and a block that comes later returns the booking
in its `conflicts` list (RF6). It is a transaction-level lock (`pg_advisory_xact_lock`):
it is released on `COMMIT` or `ROLLBACK`. A later block can leave existing booked
appointments as conflicts (RF6), and replacing working hours does not revalidate
existing bookings. The literal I3 claim for every booked appointment at all times
is therefore not guaranteed; the lock orders writes without resolving those conflicts.

**Rescheduling (RF10)** runs in one transaction: it locks the old appointment
(`FOR UPDATE`), marks it `rescheduled` and inserts the new one. Because the old row
stops counting first, moving an appointment 15 minutes later works even though the two
intervals overlap. If the new time is taken, the whole transaction rolls back and the
original booking stays as it was.

## Conflicts and deadlocks

- **Expected conflicts** become stable codes: `slot_taken`, `patient_overlap`,
  `invalid_transition` (409) and `professional_unavailable` (422).
- **Retries.** `withTenantTx` retries the whole transaction on `40001` (serialization
  failure) and `40P01` (deadlock), up to 3 attempts with exponential backoff and jitter
  (20 ms base, 250 ms maximum). PostgreSQL has already rolled the transaction back, so
  running it again is safe. If every attempt fails: **409 `concurrency_conflict`**.
- **Avoiding deadlocks.**
  - Every transaction takes its advisory locks in **one global order**: the professionals
    sorted by id, then the patient. Rescheduling to another professional takes both
    professionals that way. This reduces cycles among advisory locks; row locks
    and other database operations can still deadlock, so retries remain necessary.
  - The race between two uncommitted overlapping inserts, which PostgreSQL can only break
    with a deadlock, cannot happen: the locks put those inserts in line (see above).
  - Calls to other services (catalog, patients) happen before the mutating transaction,
    and Redis invalidations **after** the `COMMIT`. A retried transaction never repeats them,
    and no lock is held while waiting on the network.

## The cache cannot create a second winner

Availability may be served from Redis, but a booking never reads the cache: it decides
against PostgreSQL. Even if a stale copy showed a taken slot as free, the `INSERT` would
fail with 409. Cache consistency has separate failure and multi-replica limits
(see [cache.md](cache.md)); I1/I2 do not depend on a fresh cache answer.

## Alternatives we discarded

| Alternative | Why not |
| --- | --- |
| **Check-then-act** (`SELECT` free slots, then `INSERT`) | Both transactions see the slot as free and both insert. It is exactly the bug the question looks for. |
| **`SELECT ... FOR UPDATE` on the professional** | `appointments_db` has no professional row (it lives in `users_db`), and it would not cover I2, which crosses professionals. The advisory locks give the same ordering for both, without a row. |
| **A lock in Redis** | Redis is not the source of truth. A lock with a TTL can expire while the transaction is still running, and a Redis failure would block or break bookings. The guarantee would live outside the database that stores the data. |
| **SERIALIZABLE** | Correct, but answers with a generic `40001`, needs retries and aborts transactions that did not conflict. See above. |
| **A mutex in the service** | Only works inside one process. With two replicas it protects nothing. |

## How it is shown

| Test | Expected assertions |
| --- | --- |
| [`tests/race/test.ts`](../services/appointments-service/tests/race/test.ts) | 2 receptionists, same slot, **100 iterations**: always exactly one 201 and one 409 `slot_taken`, and one row. Then **50** at once: one 201 and 49 409. Same patient with two professionals: 409 `patient_overlap` (I2). Finally, no professional has two overlapping `booked` appointments (I1). |
| [`tests/race/block-vs-booking.test.ts`](../services/appointments-service/tests/race/block-vs-booking.test.ts) | A booking and a block for the same time, **60 iterations** (I3): either the block reports the booking as a conflict, or the booking gets 422. Removing the lock from the booking makes it fail within the first iterations. |
| [`tests/integration/lifecycle.test.ts`](../services/appointments-service/tests/integration/lifecycle.test.ts) | Cancelling frees the time at once (I7); two receptionists rescheduling the same appointment get one 201 and one 409; a failed reschedule rolls back; the trigger rejects invalid transitions even without the service (RF13). |
| [`packages/db/tests`](../packages/db/tests) | READ COMMITTED is set explicitly; retries of `40001`/`40P01`; nothing of a tenant's context survives a commit or a rollback. |

The race/lifecycle tests use real HTTP handlers and PostgreSQL on throwaway databases,
with injected identity and catalog/patient dependencies. `packages/db` tests include
unit and direct SQL integration checks. From Bash, after installing dependencies
and building shared packages, point only to a disposable PostgreSQL 18 instance
with an administrative test login:

```bash
TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5433/postgres' \
npm test -w services/appointments-service
```

## Known limits

- **No `Idempotency-Key` yet.** If the response to a 201 is lost and the client retries,
  the retry gets 409 (`slot_taken` or `patient_overlap`: it overlaps its own booking).
  Nothing is booked twice, but the client cannot tell that the first attempt succeeded.
- **Bookings of one professional or one patient are serial.** It is the price of avoiding
  the deadlocks above; it only limits how fast a single agenda can take bookings.
- **One database decides.** The guarantee holds because both bookings reach the same
  PostgreSQL. A future sharding by clinic keeps it, since a booking never crosses clinics;
  writing one clinic's agenda from two regions would not.
