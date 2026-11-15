# RLS against the discriminator column, measured

**English** · [Español](rls-comparison.es.md)

The additional module for groups of three, option 2: *implement Row-Level Security next to
the chosen multi-tenancy strategy and compare both on the same queries, with isolation tests
and measurements.* The written comparison of strategies and the decision are in
[database-comparison.md](database-comparison.md); how isolation works layer by layer, in
[multitenancy.md](multitenancy.md).

## The two strategies

Both keep every clinic in the same tables, told apart by a `clinic_id` column (shared
schema). They differ in **who enforces** that a query only touches its own clinic.

| | Discriminator column | Row-Level Security |
| --- | --- | --- |
| Where the rule lives | In every query of the code: `WHERE clinic_id = $clinic` | In the engine: one policy per table and command, in [`init.sql`](../database/appointments/init.sql) |
| Where the clinic comes from | Whatever value the code passes | The session context, loaded from the verified token by `withTenantTx` with `app_set_session_context()`, local to the transaction |
| A query that forgets the filter | Sees every clinic | Sees only its clinic |
| A write to another clinic | Goes through | Rejected (`WITH CHECK`) |
| Without context | Not applicable | Sees nothing (fails closed) |
| Bypassed by | Any bug in any query | Superusers and roles with `BYPASSRLS`, which the services never use |

MediCitas uses **both**: the column is in every table, first in every primary key and every
index, and the services filter by it where it helps the plan; RLS is what guarantees I5.
This document measures what each one costs and what each one protects.

## How it was compared

```bash
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:55432/postgres \
npm run measure:rls -w services/appointments-service
```

`npm run test:all -- --no-e2e --keep` leaves a PostgreSQL 18 running at that address.

[`scripts/measure-rls.ts`](../services/appointments-service/scripts/measure-rls.ts) loads
the same volume as the index measurements ([indexes.md](indexes.md)): **328 230
appointments** in 3 clinics and **1 200 000 audit events**, with the indexes of `init.sql`.
It then runs 11 queries of RF7, RF8, RF15, RF16, RF19, RF20 and RF21, each one in five
ways, on the same data:

| Variant | Role | Tenant filter in the query | RLS |
| --- | --- | --- | --- |
| **Column only** | A role with the privileges of `medicitas_app` and `BYPASSRLS` | Yes | Off |
| **RLS only** | `medicitas_app`, with the session context | No | On |
| **Both** | `medicitas_app`, with the session context | Yes | On (what the services do) |
| **RLS, cached** / **Both, cached** | Same as above, after rewriting the policies with `(SELECT app_current_role())` instead of `app_current_role()` | | On |

Times are the median of 7 runs on a 2 vCPU container with PostgreSQL 16 (Compose uses 18;
the plans are of the same kind). Buffers are 8 KB pages: they show the work, the time its
cost on that machine. The script also checks that every variant returns the same rows.

## Isolation

[`tests/integration/rls-vs-column.test.ts`](../services/appointments-service/tests/integration/rls-vs-column.test.ts)
makes the same attempts against both strategies, logged in as reception of clinic A, with
one appointment in clinic A and one in clinic B. It runs with every other test
(`npm run test:all`).

| Attempt | Column only | RLS |
| --- | --- | --- |
| The query has the right filter | Clinic A only | Clinic A only |
| The query forgot the filter | **Clinics A and B** | Clinic A only |
| The clinic id comes from the request and was manipulated to B | **Clinic B** | Nothing |
| Insert an appointment for clinic B | **Inserted** | Rejected: `new row violates row-level security policy` |
| Cancel the appointments of clinic B | **1 row changed** | 0 rows |
| A session without tenant context | (no such thing) | Nothing |

The discriminator column is exactly as safe as the least careful query that will ever be
written. RLS turns the same mistakes into empty results or errors. The measurement script
repeats the forgotten-filter case on the large data set: column only sees 3 clinics, RLS 1.

## Performance

