# Integración y Despliegue Continuo (CI/CD)

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
            PG["postgres:17-alpine\n(healthcheck activo)"]
        end
        
        IntegTest["Job: DB Integration & Concurrency\n(TEST_DATABASE_URL)\n- Verificación de políticas RLS\n- Ciclo de vida y disponibilidad de citas\n- Concurrencia y carreras críticas (I1, I2, I5)"]
        DockerBuild["Job: Docker Build Validation\nMatriz: 5 microservicios\n(edge-gateway, clinics, users, appointments, audit)"]

        Quality --> UnitTest
        UnitTest --> IntegTest
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

2. **`unit-tests` (Pruebas unitarias)**:
   - Ejecuta las pruebas unitarias rápidas de todos los paquetes y microservicios (`npm test`).

3. **`integration-tests` (Pruebas de base de datos y concurrencia)**:
   - Levanta un contenedor de servicio de **PostgreSQL 17** (`postgres:17-alpine`).
   - Inyecta `TEST_DATABASE_URL: postgres://test:test_password@localhost:5432/postgres`.
   - Los tests crean dinámicamente una base de datos desechable (`medicitas_<label>_<pid>`), aplican el esquema real [`database/appointments/init.sql`](../database/appointments/init.sql) con extensiones (`btree_gist`), restricciones de exclusión y políticas RLS.
   - Valida:
     - Transacciones multi-inquilino (`withTenantTx`) con el rol de menor privilegio `medicitas_app`.
     - Políticas de seguridad a nivel de fila (RLS).
     - Agendamiento y ciclo de vida de citas (RF5, RF6, RF7, RF8, RF9, RF10-RF13, RF21).
     - Condiciones de carrera y concurrencia (I1, I2, I5: reserva del último cupo simultáneo).
   - Destruye la base de datos temporal al finalizar.

4. **`docker-build` (Validación de imágenes de Docker)**:
   - Utiliza una matriz para construir en paralelo las imágenes de los 5 microservicios usando [`services/Dockerfile`](../services/Dockerfile):
     - `edge-gateway`
     - `clinics-service`
     - `users-service`
     - `appointments-service`
     - `audit-service`
   - Garantiza que cualquier cambio en código, dependencias o configuración Docker compile limpiamente antes de fusionar.

---

## 3. Ejecución de Pruebas de Integración Localmente

Para reproducir localmente las mismas pruebas de integración que ejecuta GitHub Actions:

1. Iniciar la base de datos de appointments con Docker Compose:
   ```bash
   docker compose up -d db_appointments
   ```

2. Ejecutar los tests pasando `TEST_DATABASE_URL` (usando las credenciales de tu `.env`):
   ```bash
   # Pruebas de integración de la librería de DB (RLS y transacciones)
   TEST_DATABASE_URL=postgres://tu_user:tu_password_seguro@localhost:5433/appointments_db npm run test:integration -w packages/db

   # Pruebas de integración y concurrencia de appointments-service
   TEST_DATABASE_URL=postgres://tu_user:tu_password_seguro@localhost:5433/appointments_db npm test -w services/appointments-service
   ```

---