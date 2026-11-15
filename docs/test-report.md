# Test report

**English** · [Español](test-report.es.md)

Which test covers which functional requirement (RF) and which invariant (I), how to run
them all with one command, and what the last run gave.

## How to run them

```bash
cp .env.example .env   # first time only; the end-to-end stage uses the demo stack
npm install
npm run test:all
```

It needs Docker and Node.js 22.18 or newer, nothing else: no database to create, no
variable to export, no data to load by hand. It runs two stages:

1. **Unit, integration and race tests** of the eight workspaces. The command starts a
   throwaway PostgreSQL 18 and Redis ([`docker-compose.test.yml`](../docker-compose.test.yml),
   ports 55432 and 56379, data in memory), builds everything, runs each suite and
   removes the containers. Each suite creates its own databases from the real
   `init.sql` files, so it never touches the demo stack. About one minute.
2. **End-to-end** ([`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs)):
   25 steps through the gateway of the stack that `docker compose up` starts, with real
   Keycloak tokens, real Redis and the audit relay. The command first runs
   `docker compose up -d --build`, so the stack runs the code of this checkout and not an
   older image (only what changed is rebuilt; the data stays), and waits until Keycloak
   has the demo users.

At the end it prints one line per suite and exits with 0 only if everything passed.
The vitest reports are left in `test-results/` (ignored by git).

| Option | What it does |
| --- | --- |
| `npm run test:all -- --no-e2e` | Only stage 1 |
| `npm run test:e2e` | Only stage 2 |
| `npm run test:all -- --keep` | Leaves the test containers running |
| `npm run test:all -- --external` | Uses `TEST_DATABASE_URL` and `TEST_REDIS_URL` already set instead of starting containers (CI) |

Stage 2 leaves its traces in the demo data, as any user of the API would: a new clinic,
a service, a professional, a patient, some appointments and the outcome of one started
booking of dr.mora. `docker compose down -v` reloads the seed.

**In CI** ([ci-cd.md](ci-cd.md)), the `integration-tests` job runs stage 1 with the same
command against PostgreSQL 18 and Redis service containers, and the `e2e-compose` job
runs stage 2 the way the evaluator would: a fresh clone, `cp .env.example .env` and the
documented command.

## Last run

Stage 1, 2026-11-15, on the branch that adds this report:

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `packages/auth` | 162 | 0 | 0 |
| `packages/db` | 62 | 0 | 0 |
| `packages/http` | 9 | 0 | 0 |
| `services/edge-gateway` | 40 | 0 | 0 |
| `services/clinics-service` | 7 | 0 | 0 |
| `services/users-service` | 15 | 0 | 2 |
| `services/appointments-service` | 186 | 0 | 0 |
| `services/audit-service` | 28 | 0 | 0 |
| **Total** | **509** | **0** | **2** |

The two skipped tests of users-service create users in a disposable Keycloak realm
(`J2_TEMP_REALM=1`) that only exists on the machine of whoever runs them. What they
check (RF1 and RF2 against a real Keycloak) is also checked by the end-to-end stage,
against the realm of the stack.

Stage 2 runs on every push in the `e2e-compose` job; its result is in the GitHub Actions
tab of each commit.

## What each kind of test proves

| Kind | Where | What is real | What is replaced |
| --- | --- | --- | --- |
| **Unit** | `*/tests/unit`, `packages/auth/tests` | The logic: slot calculation and time zones, permission matrix, tenant context from the token, error mapping, retries | The database (stubs) |
| **Integration** | `*/tests/integration` | The service's HTTP app, the real schema (constraints, triggers, RLS, roles) on PostgreSQL 18, Redis | Most suites inject the identity the token would carry; several start the normal server and sign real JWTs with a test key, and `packages/auth` tests the signature checks |
| **Race** | `appointments-service/tests/race` | Concurrent HTTP requests against one database | Nothing |
| **End-to-end** | `deploy/scripts/test-all-endpoints.mjs` | The whole stack of `docker compose up`: gateway, five services, four databases, Keycloak, Redis, the relays | Nothing |

## Functional requirements

Paths are relative to each service's `tests/` folder. "E2E" is a step of the
end-to-end stage.

| RF | What is checked | Where |
| --- | --- | --- |
| **RF1** Register a clinic with its first administrator | Required first administrator, valid time zone, owner-controlled fields; the clinic, its admin in `users_db` and the Keycloak account are created together | clinics `unit/clinic-registration.test.ts`; E2E "POST /clinics" |
| **RF2** Manage users: create, logical delete, role | Cross-clinic writes and platform actors refused before touching Keycloak; a failed role assignment rolls back SQL and removes the account; public input cannot set clinic or identity | users `integration/user-management.test.ts`, `unit/user-management.test.ts`; E2E "POST /users", "PUT role & DELETE" |
| **RF3** Service catalog | CRUD of name, duration, specialty and active flag; other clinics' ids invisible; RLS enforces it on its own | clinics `integration/service-catalog.test.ts`; E2E "RF3 lifecycle" |
| **RF4** Professionals, specialties and services | Atomic registration; incompatible specialties and foreign ids refused; an assigned service yields real slots and bookings | users `integration/professionals.test.ts`; E2E "RF4" steps |
| **RF5** Weekly working hours | Split shifts, replace, overlap refused by the engine (409), own schedule only for professionals | appointments `integration/schedule.test.ts` |
| **RF6** Schedule blocks | A block lists the booked appointments it overlaps; range listing; permissions | appointments `integration/schedule.test.ts`, `race/block-vs-booking.test.ts` |
| **RF7** Free slots of a professional on a date | Split shift in local time minus bookings and blocks; past days; daylight saving; 404/422 | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF8** Availability by service over a range | Professionals with room and only the days with slots; range limits | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF9** Book | 201, 409 `slot_taken`, 409 `patient_overlap`, 422 for every invalid case (outside hours, block, service not offered, past, duration in the body), 403, 404 | appointments `integration/booking.test.ts`; E2E "POST /appointments" |
| **RF10** Reschedule | Old one `rescheduled`, new one points to it, same transaction; a failure rolls back; two receptionists at once: one 201, one 409 | appointments `integration/lifecycle.test.ts`; E2E "reschedule" |
| **RF11** Cancel | Reason and who cancelled are stored; the time is freed at once | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **RF12** Outcome | Only after the start, only by the professional of the appointment; final afterwards | appointments `integration/lifecycle.test.ts`; E2E "outcome" |
| **RF13** Valid transitions only | Forbidden transitions answer 409: leaving a final state, rescheduling twice, cancelling or rescheduling a started appointment; the trigger refuses them even without the service | appointments `integration/lifecycle.test.ts` |
| **RF14** Patients | Register and update contact atomically with its audit event; duplicates and invalid input; tenant-scoped | users `integration/patients.test.ts`; E2E "patients" |
| **RF15** Clinical note | Only the professional who attended writes and reads it; one per appointment, also under a race; reception and admin get 403 | appointments `integration/clinical-note.test.ts`; E2E "note" |
| **RF16** Patient history | Every status, stable order, separated by patient and clinic | appointments `integration/patient-history*.test.ts`, `unit/patient-history.test.ts` |
| **RF17** Authentication and authorization | Signature, issuer, audience and expiry validated against the provider's keys; 401 without a valid token, 403 for a role outside the matrix; roles from the request are never trusted | auth `jwt.test.ts`, `authorization.test.ts`, `permissions.test.ts`, `tenant-context.test.ts`; appointments `unit/app-wiring.test.ts`; E2E "401" |
| **RF18** Audit every read and write of notes and contact data | One event per access, none for a rejected attempt; no note without its event; the relay delivers every event once | appointments `integration/clinical-note.test.ts`; users `integration/patients.test.ts`; audit `integration/audit-relay.test.ts`; E2E "RF18" |
| **RF19** Audit query for the clinic admin | Filters by user, patient and dates; only clinic_admin; only its clinic | audit `integration/audit-query*.test.ts`, `integration/audit-runtime.test.ts` |
| **RF20** Daily agenda | Clinic and professional views, local-midnight boundaries (also on daylight-saving days), no clinical or contact data | appointments `integration/daily-agenda.test.ts` |
| **RF21** Counts by status | Inclusive/exclusive bounds, equivalent offsets, zeroes, only its clinic | appointments `integration/appointment-counts*.test.ts`, `unit/appointment-counts.test.ts` |

## Invariants

| Invariant | What is checked | Where |
| --- | --- | --- |
| **I1** No overlapping bookings for a professional | 2 receptionists for the same slot, 100 times: always one 201 and one 409; 50 at once: one 201 and 49 409; afterwards no professional has two overlapping bookings. Also a plain 409 `slot_taken` | appointments `race/test.ts`, `integration/booking.test.ts`; db `integration/tenant-tx.test.ts` |
| **I2** No overlapping bookings for a patient in a clinic | Same patient with two professionals at once: one 201, one 409 `patient_overlap`, also concurrently | appointments `race/test.ts`, `integration/booking.test.ts` |
| **I3** Inside working hours and outside blocks | 422 outside hours or inside a block; a booking and a block sent together 60 times: the block always reports the booking that beat it | appointments `integration/booking.test.ts`, `race/block-vs-booking.test.ts` |
| **I4** Duration set by the service | The body cannot send the end or the duration (422); the end is always start + the service's minutes; `CHECK` in the schema | appointments `integration/booking.test.ts` |
| **I5** No data of one clinic reachable from another | Every suite repeats its calls from a second clinic (404 or empty), including manipulated ids, query parameters and headers; RLS tested without the code's `WHERE`; pooled connections keep no context. The same leak attempts against RLS and against the column alone ([rls-comparison.md](rls-comparison.md)) | db `integration/tenant-tx.test.ts`; appointments `integration/rls-vs-column.test.ts`, `integration/*` (booking, schedule, availability, lifecycle, clinical-note, daily-agenda, patient-history, counts); users `integration/patients.test.ts`, `user-management.test.ts`; clinics `integration/service-catalog.test.ts`; audit `integration/audit-query.test.ts`, `audit-append-only.test.ts`; auth `authorization.test.ts` |
| **I6** Audit log not modifiable by the application | The application role cannot `UPDATE`, `DELETE` or `TRUNCATE` it (no privilege), and triggers refuse all three even to the table owner | audit `integration/audit-append-only.test.ts`, `integration/audit-relay.test.ts` |
| **I7** Cancelling or rescheduling frees the slot at once | The slot shows up free in the next query, also when cached | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **I8** Availability never contradicts the database | Book a listed slot and query again: gone, without waiting for any expiry; interleaved readers and writers; lost invalidations recovered from the outbox; Redis down falls back to PostgreSQL | appointments `integration/availability-cache.test.ts`, `integration/agenda-relay.test.ts`, `unit/agenda-cache.test.ts`; E2E "Redis cache invalidation" |

**Least-privilege database roles** (core module 5): every request runs as the database role
of its actor. appointments `integration/db-roles.test.ts` checks the privilege matrix of
each role and that a booking fails when its actor's role loses `INSERT` while the
administrator's still works; db `integration/tenant-tx.test.ts` checks that reception and
administration cannot read clinical notes at engine level.

## Acceptance criteria of the statement

| # | Criterion | How it is shown |
| --- | --- | --- |
| 1 | It starts by itself | `docker compose up` (README); the `e2e-compose` job does it from a fresh clone |
| 2 | The appointment cycle works | RF9-RF13 above; E2E books, reschedules, cancels and records an outcome |
| 3 | Identity is required and respected | RF17 above; E2E checks 401 without a token and 403 with the wrong role |
| 4 | Isolation holds | I5 above |
| 5 | The cache does not lie | I8 above |
| 6 | The race has one winner | I1 above (`race/test.ts`, reproducible: 100 iterations every run) |
| 7 | The tests run | `npm run test:all` |
