# Arquitectura Multi-Tenancy

[English](multitenancy.md) · **Español**

MediCitas es una plataforma clínica multi-tenant donde cada clínica opera como un inquilino aislado dentro de un entorno compartido de microservicios y bases de datos. El aislamiento se aplica como **defensa en profundidad** a través de tokens de identidad, gateway, transacciones de aplicación, Row-Level Security (RLS) en PostgreSQL, caché en Redis, relays asíncronos y políticas de red en Kubernetes (**Invariante I5**).

> Documentos relacionados: [Arquitectura de Bases de Datos y RLS](database.es.md) · [Comparación de Multi-Tenancy](database-comparison.es.md) · [Identidad con Keycloak](keycloak.es.md) · [Caché de Disponibilidad](cache.es.md)

---

## 1. Flujo de aislamiento de extremo a extremo

```mermaid
flowchart TD
    Caller["Petición del cliente (Authorization: Bearer JWT)"] --> Gateway["edge-gateway (elimina x-test-context, reenvía Bearer)"]
    Gateway --> Service["Microservicio dueño (clinics / users / appointments / audit)"]
    Service --> Auth["Verificación JWT -> TenantContext (clinicId, userId, role, professionalId)"]
    Auth --> Tx["withTenantTx() (packages/db/src/tenant-tx.ts)"]
    Tx --> GUC["SELECT app_set_session_context(..., p_is_local := true)"]
    GUC --> Role["SET LOCAL ROLE db_admin / db_receptionist / db_professional (según el rol del token, sin BYPASSRLS)"]
    Role --> RLS["PostgreSQL 18 (ENABLE + FORCE ROW LEVEL SECURITY)"]

    Service --> Cache["Clave Redis: avail:v1:{clinic:professional}:g<gen>:v<ver>:<date>"]
```

---

## 2. Garantías por capa

### 2.1 Capa de identidad y tokens (Keycloak OIDC)
- MediCitas delega la autenticación a Keycloak (realm `Sistema_Clinico`).
- Los JWT verificados transportan los claims de dominio sin confiar en IDs enviados por el cliente:
  - `app_user_id` (o `user_id`): UUID del usuario en `users_db.app_user`.
  - `clinic_id`: UUID de la clínica del usuario (`null` para `platform_admin`).
  - `role` / `realm_access.roles`: uno de `platform_admin`, `clinic_admin`, `receptionist`, `professional`.
  - `professional_id`: UUID del perfil profesional (obligatorio cuando `role = professional`; ausente para los demás roles).
- Los campos del cuerpo (`clinicId`), parámetros query o cabeceras (`x-clinic-id`, `x-role`) **nunca** pueden cambiar la clínica derivada del token verificado.

### 2.2 Edge Gateway y contexto de servicio (`packages/db/src/context.ts`)
- `edge-gateway` elimina cabeceras hop-by-hop y `x-test-context` antes de reenviar peticiones a los microservicios.
- Cada microservicio verifica el token Bearer de forma independiente y construye un `TenantContext` validado por `assertTenantContext()`:
  - **Fallo cerrado**: `platform_admin` debe tener `clinicId === null`; todos los roles de clínica (`clinic_admin`, `receptionist`, `professional`) requieren un UUID válido en `clinicId`; `professional` requiere un UUID válido en `professionalId`.
  - Cualquier combinación inválida lanza `InvalidTenantContextError` (`500`) antes de abrir conexión a PostgreSQL.

### 2.3 Contexto transaccional en base de datos (`packages/db/src/tenant-tx.ts`)
- Todas las consultas se ejecutan mediante `withTenantTx(db, ctx, fn, options)` dentro de una transacción PostgreSQL (`READ COMMITTED` por defecto):
  1. Ejecuta `SELECT app_set_session_context(clinicId, userId, role, professionalId, true)`, configurando `app.current_clinic_id`, `app.current_user_id`, `app.current_role` y `app.current_professional_id` con `is_local = true`.
  2. Opcionalmente aplica `statement_timeout` local a la transacción.
  3. Ejecuta `SET LOCAL ROLE` con el rol de base del actor (`MEDICITAS_DB_ROLES`: `db_admin`, `db_receptionist` o `db_professional`, ninguno con `BYPASSRLS`); ver [database.es.md](database.es.md#roles-de-base-con-menor-privilegio).
- Al estar ligados exclusivamente a la transacción (`SET LOCAL`), los pools de conexiones (incluido PgBouncer en modo transacción) nunca heredan contexto de un tenant anterior.

### 2.4 Row-Level Security en PostgreSQL 18 y claves preparadas para sharding
- **Estrategia elegida**: MediCitas utiliza **Base compartida + columna discriminadora (`clinic_id`) + RLS de PostgreSQL** (ver [database-comparison.es.md](database-comparison.es.md)).
- **Aplicación en el motor**: Todas las tablas de dominio tienen activados `ENABLE ROW LEVEL SECURITY` y `FORCE ROW LEVEL SECURITY`:
  - `clinic_id = app_current_clinic_id()` filtra `SELECT`, `INSERT`, `UPDATE` y `DELETE` directamente en PostgreSQL.
  - Sin variables de sesión inicializadas, `app_current_clinic_id()` devuelve `NULL` y los predicados evalúan a `FALSE` (**denegación por defecto**).
  - Políticas por rol restringen aún más el acceso dentro de la clínica: por ejemplo, `clinical_note` solo es accesible para el profesional dueño de la cita (`professional_id = app_current_professional_id()`), y `audit_log` solo es visible para `clinic_admin` de esa clínica (`append-only` para `medicitas_app`).
- **Claves compuestas por tenant**: Claves primarias, llaves foráneas intra-base, restricciones únicas, exclusiones `EXCLUDE USING gist` (`appointment`, `working_hours`) e índices B-tree compuestos inician con `clinic_id`, dejando el esquema listo para particionamiento o sharding horizontal por clínica.
- **Respuestas entre clínicas**: Consultar un UUID existente de otra clínica devuelve `404 not_found` (o `[]` en historial) sin revelar su existencia.

### 2.5 Aislamiento en caché Redis (`services/appointments-service`)
- Las claves de disponibilidad incluyen explícitamente `clinic` junto a `professional`:
  ```text
  avail:v1:{clinic:professional}:g<gen>:v<ver>:<date>
  ```
- Tanto los contadores de versión (`gen` y `ver`) como los bloques cacheados quedan aislados por clínica y profesional.

### 2.6 Relays de Outbox (`users_db`, `appointments_db` -> `logs_db`)
- Cada mutación auditable registra un evento `AuditRecorded` con su `clinic_id` en la tabla `outbox` dentro de la misma transacción del tenant.
- El relay (`medicitas_relay`) toma eventos pendientes con `FOR UPDATE SKIP LOCKED` y los inserta en `logs_db.audit_log` como `medicitas_app` usando el `clinic_id` propio de cada evento en el contexto de sesión.

### 2.7 Aislamiento de infraestructura en Kubernetes (`deploy/`)
- **Base de datos por microservicio**: Cuatro StatefulSets y PVCs independientes (`db-clinics`, `db-users`, `db-appointments`, `db-logs`), accesibles únicamente por su microservicio dueño (y el relay de `audit-service` cuando aplica).
- **NetworkPolicies**: [network-policies.yaml](../deploy/k8s/base/network-policies.yaml) aplica `default-deny` en ingress dentro del namespace `medicitas`, bloqueando tráfico lateral no autorizado entre pods o bases de datos.
