# @medicitas/db

[English](README.md) · **Español**

Capa de datos compartida de los microservicios de MediCitas (tarjeta E1), construida con Drizzle sobre `pg`.

Resuelve tres cosas que ningún servicio debería reimplementar:

1. **Transacciones con el tenant** (`withTenantTx`): nivel de aislamiento explícito, el contexto de quien llama cargado para las políticas RLS y el rol de base con menor privilegio.
2. **Reintentos** ante `40001` (falla de serialización) y `40P01` (deadlock), volviendo a correr la transacción completa.
3. **Mapeo de errores de PostgreSQL** a códigos HTTP sin filtrar detalles de la base (`DbError`).

## Uso en un servicio

```ts
import { createDatabase, MEDICITAS_APP_ROLE, readDbConfig, withTenantTx, type TenantContext } from '@medicitas/db';

const { db } = createDatabase(readDbConfig('DB_APPOINTMENTS', 'appointments-service'), {
  onIdleClientError: () => logger.error('Idle database client failed.'),
});

// Se arma SOLO desde el token verificado, nunca desde la ruta, el query o el body (I5).
const ctx: TenantContext = {
  clinicId: token.clinic_id,
  userId: token.app_user_id,              // app_user.app_user_id
  role: 'professional',
  professionalId: token.professional_id,  // solo para el rol professional
};

const notes = await withTenantTx(db, ctx, async (tx) => {
  // consultas con tx...
}, { dbRoles: MEDICITAS_APP_ROLE });
```

Cuando una consulta viola una restricción, `withTenantTx` lanza un `DbError` con un `status`, así que el `errorHandler` compartido ya responde con el código correcto. Por ejemplo, `no_overlap_professional` se convierte en **409 `slot_taken`**.

## Qué hace cada transacción

```sql
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;   -- explícito, siempre
SELECT app_set_session_context($1::uuid, $2::uuid, $3::text, $4::uuid, true);  -- true = solo esta transacción
SET LOCAL ROLE "medicitas_app";                   -- solo cuando se pasa dbRoles
-- ...las consultas del servicio...
COMMIT;
```

`app_set_session_context` lo define cada `database/*/init.sql` junto a sus políticas RLS. Llena `app.current_clinic_id`, `app.current_user_id`, `app.current_role` y `app.current_professional_id`, que leen las funciones auxiliares `app_current_clinic_id()`, `app_current_role()`, etc. Así, los nombres de las variables viven en un solo lugar, el esquema; ver [docs/database.es.md](../../docs/database.es.md).

**Nivel de aislamiento: READ COMMITTED.** Alcanza porque la garantía contra la doble reserva viene de la restricción de exclusión, no de lo que cada transacción ve al leer. Un caso de uso puede pedir otro nivel con `isolationLevel`.

## Reglas del contexto

| Rol | `clinicId` | `userId` | `professionalId` |
| --- | --- | --- | --- |
| `platform_admin` | `null` | UUID | ausente |
| `clinic_admin`, `receptionist` | UUID | UUID | ausente |
| `professional` | UUID | UUID | UUID, obligatorio |

Un contexto que rompe estas reglas lanza `InvalidTenantContextError` (500) antes de tocar la base. De lo contrario, un profesional sin `professionalId` recibiría cero filas de las políticas exclusivas de profesionales, en silencio.

## Reglas del equipo

- **Solo SQL dentro de `withTenantTx`.** Un deadlock vuelve a correr la función completa, así que una llamada HTTP o una escritura en Redis dentro de ella se ejecutaría dos veces. El trabajo externo va antes de la transacción o después del commit.
- **Nada de configuración a nivel de sesión.** Nunca `SET` sin `LOCAL`, `set_config(..., false)`, `app_reset_session_context()`, `LISTEN/NOTIFY` ni advisory locks de sesión. Detrás de PgBouncer en modo transacción, la siguiente petición heredaría esta clínica. Las pruebas de integración verifican que nada sobreviva a un commit o a un rollback.
- **Nada de prepared statements con nombre** (`.prepare('name')`) mientras PgBouncer corra sin `max_prepared_statements`.
- **El usuario de conexión debe poder asumir el rol.** Un superusuario puede; cualquier otro login necesita `GRANT medicitas_app TO <login>;`. No debe tener `BYPASSRLS`.
- **Errores de restricciones propios de cada servicio:** `constraintErrors` le da significado a restricciones nuevas, por ejemplo `{ patient_clinic_id_identification_key: { status: 409, code: 'patient_exists', message: '...' } }`.

## Variables de entorno

Con un prefijo, por ejemplo `DB_APPOINTMENTS`:

| Variable | Obligatoria | Por defecto |
| --- | --- | --- |
| `DB_APPOINTMENTS_HOST`, `_NAME`, `_USER`, `_PASSWORD` | sí | — |
| `DB_CONNECT_PORT` (compartida) | no | `5432`; `6432` a través de PgBouncer |
| `DB_APPOINTMENTS_POOL_MAX` | no | `10` |
| `DB_APPOINTMENTS_POOL_IDLE_MS` | no | `30000` |
| `DB_APPOINTMENTS_CONNECT_TIMEOUT_MS` | no | `5000` |

`DB_*_PORT` en `.env` es el puerto publicado al host; los servicios dentro de Docker no lo usan.

## Pruebas

Desde la raíz del repositorio:

```bash
npm install
npm run typecheck -w packages/db
npm test -w packages/db       # pruebas unitarias; las de integración se saltan sin base de datos
TEST_DATABASE_URL=postgres://user:pass@localhost:5433/appointments_db npm run test:integration -w packages/db
```

Las pruebas de integración crean una base desechable, aplican el `database/appointments/init.sql` real (tablas, políticas RLS y `medicitas_app`) y la borran al terminar, así que necesitan un usuario que pueda crear bases (el `POSTGRES_USER` del contenedor sirve). Cubren:

- READ COMMITTED como `medicitas_app`;
- cada clínica ve solo sus citas, y `platform_admin` no ve ninguna;
- reservar en otra clínica y cambiar horarios como recepción devuelven 403;
- un profesional lee solo sus propias notas clínicas, y recepción no lee ninguna;
- ningún contexto ni rol se filtra después de un commit o un rollback en una conexión reutilizada;
- `createDatabase` a partir de variables de entorno;
- dos reservas simultáneas del mismo espacio, donde una gana y la otra recibe 409.

> `vitest@5.0.5` no se instala desde cero con npm 10 (`Cannot read properties of null (reading 'edgesOut')`), por eso el repo usa `^5.1.0`.

## Usarla desde un servicio

Declárela como dependencia del workspace en el `package.json` del servicio:

```json
"dependencies": { "@medicitas/db": "*" }
```

`npm run build:packages` en la raíz compila `packages/*` antes que los servicios.
