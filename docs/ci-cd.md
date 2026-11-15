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
   - Type-checks the whole monorepo without emitting JS (`npm run typecheck`).
   - Checks that the demo seed files were regenerated after the last change to their data (`npm run seed:check`, see [seed-data.md](seed-data.md)).

2. **`unit-tests`**:
   - Runs the fast unit tests of every package and microservice (`npm test`).

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
   - Makes sure any change to code, dependencies or Docker configuration builds cleanly before merging.

---

## 3. Running the tests locally

One command, the same one CI uses (it only needs Docker and Node.js):

```bash
npm run test:all
```

It starts a throwaway PostgreSQL 18 and Redis (`docker-compose.test.yml`, ports 55432 and
56379), runs every workspace suite against them, removes them, and then runs the
end-to-end suite against the Compose stack. Options and results:
[test-report.md](test-report.md#how-to-run-them).

To run one suite against your own database and Redis instead, give it the two URLs; the
user must be able to create databases:

```bash
TEST_DATABASE_URL=postgres://test:test_password@127.0.0.1:55432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:56379 \
npm test -w services/appointments-service
```

(`npm run test:all -- --no-e2e --keep` leaves exactly those two containers running.)
