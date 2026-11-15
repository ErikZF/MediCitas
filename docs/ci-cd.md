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
        
        IntegTest["Job: DB Integration & Concurrency\n(npm run test:all -- --external --no-e2e)\n- every workspace suite\n- RLS, lifecycle, cache, audit\n- races (I1, I2, I3)"]
        E2E["Job: End-to-end against Docker Compose\n(cp .env.example .env; npm run test:e2e)"]
        DockerBuild["Job: Docker Build Validation\nMatrix: 5 microservices\n(edge-gateway, clinics, users, appointments, audit)"]

        Quality --> UnitTest
        UnitTest --> IntegTest
        Quality --> E2E
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
   - Runs `npm run test:all -- --external --no-e2e`: the same command as locally, with these service containers instead of `docker-compose.test.yml`. It builds everything and runs the suites of all eight workspaces (unit, integration and race), not only appointments.
   - Each suite creates throwaway databases on the fly and applies the real `init.sql` of its database, with its extensions (`btree_gist`), exclusion constraints, triggers, roles and RLS policies, and drops them at the end.
   - What each test covers: [test-report.md](test-report.md).

4. **`e2e-compose` (end-to-end against Docker Compose)**:
   - Does what the evaluator does on a fresh clone: `cp .env.example .env`, then `npm run test:e2e`.
   - The command runs `docker compose up -d --build`, waits until the gateway answers and Keycloak has the demo users, and runs the 25 steps of [`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs) through the gateway with real Keycloak tokens.
   - If it fails, the job prints `docker compose ps -a` and the last lines of every container's log.

5. **`docker-build` (Docker image validation)**:
   - Uses a matrix to build the images of the 5 microservices in parallel with [`services/Dockerfile`](../services/Dockerfile):
     - `edge-gateway`
     - `clinics-service`
     - `users-service`
     - `appointments-service`
     - `audit-service`
   - Checks image builds with `push: false`; it does not publish or run Compose.

`unit-tests`, `integration-tests`, `e2e-compose` and `docker-build` depend on `quality`, then
run independently. A push to `docs/**` does not trigger this workflow; a pull
request targeting `main` does.

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
exit with skipped tests; inspect the summary. `npm run test:all` now starts its
own PostgreSQL/Redis test stack, builds/runs every workspace and then the Compose
E2E walkthrough. See [runner options and effects](test-report.md). It does not
prepare the opt-in `j2` realm; a zero exit can still include those skipped tests.

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

To reproduce the CI workspace job with a prepared disposable test instance,
set the two test URLs locally and run:

```bash
npm run test:all -- --external --no-e2e
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

## 4. Coverage

Per-requirement and invariant coverage is in [test-report.md](test-report.md).
