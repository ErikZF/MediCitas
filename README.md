# MediCitas

**English** · [Español](README.es.md)

[![CI](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml)

Multi-tenant SaaS platform for medical appointments (semester project, Stage 1 · OLTP), built as Node.js + TypeScript microservices.

## Layout

```
services/
  edge-gateway/          single public entry; forwards each path to its service
  clinics-service/       clinics, specialties and services       → clinics_db
  users-service/         users, professionals and patients       → users_db
  appointments-service/  schedules, appointments, clinical notes → appointments_db
  audit-service/         append-only audit log                   → logs_db
  Dockerfile             image for any service (--build-arg SERVICE=...)
packages/                shared libraries the services import by name,
                         for example @medicitas/http, @medicitas/auth and @medicitas/db
database/                schema of each database
deploy/                  Kubernetes (Kustomize + Kind) manifests and deploy scripts
keycloak/                versioned realm
docs/                    documentation
postman/                 demo collection and safe environment template
requests/                REST Client walkthrough and local environment example
```

It is an npm workspace: a single `npm install` at the root installs everything.

## Commands

```bash
npm install
npm run build        # shared packages, then services
npm run typecheck
npm test             # unit tests; integration tests skip without a database
npm run test:all     # workspace suites and Compose E2E (needs Docker; see limits)
npm run dev -w services/edge-gateway
```

Host commands require Node.js **>=22.18** and npm. Run `npm run build:packages`
before starting a service in development. Each service loads the root `.env`;
the gateway command starts only the gateway, not the other services.

## Local startup

Install Docker Engine/Desktop with Compose v2 (Linux containers). From the repository
root, copy `.env.example` to `.env` **only if `.env` does not already exist**
(`Copy-Item .env.example .env` in PowerShell, `cp .env.example .env` in Bash).
Keep credentials in that ignored local file. Review the database and Keycloak
credentials, `KEYCLOAK_TEST_PASSWORD`, `KEYCLOAK_USER_ADMIN_SECRET` and Redis
password/`REDIS_URL` together. Keep the service-name hosts and internal URLs for
Compose; `KEYCLOAK_ISSUER` must match the URL used to obtain tokens on the host.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=50 keycloak-seed
curl http://localhost:3000/health
```

The default host port is `API_PORT=3000`; PowerShell can also use
`Invoke-RestMethod http://localhost:3000/health`. Expected: `{"status":"ok"}`.
Compose starts four PostgreSQL **18** databases, Keycloak, its one-shot user seed,
Redis and all five HTTP services. SQL schema/seeds run only on **empty database
volumes**; existing volumes are preserved and are not migrated automatically.
The seed job should exit with code 0; it does not remain running. Use
`docker compose logs --tail=50 <service>` to investigate startup failures.

Only the gateway publishes an HTTP application port by default. Keycloak is on
8080; PostgreSQL appointments/users/logs/clinics are on 5433/5434/5435/5436, and
Redis is on 6379. These mappings are not restricted to loopback in Compose; use
this development setup on a trusted machine. `private_net` is internal; only
Keycloak and the gateway also join `public_net`. The gateway forwards domain routes to the
service that owns it, Authorization included, so the whole API is at
`http://localhost:3000` (for example `GET /availability?...`, `POST /appointments`,
`GET /audit/logs`). Every service still verifies the token itself. An unreachable upstream produces 502
`upstream_unavailable`; a 15-second socket timeout produces 504 `upstream_timeout`,
and a missing upstream URL produces 503 `upstream_not_configured`. The gateway
forwards tokens; domain services authenticate them. Check a private service inside Compose:

```bash
docker compose exec clinics-service node -e "fetch('http://127.0.0.1:' + process.env.API_INTERNAL_PORT + '/health').then(r => r.json()).then(console.log)"
```

To call a service directly from the host instead (optional), create an ignored `.env.compose-demo.yaml` locally:

```yaml
services:
  clinics-service:
    ports: ["127.0.0.1:3001:3000"]
    networks: [private_net, public_net]
  users-service:
    ports: ["127.0.0.1:3002:3000"]
    networks: [private_net, public_net]
  appointments-service:
    ports: ["127.0.0.1:3003:3000"]
    networks: [private_net, public_net]
  audit-service:
    ports: ["127.0.0.1:3004:3000"]
    networks: [private_net, public_net]
```

```bash
docker compose -f docker-compose.yml -f .env.compose-demo.yaml up -d --build
```

These mappings assume `API_INTERNAL_PORT=3000` and free host ports. Use the same
`-f` options with subsequent Compose commands. Direct host URLs are then
`http://localhost:3001` through `http://localhost:3004`, respectively; internal
service URLs stay unchanged. The override keeps `private_net` for service-to-service
traffic and adds `public_net` because `private_net` is internal; port mappings alone
are insufficient for host access. `/health` is a liveness response, not a database,
identity or cache readiness test. Authenticated domain calls need fresh Keycloak
tokens with matching clinic/role claims; see the [API contract](docs/api.md).
Stop the stack with `docker compose stop` (with the same `-f` options if used).

`npm test` can skip integrations when PostgreSQL, Redis or Keycloak configuration
is absent. See [test requirements and CI coverage](docs/ci-cd.md) and the
[Postman walkthrough](postman/README.md) for demo prerequisites.

## Tests

```bash
npm run test:all
```

The runner starts disposable PostgreSQL 18 and Redis for workspace suites, then
runs the Compose end-to-end walkthrough. Prepare `.env` as above and install npm
dependencies first. Stage 2 rebuilds and changes the demo stack; it preserves
existing database volumes. The temporary-realm Keycloak tests still need separate
configuration and can skip. Default stage-1 cleanup removes its test containers
and volumes. Options, recorded results and limits: [test report](docs/test-report.md).

## Documentation

| Topic | English | Español |
| --- | --- | --- |
| API contract | [docs/api.md](docs/api.md) | [docs/api.es.md](docs/api.es.md) |
| Postman demo | [postman/README.md](postman/README.md) | [postman/README.es.md](postman/README.es.md) |
| Databases and RLS | [docs/database.md](docs/database.md) | [docs/database.es.md](docs/database.es.md) |
| Multi-tenancy architecture | [docs/multitenancy.md](docs/multitenancy.md) | [docs/multitenancy.es.md](docs/multitenancy.es.md) |
| Multi-tenancy comparison | [docs/database-comparison.md](docs/database-comparison.md) | [docs/database-comparison.es.md](docs/database-comparison.es.md) |
| Identity with Keycloak | [docs/keycloak.md](docs/keycloak.md) | [docs/keycloak.es.md](docs/keycloak.es.md) |
| Demo seed data | [docs/seed-data.md](docs/seed-data.md) | [docs/seed-data.es.md](docs/seed-data.es.md) |
| Concurrency: the last slot | [docs/concurrency.md](docs/concurrency.md) | [docs/concurrency.es.md](docs/concurrency.es.md) |
| Availability cache | [docs/cache.md](docs/cache.md) | [docs/cache.es.md](docs/cache.es.md) |
| Indexes and their plans | [docs/indexes.md](docs/indexes.md) | [docs/indexes.es.md](docs/indexes.es.md) |
| Test report | [docs/test-report.md](docs/test-report.md) | [docs/test-report.es.md](docs/test-report.es.md) |
| CI/CD | [docs/ci-cd.md](docs/ci-cd.md) | [docs/ci-cd.es.md](docs/ci-cd.es.md) |
| Kubernetes deployment | [deploy/README.md](deploy/README.md) | [deploy/README.es.md](deploy/README.es.md) |
| Data layer `@medicitas/db` | [packages/db/README.md](packages/db/README.md) | [packages/db/README.es.md](packages/db/README.es.md) |

Maintained guides have English and Spanish versions linked at the top. Update
both together. The historical [index-plan capture](docs/indexes-plans.md) is kept
in its original language. The deployment guide covers an optional local setup;
Compose remains the Stage 1 startup path.