| Query | Rows | Column only | RLS only | Both (services) | RLS, cached | Both, cached |
| --- | ---: | --- | --- | --- | --- | --- |
| RF7 · booked appointments of one professional on one day | 11 | 0.05 ms, 32 buf | 0.05 ms, 32 buf | 0.04 ms, 32 buf | 0.04 ms, 32 buf | 0.06 ms, 32 buf |
| RF8 · booked appointments of three professionals over a week | 169 | 0.15 ms, 102 buf | 0.23 ms, 263 buf | 0.24 ms, 102 buf | 0.18 ms, 102 buf | 0.15 ms, 102 buf |
| RF7 · blocks of one professional on one day | 0 | 0.02 ms, 20 buf | 0.03 ms, 20 buf | 0.03 ms, 20 buf | 0.04 ms, 20 buf | 0.05 ms, 20 buf |
| RF7 · weekly working hours of one professional | 10 | 0.01 ms, 3 buf | 0.02 ms, 3 buf | 0.03 ms, 3 buf | 0.03 ms, 3 buf | 0.02 ms, 3 buf |
| RF8 · professionals who offer a service | 3 | 0.01 ms, 1 buf | 0.03 ms, 2 buf | 0.02 ms, 2 buf | 0.01 ms, 1 buf | 0.02 ms, 1 buf |
| RF20 · agenda of the whole clinic for one day | 210 | 0.16 ms, 41 buf | 0.35 ms, 41 buf | 0.35 ms, 41 buf | 0.15 ms, 41 buf | 0.16 ms, 41 buf |
| RF16 · appointment history of one patient | 30 | 0.06 ms, 32 buf | 0.07 ms, 32 buf | 0.06 ms, 32 buf | 0.04 ms, 32 buf | 0.04 ms, 32 buf |
| RF21 · appointments by status in one month | 2 | 1.60 ms, 50 buf | 4.59 ms, 50 buf | 7.32 ms, 50 buf | 1.24 ms, 50 buf | 1.44 ms, 50 buf |
| RF15 · clinical note of one appointment | 1 | 0.02 ms, 4 buf | 0.02 ms, 4 buf | 0.03 ms, 4 buf | 0.02 ms, 4 buf | 0.02 ms, 4 buf |
| RF19 · audit log of one patient | 20 | 0.03 ms, 23 buf | 0.06 ms, 23 buf | 0.06 ms, 23 buf | 0.04 ms, 23 buf | 0.04 ms, 23 buf |
| RF19 · whole audit log of the clinic for one day | 550 | 0.20 ms, 15 buf | 0.52 ms, 15 buf | 0.63 ms, 15 buf | 0.16 ms, 15 buf | 0.24 ms, 15 buf |

Differences under about 0.05 ms are noise on this machine.

### What the plans show

- **RLS uses the same indexes.** The policy's `clinic_id = app_current_clinic_id()` becomes
  part of the *Index Cond*, just like a literal `clinic_id = '…'`: the function is `STABLE`,
  so PostgreSQL evaluates it once when the scan starts and searches the index with the
  value. Every query reads practically the same pages in every variant, with one
  exception (next point). This is why the primary keys and indexes start with `clinic_id`.
- **One plan changed because of what the planner knows.** In RF8 with RLS only, the clinic
  is not known while planning (it comes from a function), the row estimate changes, and the
  planner chose a plain index scan that read 263 pages instead of a bitmap scan that reads
  102. With the filter in the query too (*Both*), the plan is the same as with the column.
  This is one reason the services keep the filter in their queries even though RLS would be
  enough.
- **The cost of RLS is a per-row check of the role.** Besides the clinic, each policy checks
  the role: `app_current_role() IN ('clinic_admin', 'receptionist', 'professional')`. That
  part cannot go into the index, so it is a *Filter* that calls a PL/pgSQL function **once
  per row**. With 11 rows it does not show; RF21 counts 4 830 rows and pays about 3 ms; the
  day of audit log, 550 rows, about 0.3 ms. The filter also changes the planner's row
  estimate, which is why RF21 switched from a hash aggregate to a sort.
- **Both costs about the same as RLS only**: the per-row role check is in both. The clinic
  is checked once: when the query says `clinic_id = 'A'` and the policy says
  `clinic_id = app_current_clinic_id()`, PostgreSQL deduces a *One-Time Filter*
  `app_current_clinic_id() = 'A'`, evaluated once per query. As a side effect it is a free
  consistency check: if the code and the session ever disagreed on the clinic, the query
  would return nothing.
- **Caching the functions removes the cost.** Written as `(SELECT app_current_role())`, the
  call becomes an *InitPlan*: evaluated once per query, and its result reused for every row.
  With the policies rewritten that way, RLS costs the same as the column (RF21: 1.24 ms
  against 1.60 ms; RF20: 0.15 ms against 0.16 ms) and keeps every guarantee: the isolation
  checks of the script give the same result.

## Decision

**RLS stays as the guarantee, and the column stays as the data model and the filter of the
queries.** Over the column alone, RLS adds what the isolation table shows, which is I5
itself: a forgotten filter, a manipulated parameter or a write to another clinic stop being
leaks. What it costs here, at this volume, is the per-row role check, at most a few
milliseconds on the largest query, and the measurements show how to remove it.

| | Gained with RLS | Given up |
| --- | --- | --- |
| Safety | Isolation does not depend on every query being right; writes are checked too; no context means no rows | A role with `BYPASSRLS`, or a superuser connection, sees everything: the services never use one |
| Performance | Same indexes and pages as the column | A per-row role check (up to ~3 ms on RF21 here), removable by caching the functions; plans that depend on the clinic are estimated less precisely without the filter in the query |
| Operations | The rule is written once per table, in SQL, next to the data | The context has to be set in every transaction (`withTenantTx` does it, local to the transaction, so it is safe with a pool and PgBouncer in transaction mode); errors are less explicit (an empty result instead of a 403); tests have to run as `medicitas_app`, not as the owner |

**Next step, not applied in this change:** rewrite the policies of the four `init.sql` with
the cached form `(SELECT app_current_…())`. The script already proves it returns the same
rows and removes the per-row cost; applying it means changing every policy and adding the
upgrade scripts for existing databases, so it goes in its own change, with the full test
suite as the check.
