# MediCitas

[English](README.md) · **Español**

[![CI](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml)
[![CD - Publish Images](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml)

Plataforma SaaS multi-tenant de citas médicas (Proyecto Semestral, Etapa 1 · OLTP), construida como microservicios en Node.js + TypeScript.

## Estructura

```
services/
  edge-gateway/          entrada única (antes api/)
  clinics-service/       clínicas, especialidades y servicios   → clinics_db
  users-service/         usuarios, profesionales y pacientes    → users_db
  appointments-service/  agenda, citas y notas clínicas         → appointments_db
  audit-service/         bitácora append-only                   → logs_db
  Dockerfile             imagen de cualquier servicio (--build-arg SERVICE=...)
packages/                librerías compartidas que los servicios importan por nombre,
                         por ejemplo @medicitas/http y @medicitas/auth (cada una con su README)
database/                esquema de cada base
keycloak/                realm versionado
docs/                    documentación
```

Es un workspace de npm: un solo `npm install` en la raíz instala todo.

## Comandos

```bash
npm install
npm run build        # paquetes compartidos y luego servicios
npm run typecheck
npm test
npm run dev -w services/edge-gateway
```

## Documentación

| Tema | Español | English |
| --- | --- | --- |
| Contrato de la API | [docs/api.es.md](docs/api.es.md) | [docs/api.md](docs/api.md) |
| Bases de datos y RLS | [docs/database.es.md](docs/database.es.md) | [docs/database.md](docs/database.md) |
| Comparación de multi-tenancy | [docs/database-comparison.es.md](docs/database-comparison.es.md) | [docs/database-comparison.md](docs/database-comparison.md) |
| Identidad con Keycloak | [docs/keycloak.es.md](docs/keycloak.es.md) | [docs/keycloak.md](docs/keycloak.md) |
| Caché de disponibilidad | [docs/cache.es.md](docs/cache.es.md) | [docs/cache.md](docs/cache.md) |
| CI/CD | [docs/ci-cd.es.md](docs/ci-cd.es.md) | [docs/ci-cd.md](docs/ci-cd.md) |
| Capa de datos `@medicitas/db` | [packages/db/README.es.md](packages/db/README.es.md) | [packages/db/README.md](packages/db/README.md) |

Cada documento tiene una versión en inglés (`nombre.md`) y otra en español (`nombre.es.md`), con un enlace arriba para cambiar de idioma. Si cambia un documento, actualice las dos versiones en el mismo PR.
