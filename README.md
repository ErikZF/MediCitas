# MediCitas

**English** · [Español](README.es.md)

[![CI](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml)
[![CD - Publish Images](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml)

Multi-tenant SaaS platform for medical appointments (semester project, Stage 1 · OLTP), built as Node.js + TypeScript microservices.

## Layout

```
services/
  edge-gateway/          single entry point (formerly api/)
  clinics-service/       clinics, specialties and services       → clinics_db
  users-service/         users, professionals and patients       → users_db
  appointments-service/  schedules, appointments, clinical notes → appointments_db
  audit-service/         append-only audit log                   → logs_db
  Dockerfile             image for any service (--build-arg SERVICE=...)
packages/                shared libraries the services import by name,
                         for example @medicitas/http and @medicitas/auth (each with its README)
database/                schema of each database
keycloak/                versioned realm
docs/                    documentation
```

It is an npm workspace: a single `npm install` at the root installs everything.

## Commands

```bash
npm install
npm run build        # shared packages, then services
npm run typecheck
npm test
npm run dev -w services/edge-gateway
```

## Documentation

| Topic | English | Español |
| --- | --- | --- |
| API contract | [docs/api.md](docs/api.md) | [docs/api.es.md](docs/api.es.md) |
| Databases and RLS | [docs/database.md](docs/database.md) | [docs/database.es.md](docs/database.es.md) |
| Multi-tenancy comparison | [docs/database-comparison.md](docs/database-comparison.md) | [docs/database-comparison.es.md](docs/database-comparison.es.md) |
| Identity with Keycloak | [docs/keycloak.md](docs/keycloak.md) | [docs/keycloak.es.md](docs/keycloak.es.md) |
| Availability cache | [docs/cache.md](docs/cache.md) | [docs/cache.es.md](docs/cache.es.md) |
| CI/CD | [docs/ci-cd.md](docs/ci-cd.md) | [docs/ci-cd.es.md](docs/ci-cd.es.md) |
| Data layer `@medicitas/db` | [packages/db/README.md](packages/db/README.md) | [packages/db/README.es.md](packages/db/README.es.md) |

Every document has an English version (`name.md`) and a Spanish one (`name.es.md`), with a link at the top to switch language. When you change a document, update both versions in the same PR.
