# Continuous Integration and Delivery (CI/CD)

**English** · [Español](ci-cd.es.md)

MediCitas uses GitHub Actions for CI. `main` contains only `ci.yml`; there is no
`cd.yml`, image-publishing job or automatic deployment workflow.

---

## 1. Pipeline architecture

The diagram below is historical and remains unchanged. Its CD branch, tag trigger
and sequential job dependencies do not describe the current workflow. The current
jobs and their dependencies are listed in section 2.

```mermaid
flowchart TD
    subgraph Eventos["Triggers"]
        PR["Pull request to main"]
        PushMain["Push to main / tags"]
    end

    subgraph CI["CI pipeline (.github/workflows/ci.yml)"]
        direction TB
        Quality["Job: Typecheck & Quality\n(npm run typecheck)"]
        UnitTest["Job: Unit Tests\n(npm test)"]
        
        subgraph PostgresService["PostgreSQL service container"]
            PG["postgres:18-alpine\n(healthcheck enabled)"]
        end
        
        IntegTest["Job: DB Integration & Concurrency\n(TEST_DATABASE_URL)\n- RLS policy checks\n- Appointment lifecycle and availability\n- Concurrency and critical races (I1, I2, I5)"]
        DockerBuild["Job: Docker Build Validation\nMatrix: 5 microservices\n(edge-gateway, clinics, users, appointments, audit)"]

        Quality --> UnitTest
        UnitTest --> IntegTest
        IntegTest --> DockerBuild
    end

    subgraph CD["CD pipeline (.github/workflows/cd.yml)"]
        direction TB
        Publish["Job: Build & Push to GHCR\nghcr.io/<owner>/medicitas-<service>\nTags: :latest, :sha-<commit>, :semver"]
    end

    PR --> CI
    PushMain --> CI
    PushMain --> CD
```

---

## 2. Continuous integration (CI) flow

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs automatically on every `pull_request` to `main` and on every `push` to active branches (`main`, `feat/**`, `fix/**`).

### Jobs

1. **`quality` (typecheck and build)**:
   - Sets up Node.js 22 with the `npm` cache.
   - Runs `npm ci`.
   - Builds the shared packages (`npm run build:packages`).
   - Type-checks the workspaces after compiling shared packages (`npm run typecheck`).
   - Checks that the demo seed files were regenerated after the last change to their data (`npm run seed:check`, see [seed-data.md](seed-data.md)).

2. **`unit-tests`**:
   - Runs `npm test` across workspaces, including unit and local HTTP tests.
     Tests requiring absent PostgreSQL, Redis or temporary Keycloak configuration skip.

3. **`integration-tests` (database and concurrency tests)**:
   - Starts a **PostgreSQL 18** service container (`postgres:18-alpine`).
   - Injects `TEST_DATABASE_URL: postgres://test:test_password@localhost:5432/postgres`.
   - Loads the four schemas and the demo seed into their own databases, as `docker compose up` does, so a seed that breaks a constraint fails here.
   - Also starts **Redis 7** (`redis:7-alpine`) and injects `TEST_REDIS_URL: redis://localhost:6379` for the availability cache tests (E8, I8). Without that variable those tests are skipped.
   - The tests create a throwaway database on the fly (`medicitas_<label>_<pid>`) and apply the real schema [`database/appointments/init.sql`](../database/appointments/init.sql), with its extensions (`btree_gist`), exclusion constraints and RLS policies.
   - It runs only `npm run test:integration -w packages/db` and
     `npm test -w services/appointments-service`. It checks:
     - Multi-tenant transactions (`withTenantTx`) with the least-privilege role `medicitas_app`.
     - Row-level security (RLS) policies.
     - Scheduling and the appointment lifecycle (RF5, RF6, RF7, RF8, RF9, RF10-RF13, RF21).
     - Last-slot and same-patient races (I1, I2); isolation checks cover I5 separately.
   - It does not run clinics/users/audit database suites or a real Keycloak login.
     Loading their seed schemas is not the same as exercising those service APIs.
   - Drops the temporary database at the end.

4. **`docker-build` (Docker image validation)**:
   - Uses a matrix to build the images of the 5 microservices in parallel with [`services/Dockerfile`](../services/Dockerfile):
     - `edge-gateway`
     - `clinics-service`
     - `users-service`
     - `appointments-service`
     - `audit-service`
   - Checks image builds with `push: false`; it does not publish or run Compose.

`unit-tests`, `integration-tests` and `docker-build` each depend on `quality`, then
run independently. A push to `docs/**` does not trigger this workflow; a pull
request targeting `main` does. A successful job does not prove the full stack works.

---

## 3. Running tests locally

From the repository root, install the locked dependencies and build the shared
packages before running a workspace command:

```bash
npm ci
npm run build:packages
npm run typecheck
npm test
```

