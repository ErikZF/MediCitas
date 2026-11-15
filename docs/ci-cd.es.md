# Integración y Despliegue Continuo (CI/CD)

[English](ci-cd.md) · **Español**

MediCitas usa GitHub Actions para CI. `main` contiene solo `ci.yml`; no hay
`cd.yml`, job de publicación de imágenes ni workflow de despliegue automático.

---

## 1. Arquitectura del Pipeline

El diagrama siguiente es histórico y se conserva sin cambios. Su rama CD, el
disparador por tags y las dependencias secuenciales no describen el workflow
actual. La sección 2 detalla los jobs y sus dependencias actuales.

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
   - Verifica tipos de los workspaces después de compilar los paquetes compartidos (`npm run typecheck`).
   - Comprueba que los archivos de la semilla de demo se regeneraron después del último cambio a sus datos (`npm run seed:check`, ver [seed-data.es.md](seed-data.es.md)).

2. **`unit-tests` (Pruebas unitarias)**:
   - Ejecuta `npm test` en los workspaces, con unitarias y pruebas HTTP locales.
     Omite las que requieren PostgreSQL, Redis o configuración temporal de Keycloak ausentes.

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
   - Comprueba builds con `push: false`; no publica imágenes ni arranca Compose.

`unit-tests`, `integration-tests`, `e2e-compose` y `docker-build` dependen de `quality` y luego
corren de forma independiente. Un push a `docs/**` no dispara este workflow;
un pull request hacia `main` sí. Un job exitoso no acredita la pila completa.

---

## 3. Ejecutar pruebas localmente

Desde la raíz, instale las dependencias fijadas y compile paquetes compartidos
antes de ejecutar comandos de un workspace:

```bash
npm ci
npm run build:packages
npm run typecheck
npm test
```

`npm test` ejecuta los workspaces. Si falta infraestructura, puede terminar bien
con pruebas omitidas; revise el resumen. `npm run test:all` ahora levanta su pila
PostgreSQL/Redis de pruebas, compila/ejecuta todos los workspaces y luego el E2E de
Compose. Vea [opciones y efectos del runner](test-report.es.md). No prepara el
realm optativo `j2`; puede terminar con código cero y esas pruebas omitidas.

| Configuración | Habilita | Requisitos |
| --- | --- | --- |
| Ninguna | Unitarias, JWKS simulado, handlers HTTP inyectados y proxy/arranque del gateway | Node.js >=22.18 y npm |
| `TEST_DATABASE_URL` | Suites PostgreSQL de db, clinics, users, appointments y audit, incluidas carreras | Instancia PostgreSQL 18 descartable; login administrativo de pruebas que cree/borre bases y roles, otorgue roles y cargue extensiones |
| Además `TEST_REDIS_URL` | Integraciones de caché y relay de agenda | Redis descartable alcanzable desde el host; incluya contraseña si está configurada |
| Además `J2_TEMP_REALM=1` y ajustes de Keycloak | Pruebas optativas RF1/RF2 con Keycloak real en users-service | Realm descartable `j2` preparado, cliente direct-grant `j2-tests`, roles/mappers, tokens de 300 segundos y cliente confidencial `medicitas-user-admin` con `manage-users` |

Las pruebas de Keycloak exigen `KEYCLOAK_INTERNAL_URL` en `127.0.0.1`,
`REALM_NAME=j2`, `KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE` correspondientes y
`KEYCLOAK_USER_ADMIN_SECRET`. No hay un comando versionado que prepare ese realm.
El realm de demo `Sistema_Clinico` no satisface esa fixture. Mantenga desactivada
la opción hasta prepararla; no la ejecute contra identidades compartidas.

Para reproducir el job de workspaces de CI con una instancia descartable preparada,
defina localmente las dos URL de pruebas y ejecute:

```bash
npm run test:all -- --external --no-e2e
```

Sintaxis Bash (reemplace placeholders con credenciales de pruebas descartables):

```bash
export TEST_DATABASE_URL='postgres://<user>:<password>@localhost:5433/postgres'
export TEST_REDIS_URL='redis://:<password>@localhost:6379'
```

Equivalente PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgres://<user>:<password>@localhost:5433/postgres'
$env:TEST_REDIS_URL = 'redis://:<password>@localhost:6379'
```

Con esas variables, `npm test` incluye las suites de base de todos los workspaces;
las optativas de Keycloak siguen omitidas. Codifique caracteres especiales de las
credenciales para URL. Los helpers crean/borran bases de prueba y algunos roles;
use una instancia dedicada. `db_appointments` y `redis` de Compose pueden servir
en un entorno descartable, pero sus volúmenes existentes no son un entorno nuevo.
No reinicie datos compartidos.

## 4. Cobertura y verificaciones observadas

La cobertura por requisito e invariante está en [test-report.es.md](test-report.es.md).
Distingue las aserciones de las pruebas, las corridas observadas y los límites.

Revisión documental del 2026-11-15, actualizada a `origin/main` en `5759576`:

- `npm ci --ignore-scripts --no-audit --no-fund`: completado con Node.js 24.14.1 y npm 11.11.0.
- `npm run build` y `npm run typecheck`: pasaron.
- `kubectl kustomize deploy/k8s/overlays/local`: renderizó sin aplicar al clúster.
- Análisis de sintaxis Bash/PowerShell y `node --check deploy/scripts/test-all-endpoints.mjs`: pasaron; no se ejecutaron los scripts.
- `npm test`: 345 aprobadas, 141 omitidas; sin URL de DB/Redis de prueba ni realm temporal configurados.
- `npm run seed:check` y `docker compose --env-file .env.example config --quiet`: pasaron.
- Docker no estaba disponible: no se ejecutaron arranque Compose, integraciones reales
  con PostgreSQL/Redis/Keycloak, carrera contra la base, mediciones ni recorrido de despliegue.
  El runner nuevo se revisó estáticamente: no se ejecutó su limpieza de contenedores/
  volúmenes ni la etapa 2 que modifica datos de demo.

La entrega de Etapa 1 también pide diccionario de datos, justificación paso a paso
de 3FN, video de demostración y declaración de uso de IA. El Markdown revisado
contiene la descripción de esquema/ER, pero no un diccionario dedicado, derivación
3FN ni declaración de IA. La entrega del video no está verificada. El módulo extra
para tres integrantes no está identificado como completo: usar solo RLS no cumple
su comparación de dos estrategias. Son tareas de entrega pendientes de acreditar,
no funcionalidades que esta revisión dé por terminadas.
