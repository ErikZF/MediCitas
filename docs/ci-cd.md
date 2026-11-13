# Continuous Integration and Delivery (CI/CD)

**English** · [Español](ci-cd.es.md)

MediCitas has an automated **CI/CD** pipeline built with **GitHub Actions**, designed for the project's microservices architecture and monorepo (npm workspaces).

---

## 1. Pipeline architecture

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
            PG["postgres:17-alpine\n(healthcheck enabled)"]
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
   - Type-checks the whole monorepo without emitting JS (`npm run typecheck`).

2. **`unit-tests`**:
   - Runs the fast unit tests of every package and microservice (`npm test`).

3. **`integration-tests` (database and concurrency tests)**:
   - Starts a **PostgreSQL 17** service container (`postgres:17-alpine`).
   - Injects `TEST_DATABASE_URL: postgres://test:test_password@localhost:5432/postgres`.
   - Also starts **Redis 7** (`redis:7-alpine`) and injects `TEST_REDIS_URL: redis://localhost:6379` for the availability cache tests (E8, I8). Without that variable those tests are skipped.
   - The tests create a throwaway database on the fly (`medicitas_<label>_<pid>`) and apply the real schema [`database/appointments/init.sql`](../database/appointments/init.sql), with its extensions (`btree_gist`), exclusion constraints and RLS policies.
   - It checks:
     - Multi-tenant transactions (`withTenantTx`) with the least-privilege role `medicitas_app`.
     - Row-level security (RLS) policies.
     - Scheduling and the appointment lifecycle (RF5, RF6, RF7, RF8, RF9, RF10-RF13, RF21).
     - Race conditions and concurrency (I1, I2, I5: booking the last slot at the same time).
   - Drops the temporary database at the end.

4. **`docker-build` (Docker image validation)**:
   - Uses a matrix to build the images of the 5 microservices in parallel with [`services/Dockerfile`](../services/Dockerfile):
     - `edge-gateway`
     - `clinics-service`
     - `users-service`
     - `appointments-service`
     - `audit-service`
   - Makes sure any change to code, dependencies or Docker configuration builds cleanly before merging.

---

## 3. Running the integration tests locally

To reproduce locally the same integration tests that GitHub Actions runs:

1. Start the appointments database with Docker Compose:
   ```bash
   docker compose up -d db_appointments
   ```

2. Run the tests with `TEST_DATABASE_URL` (using the credentials from your `.env`):
   ```bash
   # Integration tests of the DB library (RLS and transactions)
   TEST_DATABASE_URL=postgres://tu_user:tu_password_seguro@localhost:5433/appointments_db npm run test:integration -w packages/db

   # Integration and concurrency tests of appointments-service
   TEST_DATABASE_URL=postgres://tu_user:tu_password_seguro@localhost:5433/appointments_db npm test -w services/appointments-service
   ```

3. To include the availability cache tests (E8), start Redis and add `TEST_REDIS_URL`:
   ```bash
   docker compose up -d redis

   TEST_DATABASE_URL=postgres://tu_user:tu_password_seguro@localhost:5433/appointments_db TEST_REDIS_URL=redis://:tu_password_seguro@localhost:6379 npm test -w services/appointments-service
   ```
