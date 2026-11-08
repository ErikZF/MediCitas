# @medicitas/db

Shared data layer for the MediCitas microservices (card E1), built on Drizzle over `pg`.

It solves three things no service should reimplement:

1. **Tenant-aware transactions** (`withTenantTx`): explicit isolation level, the caller's context loaded for the RLS policies, and the least-privilege database role.
2. **Retries** of `40001` (serialization failure) and `40P01` (deadlock), rerunning the whole transaction.
3. **PostgreSQL error mapping** to HTTP status codes without leaking database details (`DbError`).

## Usage in a service

```ts
import { createDatabase, MEDICITAS_APP_ROLE, readDbConfig, withTenantTx, type TenantContext } from '@medicitas/db';

const { db } = createDatabase(readDbConfig('DB_APPOINTMENTS', 'appointments-service'), {
  onIdleClientError: () => logger.error('Idle database client failed.'),
});

// Built ONLY from the verified token, never from the route, query or body (I5).
const ctx: TenantContext = {
  clinicId: token.clinic_id,
  userId: token.app_user_id,              // app_user.app_user_id
  role: 'professional',
  professionalId: token.professional_id,  // only for the professional role
};

const notes = await withTenantTx(db, ctx, async (tx) => {
  // queries with tx...
}, { dbRoles: MEDICITAS_APP_ROLE });
```

When a query violates a constraint, `withTenantTx` throws a `DbError` with a `status`, so the shared `errorHandler` already answers with the right code. For example, `no_overlap_professional` becomes **409 `slot_taken`**.

## What every transaction does

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;   -- explicit, always
SELECT app_set_session_context($1::uuid, $2::uuid, $3::text, $4::uuid, true);  -- true = this transaction only
SET LOCAL ROLE "medicitas_app";                   -- only when dbRoles is given
-- ...the service's queries...
COMMIT;
```

`app_set_session_context` is defined by every `database/*/init.sql` next to its RLS policies. It fills `app.current_clinic_id`, `app.current_user_id`, `app.current_role` and `app.current_professional_id`, which the helper functions `app_current_clinic_id()`, `app_current_role()`, etc. read. The variable names therefore live in one place, the schema; see `docs/database.md`.

**Isolation level: READ COMMITTED.** It is enough because the guarantee against double booking comes from the exclusion constraint, not from read visibility. A use case can ask for another level with `isolationLevel`.

## Context rules

| Role | `clinicId` | `userId` | `professionalId` |
| --- | --- | --- | --- |
| `platform_admin` | `null` | UUID | absent |
| `clinic_admin`, `receptionist` | UUID | UUID | absent |
| `professional` | UUID | UUID | UUID, required |

A context that breaks these rules throws `InvalidTenantContextError` (500) before touching the database. A professional without `professionalId` would otherwise get zero rows from the professional-only policies, silently.

## Team rules

- **Only SQL inside `withTenantTx`.** A deadlock reruns the whole function, so an HTTP call or a Redis write inside it would run twice. Do external work before the transaction or after it commits.
- **No session-level settings.** Never `SET` without `LOCAL`, `set_config(..., false)`, `app_reset_session_context()`, `LISTEN/NOTIFY` or session advisory locks. Behind PgBouncer in transaction mode, the next request would inherit this clinic. The integration tests check that nothing survives a commit or a rollback.
- **No named prepared statements** (`.prepare('name')`) while PgBouncer runs without `max_prepared_statements`.
- **The connection user must be able to assume the role.** A superuser can; any other login needs `GRANT medicitas_app TO <login>;`. It must not have `BYPASSRLS`.
- **Service-specific constraint errors:** `constraintErrors` gives meaning to new constraints, for example `{ patient_clinic_id_identification_key: { status: 409, code: 'patient_exists', message: '...' } }`.

## Environment variables

With a prefix, for example `DB_APPOINTMENTS`:

| Variable | Required | Default |
| --- | --- | --- |
| `DB_APPOINTMENTS_HOST`, `_NAME`, `_USER`, `_PASSWORD` | yes | — |
| `DB_CONNECT_PORT` (shared) | no | `5432`; `6432` through PgBouncer |
| `DB_APPOINTMENTS_POOL_MAX` | no | `10` |
| `DB_APPOINTMENTS_POOL_IDLE_MS` | no | `30000` |
| `DB_APPOINTMENTS_CONNECT_TIMEOUT_MS` | no | `5000` |

`DB_*_PORT` in `.env` is the port published to the host; services inside Docker do not use it.

## Tests

From the repository root:

```bash
npm install
npm run typecheck -w packages/db
npm test -w packages/db       # unit tests; integration tests are skipped without a database
TEST_DATABASE_URL=postgres://user:pass@localhost:5433/appointments_db npm run test:integration -w packages/db
```

The integration tests create a throwaway database, apply the real `database/appointments/init.sql` (tables, RLS policies and `medicitas_app`) and drop it at the end, so they need a user that can create databases (the container's `POSTGRES_USER` works). They cover:

- READ COMMITTED as `medicitas_app`;
- each clinic sees only its appointments, and `platform_admin` sees none;
- booking in another clinic and changing working hours as reception both return 403;
- a professional reads only their own clinical notes, and reception reads none;
- no context or role leaks after a commit or a rollback on a reused connection;
- `createDatabase` from environment variables;
- two simultaneous bookings of the same slot, where one wins and the other gets 409.

> `vitest@5.0.5` fails to install from scratch with npm 10 (`Cannot read properties of null (reading 'edgesOut')`), so the repo uses `^5.1.0`.

## Using it from a service

Declare it as a workspace dependency in the service's `package.json`:

```json
"dependencies": { "@medicitas/db": "*" }
```

`npm run build:packages` at the root compiles `packages/*` before the services.
