# Indexes justified by their plans (card E10)

**English** · [Español](indexes.es.md)

The assignment asks that *"the indexes created are justified with the execution plan of the
query they serve, starting with RF7"* (core module 8). This document lists every index of
`appointments_db` and `logs_db`, the query it serves and the plan before and after card E10.
The full `EXPLAIN (ANALYZE, BUFFERS)` output is in [indexes-plans.md](indexes-plans.md).

## How it was measured

```bash
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5433/appointments_db \
npm run explain:indexes -w services/appointments-service
```

[`scripts/explain-indexes.ts`](../services/appointments-service/scripts/explain-indexes.ts)
creates two throwaway databases from the real `init.sql` files and loads:

- **328 230 appointments**: 3 clinics, 15 professionals each, two years of weekdays with 14
  slots a day. Past ones carry their outcome, future ones are mostly `booked`.
- **2 205 schedule blocks**, the weekly working hours, the services offered and a clinical
  note for a third of the attended appointments.
- **1 200 000 audit events** (400 000 per clinic, 20 000 patients, 50 users).

It then runs each query **as `medicitas_app` with the clinic context loaded**, so the RLS
policies are part of the plan, exactly as in production. Each query runs twice: with the
indexes and query text from before E10, and with the current ones. Times are the median of
5 runs on a 2 vCPU container with PostgreSQL 16 (production uses 18; the plans are the same
kind). Buffers are 8 KB pages read from memory or disk: they show the work, the time shows
its cost on this machine.

## Results

| Query | Before | After | Index used after |
| --- | --- | --- | --- |
| **RF7** booked appointments of one professional on one day | 3.11 ms · 3 207 buffers | **0.06 ms · 31** | `idx_appointment_professional_starts_at` |
| **RF8** booked appointments of three professionals over a week | 4.19 ms · 4 000 | **0.29 ms · 263** | `idx_appointment_professional_starts_at` |
| RF7 blocks of one professional on one day | 0.06 ms · 31 | 0.04 ms · 21 | `idx_schedule_block_professional_starts_at` |
| RF7 weekly working hours of one professional | 0.03 ms · 3 | 0.03 ms · 3 | `no_overlap_working_hours` (constraint) |
| RF7/RF9 does the professional offer the service | 0.01 ms · 2 | 0.01 ms · 2 | `professional_service_pkey` |
| RF8 professionals who offer a service | 0.02 ms · 2 | 0.01 ms · 2 | `professional_service_pkey` |
| **RF20** agenda of the whole clinic for one day | 22.98 ms · 7 722 | **0.41 ms · 40** | `idx_appointment_clinic_starts_at` |
| **RF20** agenda of one professional for one day | 8.98 ms · 7 392 | **0.05 ms · 31** | `idx_appointment_professional_starts_at` |
| RF16 appointment history of one patient | 0.10 ms · 31 | 0.07 ms · 32 | `idx_appointment_patient_starts_at` |
| **RF21** appointments by status in one month | 25.59 ms · 7 722 | **5.62 ms · 34** | `idx_appointment_clinic_starts_at` (index-only) |
| RF15 clinical note of one appointment | 0.02 ms · 3 | 0.03 ms · 4 | `UNIQUE (clinic_id, appointment_id)` |
| RF19 audit log of one patient | 0.09 ms · 23 | 0.06 ms · 23 | `idx_audit_log_clinic_patient` |
| RF19 audit log of one user in one week | 1.25 ms · 101 | 0.16 ms · 69 | `idx_audit_log_clinic_user` |
| RF19 whole audit log of the clinic for one day | 1.41 ms · 38 | 0.75 ms · 15 | `idx_audit_log_clinic_occurred_at` |

RF7, RF8, RF20 and RF21 go from reading thousands of pages (in practice, every appointment of
the professional or of the clinic) to reading a few dozen. The other queries were already
cheap; for those the change removes indexes without losing anything.

## What the plans showed

**1. Under RLS, range operators are never index conditions.** The obvious index for "the
appointments that overlap a day" is a GiST on `tstzrange(starts_at, ends_at)`, and the
`EXCLUDE` constraints already have one. But the plans used it only for `clinic_id` and
`professional_id` and filtered the range row by row. The reason: with RLS on, PostgreSQL only
lets **leakproof** operators run before the policy, and that includes index conditions.
`=`, `<` and `>` on uuids and timestamps are leakproof; `&&` on ranges is not
(`pg_proc.proleakproof = false`). Rewriting the query with `&&` made it slower. So the new
indexes are btrees on plain columns, compared with `<` and `>`.

**2. A btree needs both ends of the interval.** "Overlaps `[from, to)`" is
`starts_at < to AND ends_at > from`, and an index on `starts_at` can only use the first half:
it scans from the beginning of time up to `to`. The fix comes from the domain: an appointment
must fit in one working-hours block (I3), and working hours never cross midnight, so **no
appointment lasts more than a day**. The schema now says so
(`CHECK appointment_within_one_day (duration_minutes <= 1440)`), and the queries add the
redundant `starts_at > from - 1 day`
([`domain/appointment-bounds.ts`](../services/appointments-service/domain/appointment-bounds.ts)).
With both bounds, RF7 reads 31 pages instead of 3 207.

