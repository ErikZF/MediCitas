# Diccionario de datos

[English](data-dictionary.md) · **Español**

Columnas físicas de las cuatro bases PostgreSQL 18. `Nulo` indica si admite NULL;
las columnas de una PK son obligatorias. PK = clave primaria, UNIQUE = unicidad,
FK = clave foránea impuesta dentro de una base. Una referencia lógica no tiene
FK entre bases. `TIME` es hora local sin zona; `TIMESTAMPTZ` guarda un instante.

## Bases nuevas y existentes

Compose ejecuta `init.sql` y `seed.sql` de cada base solo con el volumen vacío.
El diccionario incluye los ALTER al final de `init.sql`, así que una base nueva
ya tiene los campos del alta inicial. Los volúmenes existentes conservan su esquema.

| Cambio en una base existente | Archivo SQL |
| --- | --- |
| Campos del administrador pendiente de la clínica | [upgrade-registration.sql](../database/updates/clinics/upgrade-registration.sql) |
| `is_active` de servicios y retiro de DELETE a `medicitas_app` | [upgrade-service-soft-delete.sql](../database/updates/clinics/upgrade-service-soft-delete.sql) |
| `is_first_admin` e índice único parcial | [upgrade-first-admin.sql](../database/updates/users/upgrade-first-admin.sql) |
| Outbox de contacto y luego acceso del relay | [upgrade-patient-audit-outbox.sql](../database/updates/users/upgrade-patient-audit-outbox.sql), luego [upgrade-audit-relay.sql](../database/updates/users/upgrade-audit-relay.sql) |
| Límite de duración de cita e índices | [appointments/upgrade-e10-indexes.sql](../database/updates/appointments/upgrade-e10-indexes.sql) |
| Índices de consulta de auditoría | [logs/upgrade-e10-indexes.sql](../database/updates/logs/upgrade-e10-indexes.sql) |

Son actualizaciones puntuales, sin ejecutor automático de migraciones. Al agregar
`is_first_admin`, las filas existentes quedan en `false`; el administrador original
no se identifica automáticamente. Si el upgrade de outbox de users crea la tabla,
usa PK `event_id` y
predeterminado `gen_random_uuid()`. Una base nueva usa PK (`clinic_id`, `event_id`)
y `uuidv7()`. `CREATE TABLE IF NOT EXISTS` conserva la tabla que ya exista; ninguno
de los upgrades convierte esa clave o valor predeterminado al formato nuevo.
Las demás tablas y columnas requeridas deben existir antes de aplicar estos ajustes.