`npm test` is the workspace runner. Missing infrastructure can produce a successful
exit with skipped tests; inspect the summary. There is no single command here that
prepares every dependency and executes all real-stack integrations.

| Configuration | Enables | Requirements |
| --- | --- | --- |
| None | Unit tests, mock JWKS, injected HTTP handlers and gateway proxy/startup tests | Node.js >=22.18 and npm |
| `TEST_DATABASE_URL` | PostgreSQL suites in db, clinics, users, appointments and audit, including race tests | Disposable PostgreSQL 18 instance; administrative test login able to create/drop databases and roles, grant roles and load extensions |
| Also `TEST_REDIS_URL` | Availability cache and agenda relay integration suites | Disposable Redis reachable from the host; include its password if configured |
| Also `J2_TEMP_REALM=1` and Keycloak settings | Opt-in real Keycloak RF1/RF2 tests in users-service | Prepared disposable realm `j2`, direct-grant client `j2-tests`, domain roles/mappers, 300-second access tokens and confidential `medicitas-user-admin` with `manage-users` |

The Keycloak tests require `KEYCLOAK_INTERNAL_URL` on `127.0.0.1`, `REALM_NAME=j2`,
matching `KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` and `KEYCLOAK_USER_ADMIN_SECRET`.
No checked-in command prepares this temporary realm. The demo realm
`Sistema_Clinico` does not satisfy that fixture. Leave the opt-in unset until the
fixture is prepared; do not run it against shared identity data.

For the CI database/cache subset, set the two test URLs locally, then run:

```bash
npm run test:integration -w packages/db
npm test -w services/appointments-service
```

Bash environment syntax (replace placeholders with disposable test credentials):

```bash
export TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5433/postgres'
export TEST_REDIS_URL='redis://:<password>@localhost:6379'
```

PowerShell equivalent:

```powershell
$env:TEST_DATABASE_URL = 'postgres://<user>:<password>@localhost:5433/postgres'
$env:TEST_REDIS_URL = 'redis://:<password>@localhost:6379'
```

Then `npm test` includes the database suites of all workspaces, with the opt-in
Keycloak tests still skipped. URL-encode special characters in credentials. These
helpers create/drop test databases and some roles; use a dedicated test instance.
Compose `db_appointments` and `redis` can supply dependencies in a disposable setup,
but existing Compose volumes are not a fresh test environment. Do not reset shared data.

## 4. Coverage and observed verification

| Requirements | Existing evidence | Limits |
| --- | --- | --- |
| RF1-RF4 | clinics/users integration suites and opt-in onboarding tests | Real Keycloak fixture requires separate preparation |
| RF5-RF8 | schedule, availability, cache and agenda-relay suites | Uses injected dependencies; failure/replica caveats in [cache.md](cache.md) |
| RF9-RF13; I1, I2, I7 | booking, lifecycle and race suites | HTTP handlers and PostgreSQL with injected identity/catalog |
| I3, I4 | block-vs-booking race, schedule and booking rules | Later schedule edits can leave conflicts; duration comes from a separate catalog |
| RF14-RF16; RF18-RF19; I6 | patients, clinical-note, patient-history, audit-query and audit-relay suites | No patient profile/contact GET; note reads/writes and contact writes are audited |
| RF17; I5 | auth unit tests, tenant-tx and service isolation suites | Mock JWKS/injected context in many tests; not proof of every route on Compose |
| RF20-RF21 | daily-agenda and appointment-counts suites | Separate from full-stack walkthrough |
| I8 | availability-cache and agenda-relay suites | Ordinary invalidation scenarios; not an unconditional failure/multi-replica guarantee |

Documentation review on 2026-11-15, based on `origin/main` at `05c61cd`:

- `npm ci --ignore-scripts --no-audit --no-fund`: completed on Node.js 24.14.1, npm 11.11.0.
- `npm run build` and `npm run typecheck`: passed.
- `kubectl kustomize deploy/k8s/overlays/local`: rendered successfully without applying it.
- Bash/PowerShell deployment script parsing and `node --check deploy/scripts/test-all-endpoints.mjs`: passed; scripts were not executed.
- `npm test`: 345 passed, 133 skipped; no test DB/Redis URLs or temporary Keycloak realm configured.
- `npm run seed:check` and `docker compose --env-file .env.example config --quiet`: passed.
- Docker daemon unavailable: Compose startup, real PostgreSQL/Redis/Keycloak integrations,
  concurrent DB race, measurements and deployment walkthrough were not executed.

The Stage 1 submission also asks for a data dictionary, step-by-step 3NF justification,
a demonstration video and an AI-use declaration. The reviewed Markdown contains the
schema/ER description, but no dedicated dictionary, 3NF derivation or AI declaration.
Video delivery is unverified. The extra three-person module is not identified as
completed: using RLS alone is not its required two-strategy comparison. These remain
submission tasks, not implemented features established by this review.