**3. Column order follows the query.** Every query filters by clinic (RLS adds
`clinic_id = app_current_clinic_id()` even when the code does not), then by an equality
(professional, patient, user) and then by a range or an order (`starts_at`, `occurred_at`).
The indexes have exactly that order. Equalities first, the range last: after the range
column, the following columns cannot narrow the scan.

**4. The primary keys already start with `clinic_id`.** Since the sharding-ready keys, every
primary key is `(clinic_id, id)`. A separate index on `clinic_id` alone duplicates the first
column of the primary key: it was dropped everywhere.

**5. `status` alone is not selective.** `idx_appointment_status` had five possible values for
hundreds of thousands of rows and no query that filters only by status. RF7 filters by status
after the index has already narrowed it to a few rows.

## Index by index

**Created**

| Index | Serves | Why these columns |
| --- | --- | --- |
| `appointment (clinic_id, professional_id, starts_at)` | RF7, RF8, RF20 for one professional | Clinic and professional are equalities; `starts_at` between the two bounds. Not partial: RF20 also needs cancelled and attended appointments. |
| `appointment (clinic_id, starts_at) INCLUDE (status)` | RF20 for the clinic, RF21 | Same range by clinic. `INCLUDE (status)` lets RF21 count from the index alone (*Index Only Scan*), without visiting the table. |
| `appointment (clinic_id, patient_id, starts_at)` | RF16 | The history comes out of the index already ordered by date; only the tie-break by id is sorted. |
| `schedule_block (clinic_id, professional_id, starts_at)` | RF7, RF8 | One index instead of two (`clinic_id` and `professional_id` combined with a *BitmapAnd*). Blocks can last days, so here only the upper bound applies; a professional has few blocks. |
| `audit_log (clinic_id, occurred_at)` | RF19 by date range | Already in the order of the answer. |
| `audit_log (clinic_id, patient_id, occurred_at)` | RF19 by patient | Equality, then order. |
| `audit_log (clinic_id, app_user_id, occurred_at)` | RF19 by user (and range) | Equality, then range and order. |

**Kept, with the query they serve**

| Index | Serves |
| --- | --- |
| Primary keys `(clinic_id, id)` | Every read by id (appointment, note, block) and RLS by clinic |
| `no_overlap_professional`, `no_overlap_patient` (GiST, `EXCLUDE`) | I1 and I2 on every booking ([concurrency.md](concurrency.md)) |
| `no_overlap_working_hours` (GiST, `EXCLUDE`) | Overlapping shifts, and RF7's read of a professional's week |
| `professional_service_pkey (clinic_id, professional_id, service_id)` | "Does this professional offer it" and RF8's "who offers it" |
| `UNIQUE (clinic_id, appointment_id)` on `clinical_note` | One note per appointment, and RF15's lookup |
| `idx_outbox_pending (created_at) WHERE published_at IS NULL` | The relay (I4) reading pending events in order; partial, so it only holds what is pending |

**Dropped**

| Index | Why |
| --- | --- |
| `idx_*_clinic_id` on `appointment`, `working_hours`, `schedule_block`, `professional_service`, `clinical_note`, `audit_log` | Duplicated the first column of the primary key |
| `idx_appointment_professional_id`, `idx_appointment_patient_id` | Replaced by the composite indexes above |
| `idx_appointment_status` | Not selective, no query uses it alone |
| `idx_working_hours_professional_id` | The `EXCLUDE` index already serves it |
| `idx_schedule_block_professional_id` | Replaced by the composite index |
| `idx_prof_service_professional_id` | The primary key already starts with it |
| `idx_clinical_note_appointment_id`, `idx_clinical_note_professional_id` | The `UNIQUE` serves the lookup; no query filters notes by professional (RLS does, after the lookup) |
| `idx_audit_log_app_user_id`, `idx_audit_log_patient_id`, `idx_audit_log_occurred_at` | Replaced by composites with `clinic_id` first |

**Without a Stage 1 query yet** (kept, their owners should justify or drop them):
`idx_appointment_clinic_updated_at`, `idx_appointment_clinic_status_changed_at` (added with
the lifecycle timestamps, probably for Stage 2 incremental exports) and
`idx_idempotency_keys_expires_at` (for a cleanup job that does not exist yet). Before E10,
the planner even used `idx_appointment_clinic_status_changed_at` for RF20 and RF21, only
because it starts with `clinic_id`: that was the 7 722-page scan.

## Trade-offs

- **Space.** The indexes of `appointment` went from 10 (76 MB) to 9 (121 MB): fewer
  indexes, but wider, because each one carries `clinic_id` and the `INCLUDE`. 45 MB more for
  about 50 times less work on the most frequent queries.
- **Writes.** Every index is updated on each insert. There is one index fewer on
  `appointment`, `schedule_block` and `audit_log` (which receives a row for every read of a
  note), two fewer on `working_hours` and `professional_service`, and three fewer on
  `clinical_note`.
- **The bound depends on a rule.** If a service ever needed appointments longer than a day,
  the `CHECK` would have to change and the queries' bound with it. Both point to
  `domain/appointment-bounds.ts`.

## Applying it to an existing database

New databases get everything from `init.sql`. For a volume created before E10, run as the
schema owner (both scripts are repeatable):

```bash
psql "$APPOINTMENTS_DB_URL" -f database/updates/appointments/upgrade-e10-indexes.sql
psql "$LOGS_DB_URL" -f database/updates/logs/upgrade-e10-indexes.sql
```
