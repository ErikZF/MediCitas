# MediCitas

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

Más detalle en [docs/api.md](docs/api.md), [docs/database.md](docs/database.md) y [docs/ci-cd.md](docs/ci-cd.md).
