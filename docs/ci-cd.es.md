# Integración y Despliegue Continuo (CI/CD)

[English](ci-cd.md) · **Español**

MediCitas cuenta con un pipeline automatizado de **CI/CD** implementado con **GitHub Actions**, diseñado para la arquitectura de microservicios y monorepo (npm workspaces) del proyecto.

---

## 1. Arquitectura del Pipeline

```mermaid
flowchart TD
    subgraph Eventos["Disparadores"]
        PR["Pull Request hacia main"]
        PushMain["Push a main / tags"]
    end

    subgraph CI["Pipeline de CI (.github/workflows/ci.yml)"]
        direction TB
        Quality["Job: Typecheck & Quality\n(npm run typecheck)"]
        UnitTest["Job: Unit Tests\n(npm test)"]
        
        subgraph PostgresService["Contenedor de Servicio PostgreSQL"]
            PG["postgres:18-alpine\n(healthcheck activo)"]
        end
        
        IntegTest["Job: DB Integration & Concurrency\n(npm run test:all -- --external --no-e2e)\n- todas las suites de los workspaces\n- RLS, ciclo de vida, caché, bitácora\n- carreras (I1, I2, I3)"]
        E2E["Job: End-to-end contra Docker Compose\n(cp .env.example .env; npm run test:e2e)"]
        DockerBuild["Job: Docker Build Validation\nMatriz: 5 microservicios\n(edge-gateway, clinics, users, appointments, audit)"]

        Quality --> UnitTest
        UnitTest --> IntegTest
        Quality --> E2E
        IntegTest --> DockerBuild
    end

    subgraph CD["Pipeline de CD (.github/workflows/cd.yml)"]
        direction TB
        Publish["Job: Build & Push a GHCR\nghcr.io/<owner>/medicitas-<service>\nTags: :latest, :sha-<commit>, :semver"]
    end

    PR --> CI
    PushMain --> CI
    PushMain --> CD
```

---

## 2. Flujo de Integración Continua (CI)

El archivo [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) se ejecuta automáticamente en cada `pull_request` a `main` y en cada `push` a ramas activas (`main`, `feat/**`, `fix/**`).

### Jobs incluidos:

1. **`quality` (Typecheck y compilación)**:
   - Configura Node.js 22 con caché de `npm`.
   - Ejecuta `npm ci`.
   - Compila los paquetes compartidos (`npm run build:packages`).
   - Verifica tipos en todo el monorepo sin emitir JS (`npm run typecheck`).
   - Comprueba que los archivos de la semilla de demo se regeneraron después del último cambio a sus datos (`npm run seed:check`, ver [seed-data.es.md](seed-data.es.md)).

2. **`unit-tests` (Pruebas unitarias)**:
   - Ejecuta las pruebas unitarias rápidas de todos los paquetes y microservicios (`npm test`).

3. **`integration-tests` (Pruebas de base de datos y concurrencia)**:
   - Levanta un contenedor de servicio de **PostgreSQL 18** (`postgres:18-alpine`).
   - Inyecta `TEST_DATABASE_URL: postgres://test:test_password@localhost:5432/postgres`.
   - Carga los cuatro esquemas y la semilla de demo en sus propias bases, igual que `docker compose up`, para que una semilla que rompe una restricción falle aquí.
   - Levanta también **Redis 7** (`redis:7-alpine`) e inyecta `TEST_REDIS_URL: redis://localhost:6379` para las pruebas de la caché de disponibilidad (E8, I8). Sin esa variable, esas pruebas se saltan.
   - Corre `npm run test:all -- --external --no-e2e`: el mismo comando que en local, con estos contenedores de servicio en vez de `docker-compose.test.yml`. Compila todo y corre las suites de los ocho workspaces (unitarias, de integración y de carrera), no solo las de appointments.
   - Cada suite crea bases desechables al vuelo, les aplica el `init.sql` real de su base, con sus extensiones (`btree_gist`), restricciones de exclusión, triggers, roles y políticas RLS, y las borra al final.
   - Qué cubre cada prueba: [test-report.es.md](test-report.es.md).

4. **`e2e-compose` (punta a punta contra Docker Compose)**:
   - Hace lo que haría el evaluador con un clon nuevo: `cp .env.example .env` y luego `npm run test:e2e`.
   - El comando corre `docker compose up -d --build`, espera a que el gateway responda y Keycloak tenga los usuarios de demo, y corre los 25 pasos de [`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs) a través del gateway con tokens reales de Keycloak.
   - Si falla, el job imprime `docker compose ps -a` y las últimas líneas del log de cada contenedor.

5. **`docker-build` (Validación de imágenes de Docker)**:
   - Utiliza una matriz para construir en paralelo las imágenes de los 5 microservicios usando [`services/Dockerfile`](../services/Dockerfile):
     - `edge-gateway`
     - `clinics-service`
     - `users-service`
     - `appointments-service`
     - `audit-service`
   - Garantiza que cualquier cambio en código, dependencias o configuración Docker compile limpiamente antes de fusionar.

---

## 3. Correr las pruebas en local

Un solo comando, el mismo que usa CI (solo necesita Docker y Node.js):

```bash
npm run test:all
```

Levanta un PostgreSQL 18 y un Redis desechables (`docker-compose.test.yml`, puertos
55432 y 56379), corre contra ellos las suites de todos los workspaces, los borra, y
después corre la suite de punta a punta contra la pila de Compose. Opciones y
resultados: [test-report.es.md](test-report.es.md#cómo-se-corren).

Para correr una sola suite contra su propia base y su propio Redis, pásele las dos URL;
el usuario debe poder crear bases:

```bash
TEST_DATABASE_URL=postgres://test:test_password@127.0.0.1:55432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:56379 \
npm test -w services/appointments-service
```

(`npm run test:all -- --no-e2e --keep` deja corriendo justo esos dos contenedores.)
