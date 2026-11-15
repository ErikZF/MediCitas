# Test report

**English** · [Español](test-report.es.md)

Coverage by functional requirement (RF) and invariant (I), runner options and
recorded results.

## How to run them

```bash
npm install
npm run test:all
```

Prepare `.env` only if absent, following the [root README](../README.md#local-startup).
The runner requires Docker with Compose, Node.js >=22.18, npm dependencies and
free test ports. It automates PostgreSQL/Redis setup, but does not prepare the
opt-in `j2` Keycloak fixture. It runs two stages:

1. **Unit, integration and race tests** of the eight workspaces. The command starts a
   throwaway PostgreSQL 18 and Redis ([`docker-compose.test.yml`](../docker-compose.test.yml),
   ports 55432 and 56379, data in memory), builds everything, runs each suite and
   removes the containers. Each suite creates its own databases from the real
   `init.sql` files. This stage is separate from the demo stack. Its default
   cleanup removes the test project with volumes/orphans; `--keep` disables cleanup.
   It also replaces the local `test-results/` directory. Duration depends on the machine.
2. **End-to-end** ([`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs)):
   25 steps through the gateway of the stack that `docker compose up` starts, with real
   Keycloak tokens, real Redis and the audit relay. The command first runs
   `docker compose up -d --build`, so the stack runs the code of this checkout and not an
   older image (only what changed is rebuilt; the data stays), and waits until Keycloak
   has the demo users.

At the end it prints one line per suite. Exit 0 means the invoked stages passed;
Vitest can still report skipped tests, including the temporary-realm tests.
The vitest reports are left in `test-results/` (ignored by git).

| Option | What it does |
| --- | --- |
| `npm run test:all -- --no-e2e` | Only stage 1 |
| `npm run test:e2e` | Only stage 2 |
| `npm run test:all -- --keep` | Leaves the test containers running |
| `npm run test:all -- --external` | Uses preconfigured test URLs instead of containers; still runs stage 2 unless combined with `--no-e2e` |

Stage 2 leaves its traces in the demo data, as any user of the API would: a new clinic,
a service, a professional, a patient, some appointments and the outcome of one started
booking of dr.mora. It rebuilds the demo stack and retains its database volumes.
Use disposable local demo data, not shared databases. The walkthrough consumes
804 or another eligible started booking in the last 45 days; eventually the
prepared bookings can be exhausted. Do not use volume deletion to reset shared data.

**In CI** ([ci-cd.md](ci-cd.md)), the `integration-tests` job runs stage 1 with the same
command against PostgreSQL 18 and Redis service containers, and the `e2e-compose` job
runs stage 2 the way the evaluator would: a fresh clone, `cp .env.example .env` and the
documented command.

## Recorded stage-1 run

Stage-1 results recorded in `69a9c81` for 2026-11-15:

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `packages/auth` | 162 | 0 | 0 |
| `packages/db` | 62 | 0 | 0 |
| `packages/http` | 9 | 0 | 0 |
| `services/edge-gateway` | 40 | 0 | 0 |
| `services/clinics-service` | 7 | 0 | 0 |
| `services/users-service` | 15 | 0 | 2 |
| `services/appointments-service` | 161 | 0 | 0 |
| `services/audit-service` | 28 | 0 | 0 |
| **Total** | **484** | **0** | **2** |

The two skipped tests of users-service create users in a disposable Keycloak realm
(`J2_TEMP_REALM=1`) that only exists on the machine of whoever runs them. What they
check has separate RF1/RF2 coverage in the E2E stage against the demo realm; this
does not mean the omitted fixture tests ran. See [Keycloak test prerequisites](ci-cd.md).

The workflow configures stage 2 for pushes to `main`, `feat/**`, `fix/**` and PRs
to `main`. See [CI configuration](ci-cd.md).

## What each kind of test proves

| Kind | Where | What is real | What is replaced |
| --- | --- | --- | --- |
| **Unit** | `*/tests/unit`, `packages/auth/tests` | The logic: slot calculation and time zones, permission matrix, tenant context from the token, error mapping, retries | The database (stubs) |
| **Integration** | `*/tests/integration` | The service's HTTP app, the real schema (constraints, triggers, RLS, roles) on PostgreSQL 18, Redis | Most suites inject the identity the token would carry; several start the normal server and sign real JWTs with a test key, and `packages/auth` tests the signature checks |
| **Race** | `appointments-service/tests/race` | Concurrent HTTP handlers against PostgreSQL | Identity and catalog/patient dependencies are injected |
| **End-to-end** | `deploy/scripts/test-all-endpoints.mjs` | The stack of `docker compose up`: five HTTP services including the gateway, four databases, Keycloak, Redis, the relays | Nothing |

## Functional requirements

Paths are relative to each service's `tests/` folder. "E2E" is a step of the
end-to-end stage.

| RF | What is checked | Where |
| --- | --- | --- |
| **RF1** Register a clinic with its first administrator | Required first administrator, valid time zone, owner-controlled fields; onboarding coordinates the clinic, `users_db` and Keycloak with recovery steps, not a distributed transaction | clinics `unit/clinic-registration.test.ts`; E2E "POST /clinics" |
| **RF2** Manage users: create, logical delete, role | Cross-clinic writes and platform actors refused before touching Keycloak; a failed role assignment rolls back SQL and removes the account; public input cannot set clinic or identity | users `integration/user-management.test.ts`, `unit/user-management.test.ts`; E2E "POST /users", "PUT role & DELETE" |
| **RF3** Service catalog | CRUD of name, duration, specialty and active flag; other clinics' ids invisible; RLS enforces it on its own | clinics `integration/service-catalog.test.ts`; E2E "RF3 lifecycle" |
| **RF4** Professionals, specialties and services | Local profile registration followed by Keycloak claim synchronization; incompatible specialties and foreign ids refused; an assigned service yields real slots and bookings | users `integration/professionals.test.ts`; E2E "RF4" steps |
| **RF5** Weekly working hours | Split shifts, replace, overlap refused by the engine (409), own schedule only for professionals | appointments `integration/schedule.test.ts` |
| **RF6** Schedule blocks | A block lists the booked appointments it overlaps; range listing; permissions | appointments `integration/schedule.test.ts`, `race/block-vs-booking.test.ts` |
| **RF7** Free slots of a professional on a date | Split shift in local time minus bookings and blocks; past days; daylight saving; 404/422 | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF8** Availability by service over a range | Professionals with room and only the days with slots; range limits | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF9** Book | 201, 409 `slot_taken`, 409 `patient_overlap`, 422 for every invalid case (outside hours, block, service not offered, past, duration in the body), 403, 404 | appointments `integration/booking.test.ts`; E2E "POST /appointments" |
| **RF10** Reschedule | Old one `rescheduled`, new one points to it, same transaction; a failure rolls back; two receptionists at once: one 201, one 409 | appointments `integration/lifecycle.test.ts`; E2E "reschedule" |
| **RF11** Cancel | Reason and who cancelled are stored; the time is freed at once | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **RF12** Outcome | After the start; clinic_admin/receptionist or the owning professional; final afterwards | appointments `integration/lifecycle.test.ts`; E2E "outcome" |
| **RF13** Valid transitions only | Leaving a final state/rescheduling twice returns 409; cancelling/rescheduling after start returns 422; the trigger also rejects invalid status transitions | appointments `integration/lifecycle.test.ts` |
| **RF14** Patients | Register and update contact atomically with its audit event; duplicates and invalid input; tenant-scoped | users `integration/patients.test.ts`; E2E "patients" |
| **RF15** Clinical note | Only the professional who attended writes and reads it; one per appointment, also under a race; reception and admin get 403 | appointments `integration/clinical-note.test.ts`; E2E "note" |
| **RF16** Patient history | Every status, stable order, separated by patient and clinic | appointments `integration/patient-history*.test.ts`, `unit/patient-history.test.ts` |
| **RF17** Authentication and authorization | Signature, issuer, audience and expiry validated against the provider's keys; 401 without a valid token, 403 for a role outside the matrix; roles from the request are never trusted | auth `jwt.test.ts`, `authorization.test.ts`, `permissions.test.ts`, `tenant-context.test.ts`; appointments `unit/app-wiring.test.ts`; E2E "401" |
| **RF18** Audit every read and write of notes and contact data | Note reads/writes and contact writes queue events atomically; no contact-read endpoint; relay retries are deduplicated by event ID | appointments `integration/clinical-note.test.ts`; users `integration/patients.test.ts`; audit `integration/audit-relay.test.ts`; E2E "RF18" |
| **RF19** Audit query for the clinic admin | Filters by user, patient and dates; only clinic_admin; only its clinic | audit `integration/audit-query*.test.ts`, `integration/audit-runtime.test.ts` |
| **RF20** Daily agenda | Clinic and professional views, local-midnight boundaries (also on daylight-saving days), no clinical or contact data | appointments `integration/daily-agenda.test.ts` |
| **RF21** Counts by status | Inclusive/exclusive bounds, equivalent offsets, zeroes, only its clinic | appointments `integration/appointment-counts*.test.ts`, `unit/appointment-counts.test.ts` |

## Invariants

| Invariant | What is checked | Where |
| --- | --- | --- |
| **I1** No overlapping bookings for a professional | 2 receptionists for the same slot, 100 times: always one 201 and one 409; 50 at once: one 201 and 49 409; afterwards no professional has two overlapping bookings. Also a plain 409 `slot_taken` | appointments `race/test.ts`, `integration/booking.test.ts`; db `integration/tenant-tx.test.ts` |
| **I2** No overlapping bookings for a patient in a clinic | Same patient with two professionals at once: one 201, one 409 `patient_overlap`, also concurrently | appointments `race/test.ts`, `integration/booking.test.ts` |
| **I3** Inside working hours and outside blocks | 422 outside hours or inside a block; a booking and a block sent together 60 times: either the block reports the winning booking or the later booking is rejected; later schedule edits can leave conflicts | appointments `integration/booking.test.ts`, `race/block-vs-booking.test.ts` |
| **I4** Duration set by the service | The body cannot send the end or the duration (422); the end is always start + the service's minutes; `CHECK` in the schema | appointments `integration/booking.test.ts` |
| **I5** No data of one clinic reachable from another | The listed suites exercise other-clinic IDs, manipulated filters/headers and RLS without application filters; connection reuse checks context cleanup. This is representative coverage, not an exhaustive proof of every route combination | db `integration/tenant-tx.test.ts`; appointments `integration/*` (booking, schedule, availability, lifecycle, clinical-note, daily-agenda, patient-history, counts); users `integration/patients.test.ts`, `user-management.test.ts`; clinics `integration/service-catalog.test.ts`; audit `integration/audit-query.test.ts`, `audit-append-only.test.ts`; auth `authorization.test.ts` |
| **I6** Audit log not modifiable by the application | The application role cannot `UPDATE`, `DELETE` or `TRUNCATE` it (no privilege), and triggers refuse all three even to the table owner | audit `integration/audit-append-only.test.ts`, `integration/audit-relay.test.ts` |
| **I7** Cancelling or rescheduling frees the slot at once | The slot shows up free in the next query, also when cached | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **I8** Availability never contradicts the database | Book a listed slot and query again: gone, without waiting for any expiry; interleaved readers and writers; lost invalidations recovered from the outbox; Redis down falls back to PostgreSQL | appointments `integration/availability-cache.test.ts`, `integration/agenda-relay.test.ts`, `unit/agenda-cache.test.ts`; E2E "Redis cache invalidation" |

I3 remains limited by later schedule edits, and I8 by asynchronous invalidation
and failures across replicas; see [concurrency](concurrency.md) and [cache](cache.md).
These tests do not establish either invariant unconditionally.

## Acceptance criteria of the statement

Evidence for each acceptance criterion:

| # | Criterion | How it is shown |
| --- | --- | --- |
| 1 | It starts by itself | `docker compose up` (README); the `e2e-compose` job does it from a fresh clone |
| 2 | The appointment cycle works | RF9-RF13 above; E2E uses different appointments for booking/cancellation and outcome |
| 3 | Identity is required and respected | RF17 above; E2E checks 401 without a token and 403 with the wrong role |
| 4 | Isolation holds | I5 above |
| 5 | The cache does not lie | I8 above |
| 6 | The race has one winner | I1 above (`race/test.ts`, reproducible: 100 iterations every run) |
| 7 | The tests run | `npm run test:all` |
