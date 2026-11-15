# MediCitas

[English](README.md) · **Español**

[![CI](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml)
[![CD - Publish Images](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/cd.yml)

Plataforma SaaS multi-tenant de citas médicas (Proyecto Semestral, Etapa 1 · OLTP), construida como microservicios en Node.js + TypeScript.

## Estructura

```
services/
  edge-gateway/          raíz/health públicos; proxy de dominio pendiente
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
postman/                 colección de demo y plantilla segura de entorno
requests/                recorrido REST Client y ejemplo de entorno local
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

Los comandos en el host requieren Node.js **>=22.18** y npm. Ejecute
`npm run build:packages` antes de arrancar un servicio en desarrollo. Cada servicio
carga el `.env` raíz; el comando del gateway arranca solo el gateway.

## Arranque local

Instale Docker Engine/Desktop con Compose v2 (contenedores Linux). Desde la raíz,
copie `.env.example` a `.env` **solo si `.env` todavía no existe**
(`Copy-Item .env.example .env` en PowerShell, `cp .env.example .env` en Bash).
Guarde las credenciales en ese archivo local ignorado. Revise las credenciales de
bases y Keycloak, `KEYCLOAK_TEST_PASSWORD`, `KEYCLOAK_USER_ADMIN_SECRET` y la
contraseña de Redis junto con `REDIS_URL`. Conserve los hosts por nombre de servicio
y las URL internas para Compose; `KEYCLOAK_ISSUER` debe coincidir con la URL usada
para obtener tokens desde el host.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=50 keycloak-seed
curl http://localhost:3000/health
```

El puerto del host predeterminado es `API_PORT=3000`; en PowerShell también sirve
`Invoke-RestMethod http://localhost:3000/health`. Se espera `{"status":"ok"}`.
Compose arranca cuatro bases PostgreSQL **18**, Keycloak, su carga de usuarios de
una sola ejecución, Redis y los cinco servicios HTTP. El esquema y las semillas SQL
se ejecutan solo sobre **volúmenes de base vacíos**; los existentes se conservan y
no se migran automáticamente. El job de semillas debe terminar con código 0; no
queda corriendo. Para investigar fallas use `docker compose logs --tail=50 <servicio>`.

Por defecto solo el gateway publica puerto al host. Hoy sirve `/` y `/health`,
**sin proxy de dominio**. Compruebe un servicio privado dentro de Compose:

```bash
docker compose exec clinics-service node -e "fetch('http://127.0.0.1:' + process.env.API_INTERNAL_PORT + '/health').then(r => r.json()).then(console.log)"
```

Para usar Postman desde el host, cree localmente `.env.compose-demo.yaml`, ignorado:

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

Estos mapeos suponen `API_INTERNAL_PORT=3000` y puertos del host libres. Use las
mismas opciones `-f` con los comandos posteriores de Compose. Las URL directas son
`http://localhost:3001` a `http://localhost:3004`, respectivamente; las URL internas
no cambian. El override conserva `private_net` para tráfico entre servicios y añade
`public_net` porque `private_net` es interna; publicar puertos por sí solo no basta
para acceder desde el host. `/health` indica que el servidor responde; no comprueba
bases, identidad ni caché. Las llamadas de dominio necesitan tokens vigentes de
Keycloak con clínica y rol correctos; vea el [contrato de la API](docs/api.es.md).
Detenga la pila con `docker compose stop` (con las mismas opciones `-f` si las usó).

## Documentación

| Tema | Español | English |
| --- | --- | --- |
| Contrato de la API | [docs/api.es.md](docs/api.es.md) | [docs/api.md](docs/api.md) |
| Demo Postman | [postman/README.es.md](postman/README.es.md) | [postman/README.md](postman/README.md) |
| Bases de datos y RLS | [docs/database.es.md](docs/database.es.md) | [docs/database.md](docs/database.md) |
| Comparación de multi-tenancy | [docs/database-comparison.es.md](docs/database-comparison.es.md) | [docs/database-comparison.md](docs/database-comparison.md) |
| Identidad con Keycloak | [docs/keycloak.es.md](docs/keycloak.es.md) | [docs/keycloak.md](docs/keycloak.md) |
| Concurrencia: el último espacio | [docs/concurrency.es.md](docs/concurrency.es.md) | [docs/concurrency.md](docs/concurrency.md) |
| Caché de disponibilidad | [docs/cache.es.md](docs/cache.es.md) | [docs/cache.md](docs/cache.md) |
| Índices y sus planes | [docs/indexes.es.md](docs/indexes.es.md) | [docs/indexes.md](docs/indexes.md) |
| CI/CD | [docs/ci-cd.es.md](docs/ci-cd.es.md) | [docs/ci-cd.md](docs/ci-cd.md) |
| Capa de datos `@medicitas/db` | [packages/db/README.es.md](packages/db/README.es.md) | [packages/db/README.md](packages/db/README.md) |

Cada documento tiene una versión en inglés (`nombre.md`) y otra en español (`nombre.es.md`), con un enlace arriba para cambiar de idioma. Si cambia un documento, actualice las dos versiones en el mismo PR.