Para actualizar permisos en volúmenes existentes de `users_db`, vea los
[roles de base](database.es.md#roles-de-base-con-menor-privilegio).

Los archivos Drizzle son mapeos de consultas, no el DDL completo. Por ejemplo,
`is_first_admin` se usa mediante SQL directo y `appointment_status` toma su valor
predeterminado SQL; ninguno aparece en el mapeo Drizzle de su tabla.

## `clinics_db`

Esquema: [database/clinics/init.sql](../database/clinics/init.sql).

### `clinic`

Identidad de la clínica y estado del alta. PK: `clinic_id`. UNIQUE: `identifier`.

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `clinic_id` | `UUID` | No | ID de clínica; predeterminado `uuidv7()`. |
| `identifier` | `VARCHAR(32)` | No | Identificador de negocio único entre clínicas. |
| `name` | `VARCHAR(128)` | No | Nombre de la clínica. |
| `time_zone` | `TEXT` | No | Zona de la clínica; la API valida el nombre IANA. |
| `is_active` | `BOOLEAN` | No | Estado activo; predeterminado `true`. Un alta pendiente usa `false`. |
| `bootstrap_admin_id` | `UUID` | Sí | ID previsto del primer administrador; referencia lógica a `users_db.app_user`. |
| `bootstrap_username` | `VARCHAR(128)` | Sí | Nombre de usuario para el alta pendiente en Keycloak. |

Los dos últimos campos se limpian al activar la clínica tras el alta.

### `specialty`

Catálogo global de especialidades. PK: `specialty_id`. UNIQUE: `name`.

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `specialty_id` | `UUID` | No | ID de especialidad; predeterminado `uuidv7()`. |
| `name` | `VARCHAR(128)` | No | Nombre único de especialidad. |

### `service`

Servicio ofrecido por una clínica. PK: (`clinic_id`, `service_id`). UNIQUE: (`clinic_id`, `name`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `service_id` | `UUID` | No | ID de servicio; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | FK a `clinic.clinic_id`. |
| `specialty_id` | `UUID` | No | FK a `specialty.specialty_id`. |
| `name` | `VARCHAR(128)` | No | Nombre del servicio dentro de la clínica. |
| `duration_minutes` | `INT` | No | Duración del servicio; CHECK mayor que 0. |
| `is_active` | `BOOLEAN` | No | Disponible para nuevas reservas; predeterminado `true`. |

Retirar el servicio conserva la fila y reserva su nombre dentro de la clínica.

## `users_db`

Esquema: [database/users/init.sql](../database/users/init.sql).

### `role`

Catálogo de roles de dominio. PK: `role_code`.

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `role_code` | `VARCHAR(32)` | No | Roles semilla: `platform_admin`, `clinic_admin`, `receptionist`, `professional`. |
| `description` | `VARCHAR(128)` | No | Descripción del rol. |

### `app_user`

Asociación de una identidad Keycloak con su clínica y rol de dominio. PK: `app_user_id`. UNIQUE: `keycloak_sub`.

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `app_user_id` | `UUID` | No | ID de usuario de dominio; predeterminado `uuidv7()`. |
| `keycloak_sub` | `TEXT` | No | Identificador de la identidad externa (`sub`). Las contraseñas quedan en Keycloak. |
| `clinic_id` | `UUID` | Sí | Referencia lógica a `clinics_db.clinic`; nula exactamente para `platform_admin` (CHECK). |
| `role_code` | `VARCHAR(32)` | No | FK a `role.role_code`. Un rol por usuario. |
| `is_active` | `BOOLEAN` | No | Activación/baja lógica; predeterminado `true`. |
| `is_first_admin` | `BOOLEAN` | No | Marca al administrador del alta inicial; predeterminado `false`. |

Índice UNIQUE parcial en `clinic_id WHERE is_first_admin`: como máximo un usuario marcado por clínica. Por sí solo no comprueba que tenga rol `clinic_admin`.

### `professional`

Perfil profesional asociado con un usuario de la aplicación. PK: (`clinic_id`, `professional_id`). UNIQUE: (`clinic_id`, `app_user_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | ID del profesional; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `app_user_id` | `UUID` | No | FK a `app_user.app_user_id`. |
| `full_name` | `VARCHAR(128)` | No | Nombre del profesional usado por el dominio. |
| `is_active` | `BOOLEAN` | No | Estado activo del perfil; predeterminado `true`. |

La FK cubre solo `app_user_id`. El registro comprueba clínica, rol y estado activo del usuario en la aplicación.

### `professional_specialty`

Especialidades asignadas a un profesional. PK: (`clinic_id`, `professional_id`, `specialty_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | Profesional de la FK compuesta indicada abajo. |
| `specialty_id` | `UUID` | No | Referencia lógica a `clinics_db.specialty`. |
| `clinic_id` | `UUID` | No | Clínica de la FK compuesta indicada abajo. |

FK (`clinic_id`, `professional_id`) a `professional`, con `ON DELETE CASCADE`.

### `patient`

Ficha de paciente perteneciente a una clínica. PK: (`clinic_id`, `patient_id`). UNIQUE: (`clinic_id`, `identification`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `patient_id` | `UUID` | No | ID de paciente; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `identification` | `VARCHAR(32)` | No | Documento de identificación único dentro de la clínica. |
| `full_name` | `VARCHAR(128)` | No | Nombre del paciente. |
| `birth_date` | `DATE` | No | Fecha de nacimiento; la API valida que no sea futura. |
| `phone` | `VARCHAR(32)` | Sí | Teléfono de contacto opcional. |
| `email` | `VARCHAR(128)` | Sí | Correo de contacto opcional. |

### `outbox`

Eventos confirmados junto con la operación local. PK: (`clinic_id`, `event_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `event_id` | `UUID` | No | ID del evento; predeterminado `uuidv7()` en una base nueva. |
| `clinic_id` | `UUID` | No | Clínica dueña del evento. |
| `aggregate_id` | `UUID` | No | Referencia lógica al paciente. |
| `event_type` | `VARCHAR(64)` | No | Eventos `AuditRecorded` de contacto de pacientes. |
| `payload` | `JSONB` | No | Datos del evento; los de auditoría omiten texto de nota y valores de contacto. |
| `created_at` | `TIMESTAMPTZ` | No | Instante de encolado; predeterminado `now()`. |
| `published_at` | `TIMESTAMPTZ` | Sí | Nulo mientras esté pendiente; se asigna tras procesar el relay. |

Sin FK física. Los productores insertan; los relays leen y marcan eventos publicados.

## `appointments_db`

Esquema: [database/appointments/init.sql](../database/appointments/init.sql).

### `working_hours`

Un turno semanal recurrente; varias filas permiten jornada partida. PK: (`clinic_id`, `working_hours_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `working_hours_id` | `UUID` | No | ID del turno; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Referencia lógica a `users_db.professional`. |
| `weekday` | `SMALLINT` | No | CHECK de 0 (domingo) a 6 (sábado). |
| `start_time` | `TIME` | No | Inicio local del turno. |
| `end_time` | `TIME` | No | Fin local del turno; CHECK `start_time < end_time`. |

`no_overlap_working_hours` excluye turnos `[start_time, end_time)` solapados de la misma clínica, profesional y día. Los turnos no cruzan medianoche.

### `schedule_block`

Permiso u otro bloqueo de agenda con fechas. PK: (`clinic_id`, `schedule_block_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `schedule_block_id` | `UUID` | No | ID del bloqueo; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Referencia lógica a `users_db.professional`. |
| `starts_at` | `TIMESTAMPTZ` | No | Inicio del bloqueo. |
| `ends_at` | `TIMESTAMPTZ` | No | Fin del bloqueo; CHECK `starts_at < ends_at`. |
| `reason` | `VARCHAR(256)` | Sí | Motivo opcional. |

Los bloqueos pueden solaparse entre sí. La API lista citas reservadas en conflicto sin cancelarlas.

### `professional_service`

Asignación de servicio y su especialidad registrada. PK: (`clinic_id`, `professional_id`, `service_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | Referencia lógica a `users_db.professional`. |
| `service_id` | `UUID` | No | Referencia lógica a `clinics_db.service`. |
| `clinic_id` | `UUID` | No | Clínica dueña de la asignación. |
| `specialty_id` | `UUID` | No | Especialidad copiada del servicio al asignarlo. |

Esta tabla no tiene FK física. Reserva/disponibilidad comparan la especialidad guardada con el catálogo actual.

### `appointment`

Una reserva y su estado actual en el ciclo de vida. PK: (`clinic_id`, `appointment_id`). UNIQUE: (`clinic_id`, `rescheduled_from_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `appointment_id` | `UUID` | No | ID de cita; predeterminado `uuidv7()`. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Referencia lógica a `users_db.professional`. |
| `patient_id` | `UUID` | No | Referencia lógica a `users_db.patient`. |
| `service_id` | `UUID` | No | Referencia lógica a `clinics_db.service`. |
| `starts_at` | `TIMESTAMPTZ` | No | Inicio de la cita. |
| `ends_at` | `TIMESTAMPTZ` | No | Fin guardado, derivado del inicio y la duración. |
| `duration_minutes` | `INT` | No | Copia de duración del servicio; CHECK de 1 a 1440. |
| `status` | `VARCHAR(16)` | No | CHECK: `booked`, `attended`, `no_show`, `cancelled`, `rescheduled`; predeterminado `booked`. |
| `cancel_reason` | `VARCHAR(256)` | Sí | Motivo de cancelación. |
| `cancelled_by` | `UUID` | Sí | Referencia lógica al `users_db.app_user` que cancela. |
| `rescheduled_from_id` | `UUID` | Sí | Cita anterior; FK compuesta con `clinic_id` a `appointment`. |
| `created_by` | `UUID` | No | Referencia lógica al `users_db.app_user` que crea la cita. |
| `created_at` | `TIMESTAMPTZ` | No | Instante de creación; predeterminado `now()`. |
| `status_changed_at` | `TIMESTAMPTZ` | No | Instante del cambio de estado actual; predeterminado `now()`. |
| `status_changed_by` | `UUID` | Sí | Referencia lógica al actor del cambio de estado. |
| `updated_at` | `TIMESTAMPTZ` | No | Última actualización; predeterminado `now()`, mantenido por trigger. |

CHECK: inicio anterior al fin y fin igual al inicio más `duration_minutes` minutos. Dos EXCLUDE impiden solapes de filas `booked` por profesional o paciente dentro de la clínica. Solo `booked` puede cambiar de estado; el trigger rechaza transiciones desde estados finales. La referencia de reemplazo admite varios nulos, pero como máximo un reemplazo por cita original.

### `clinical_note`

Nota clínica de una cita. PK: (`clinic_id`, `clinical_note_id`). UNIQUE: (`clinic_id`, `appointment_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `clinical_note_id` | `UUID` | No | ID de nota; predeterminado `uuidv7()`. |
| `appointment_id` | `UUID` | No | Cita de la FK compuesta con `clinic_id`. |
| `clinic_id` | `UUID` | No | Clínica de la FK a `appointment`. |
| `professional_id` | `UUID` | No | Referencia lógica a `users_db.professional`; usada por RLS. |
| `appointment_status` | `VARCHAR(16)` | No | Predeterminado y CHECK: `attended`. |
| `content` | `TEXT` | No | Texto de la nota clínica. |
| `created_at` | `TIMESTAMPTZ` | No | Instante de creación; predeterminado `now()`. |
| `updated_at` | `TIMESTAMPTZ` | No | Última actualización; predeterminado `now()`, mantenida por trigger. |

La FK comprueba que la cita pertenece a la misma clínica. La constante `appointment_status` no comprueba el estado de la cita padre; la API valida que esté atendida y sea del profesional antes de crear una nota.

### `idempotency_keys`

Almacén reservado de respuestas; la API no lo usa. PK: (`clinic_id`, `key`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `clinic_id` | `UUID` | No | Alcance de clínica; referencia lógica a `clinics_db.clinic`. |
| `key` | `VARCHAR(128)` | No | Clave de idempotencia del cliente. |
| `request_hash` | `VARCHAR(64)` | No | Huella de la petición. |
| `response_status` | `SMALLINT` | No | Estado HTTP guardado. |
| `response_body` | `JSONB` | No | Cuerpo de respuesta guardado. |
| `created_at` | `TIMESTAMPTZ` | No | Instante de creación; predeterminado `now()`. |
| `expires_at` | `TIMESTAMPTZ` | No | Vencimiento; predeterminado `now() + 24 hours`. |

### `outbox`

Eventos confirmados junto con la operación local. PK: (`clinic_id`, `event_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `event_id` | `UUID` | No | ID del evento; predeterminado `uuidv7()` en una base nueva. |
| `clinic_id` | `UUID` | No | Clínica dueña del evento. |
| `aggregate_id` | `UUID` | No | Referencia lógica al profesional (`AgendaChanged`) o la nota (`AuditRecorded`). |
| `event_type` | `VARCHAR(64)` | No | `AgendaChanged` o `AuditRecorded`. |
| `payload` | `JSONB` | No | Datos del evento; los de auditoría omiten texto de nota y valores de contacto. |
| `created_at` | `TIMESTAMPTZ` | No | Instante de encolado; predeterminado `now()`. |
| `published_at` | `TIMESTAMPTZ` | Sí | Nulo mientras esté pendiente; se asigna tras procesar el relay. |

Sin FK física. Los productores insertan; los relays leen y marcan eventos publicados. Un índice parcial por `created_at` cubre los pendientes.

## `logs_db`

Esquema: [database/logs/init.sql](../database/logs/init.sql).

### `audit_log`

Registro de solo inserción de accesos a datos sensibles. PK: (`clinic_id`, `audit_log_id`).

| Columna | Tipo SQL | Nulo | Significado / relación |
| --- | --- | --- | --- |
| `audit_log_id` | `UUID` | No | Predeterminado `uuidv7()`; el relay usa el `event_id` de origen. |
| `clinic_id` | `UUID` | No | Referencia lógica a `clinics_db.clinic`. |
| `app_user_id` | `UUID` | No | Actor; referencia lógica a `users_db.app_user`. |
| `patient_id` | `UUID` | No | Paciente afectado; referencia lógica a `users_db.patient`. |
| `action` | `VARCHAR(16)` | No | CHECK: `read`, `create`, `update`. |
| `resource` | `VARCHAR(32)` | No | CHECK: `clinical_note`, `patient_contact`. |
| `resource_id` | `UUID` | No | ID lógico de nota o paciente, según `resource`. |
| `occurred_at` | `TIMESTAMPTZ` | No | Instante del acceso; predeterminado `now()`. |

Los triggers rechazan UPDATE, DELETE y TRUNCATE. No se declara FK entre bases.
