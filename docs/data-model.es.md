# Modelo de datos: diccionario y normalización

[English](data-model.md) · **Español**

El modelo relacional de la Etapa 1: cada tabla y columna con su significado, la
normalización hasta tercera forma normal paso a paso, y los lugares donde el modelo se
aparta de ella a propósito, con el motivo. El dibujo es el
[diagrama ER](database.es.md#diagrama-entidad-relación); cómo funciona el aislamiento
entre clínicas está en [database.es.md](database.es.md) y [multitenancy.es.md](multitenancy.es.md).

## Visión general

Cuatro bases PostgreSQL 18, una por servicio (base de datos por servicio). 17 tablas:

| Base | Dueño | Tablas |
| --- | --- | --- |
| `clinics_db` | clinics-service | `clinic`, `specialty`, `service` |
| `users_db` | users-service | `role`, `app_user`, `professional`, `professional_specialty`, `patient`, `outbox` |
| `appointments_db` | appointments-service | `working_hours`, `schedule_block`, `professional_service`, `appointment`, `clinical_note`, `outbox`, `idempotency_keys` |
| `logs_db` | audit-service | `audit_log` |

### Convenciones

- **Los identificadores** son `uuid` que genera la base con `uuidv7()`. La versión 7
  empieza con una marca de tiempo, así que las filas nuevas caen al final del B-tree y no
  en páginas al azar (versión 4); los servicios no tienen que compartir una secuencia; y
  un id se le puede mostrar a un cliente sin revelar cuántas filas hay.
- **Las tablas de un inquilino** tienen la llave primaria `(clinic_id, <entidad>_id)`, con
  `clinic_id` primero. Mantiene juntas las filas de cada clínica en todos los índices, es
  la columna por la que filtra RLS, y una llave foránea que la incluye no puede apuntar a
  una fila de otra clínica.
- **Los instantes** son `timestamptz` (se guardan en UTC). **Las horas de la semana**
  (`working_hours`) son `time` en hora local de la clínica, porque "lunes 08:00" debe
  seguir siendo 08:00 cuando cambia el horario; la `time_zone` de la clínica las convierte
  en instantes.
- **Borrado lógico**: `is_active` en clínicas, servicios, usuarios y profesionales. Sus
  citas y registros de bitácora siguen apuntándoles.
- **No hay llaves foráneas entre bases.** Una columna marcada **LR** (referencia lógica)
  guarda el id de una fila de otra base; el servicio que la escribe valida que la fila
  exista, por la API del servicio dueño. Por qué: [database.es.md, sección 3](database.es.md#3-integridad-referencial-entre-microservicios).
- **Row-level security** está activado y forzado en toda tabla que tiene `clinic_id`. Qué
  rol lee o escribe qué: [database.es.md, sección 4](database.es.md#4-row-level-security-rls-y-multi-tenancy).

Leyenda de la columna Llave: **PK** llave primaria, **FK** llave foránea en la misma base,
**UQ** única, **LR** referencia lógica a otra base.

## Diccionario de datos

### clinics_db

#### `clinic`

Un inquilino: una clínica que compra el servicio (RF1).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | `uuidv7()` | PK | Id del inquilino. Es el `clinic_id` de todas las demás tablas. |
| `identifier` | varchar(32) | no | | UQ | Código público corto elegido al registrarla (`clinic-sj-01`). |
| `name` | varchar(128) | no | | | Nombre que se muestra. |
| `time_zone` | text | no | | | Zona IANA (`America/Costa_Rica`). Convierte los horarios en instantes y define qué es "hoy" para la agenda (RF7, RF20). La valida el servicio. |
| `is_active` | boolean | no | `true` | | `false` mientras el registro está pendiente o si la clínica está suspendida. |
| `bootstrap_admin_id` | uuid | sí | | LR → `app_user` | Id reservado para el primer administrador mientras RF1 está en curso; se borra al activar la clínica. |
| `bootstrap_username` | varchar(128) | sí | | | Usuario de Keycloak de ese administrador, solo mientras RF1 está en curso, para reconocer un registro reintentado. |

#### `specialty`

Catálogo global de especialidades médicas, compartido por todas las clínicas. Lo leen
todos los roles y solo lo cambia el administrador de plataforma.

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `specialty_id` | uuid | no | `uuidv7()` | PK | |
| `name` | varchar(128) | no | | UQ | `General Medicine`, `Cardiology`... |

#### `service`

Lo que ofrece una clínica y cuánto dura (RF3).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, FK → `clinic` | |
| `service_id` | uuid | no | `uuidv7()` | PK | |
| `specialty_id` | uuid | no | | FK → `specialty` | Especialidad que necesita un profesional para atenderlo (RF4). |
| `name` | varchar(128) | no | | UQ con `clinic_id` | Único dentro de la clínica. |
| `duration_minutes` | int | no | | | Duración de una cita. `CHECK > 0`. Se copia en cada cita al reservarla (I4). |
| `is_active` | boolean | no | `true` | | Un servicio retirado conserva sus citas; las reservas nuevas reciben 422 `service_inactive`. |

Índices: `idx_service_specialty_id`; `idx_service_clinic_id` repite la primera columna de
la llave primaria (candidato a eliminar, como en [indexes.es.md](indexes.es.md)).

### users_db

#### `role`

Los cuatro roles de la matriz de permisos: `platform_admin`, `clinic_admin`,
`receptionist`, `professional`. La aplicación solo los lee.

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `role_code` | varchar(32) | no | | PK | El mismo código que el rol del realm de Keycloak y el claim `role`. |
| `description` | varchar(128) | no | | | |

#### `app_user`

Enlace entre una identidad de Keycloak y el dominio (RF2, RF17). Las credenciales viven en
Keycloak, nunca aquí.

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `app_user_id` | uuid | no | `uuidv7()` | PK | Va en el token como claim `app_user_id` y en cada `created_by`, `cancelled_by`, `status_changed_by` y `audit_log.app_user_id`. |
| `keycloak_sub` | text | no | | UQ | El `sub` del token. |
| `clinic_id` | uuid | sí | | LR → `clinic` | La única clínica del usuario. `NULL` solo para `platform_admin`. |
| `role_code` | varchar(32) | no | | FK → `role` | Un rol por usuario. |
| `is_active` | boolean | no | `true` | | Borrado lógico (RF2): la cuenta de Keycloak también se deshabilita. |
| `is_first_admin` | boolean | no | `false` | | Marca al administrador creado junto con la clínica (RF1). |

Restricciones: `CHECK ((role_code = 'platform_admin') = (clinic_id IS NULL))`; un índice
único parcial permite un solo `is_first_admin` por clínica. Índice:
`idx_app_user_clinic_id` (usuarios de una clínica).

#### `professional`

Perfil clínico de un usuario con rol `professional` (RF4).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `professional_id` | uuid | no | `uuidv7()` | PK | Va en el token como `professional_id`; la RLS de agendas y notas compara contra él. |
| `app_user_id` | uuid | no | | FK → `app_user`, UQ con `clinic_id` | Un perfil por usuario. |
| `full_name` | varchar(128) | no | | | Nombre que se muestra (`Dr. Laura Mora`). |
| `is_active` | boolean | no | `true` | | Borrado lógico. |

`idx_professional_clinic_id` repite la primera columna de la llave primaria.

#### `professional_specialty`

Qué especialidades tiene un profesional (muchos a muchos).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, FK | |
| `professional_id` | uuid | no | | PK, FK | `(clinic_id, professional_id)` → `professional`, `ON DELETE CASCADE`. |
| `specialty_id` | uuid | no | | PK, LR → `specialty` | |

Índices: `idx_professional_specialty_specialty_id`; `idx_professional_specialty_clinic_id`
repite la primera columna de la llave primaria.

#### `patient`

Pacientes de una clínica y sus datos de contacto (RF14). Toda lectura o cambio del
contacto escribe un evento de auditoría (RF18).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | La misma persona registrada en dos clínicas son dos pacientes: las clínicas no comparten datos (I5). |
| `patient_id` | uuid | no | `uuidv7()` | PK | |
| `identification` | varchar(32) | no | | UQ con `clinic_id` | Cédula o pasaporte. |
| `full_name` | varchar(128) | no | | | |
| `birth_date` | date | no | | | |
| `phone` | varchar(32) | sí | | | Dato de contacto. |
| `email` | varchar(128) | sí | | | Dato de contacto. |

`idx_patient_clinic_id` repite la primera columna de la llave primaria.

#### `outbox` (users_db)

Outbox transaccional: eventos escritos en la misma transacción que el cambio que
describen. Aquí son eventos `AuditRecorded` por lecturas y escrituras del contacto de
pacientes; el relay de auditoría de audit-service los copia a `audit_log` (RF18).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `event_id` | uuid | no | `uuidv7()` | PK | Se vuelve `audit_log.audit_log_id`, así que entregar un evento dos veces lo inserta una sola. |
| `aggregate_id` | uuid | no | | | El paciente del que trata el evento. |
| `event_type` | varchar(64) | no | | | `AuditRecorded`. |
| `payload` | jsonb | no | | | El evento: quién, qué, sobre qué paciente, cuándo. |
| `created_at` | timestamptz | no | `now()` | | |
| `published_at` | timestamptz | sí | | | `NULL` mientras está pendiente; lo llena el relay. |

El rol de la aplicación solo puede insertar; el rol del relay (`medicitas_relay`) lee y
marca eventos de todas las clínicas y no puede tocar ninguna otra tabla.

### appointments_db

#### `working_hours`

Horario semanal de un profesional, con varios bloques por día (RF5).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `working_hours_id` | uuid | no | `uuidv7()` | PK | |
| `professional_id` | uuid | no | | LR → `professional` | |
| `weekday` | smallint | no | | | 0 = domingo … 6 = sábado. `CHECK 0-6`. |
| `start_time` | time | no | | | Hora local de la clínica. |
| `end_time` | time | no | | | Hora local; `CHECK start_time < end_time` (ningún turno cruza la medianoche). |

`EXCLUDE no_overlap_working_hours`: dos bloques del mismo profesional en el mismo día de la
semana no se pueden traslapar. Su índice GiST también sirve para leer la semana de un
profesional.

#### `schedule_block`

Vacaciones o permisos: un intervalo en que el profesional no recibe citas (RF6, I3).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `schedule_block_id` | uuid | no | `uuidv7()` | PK | |
| `professional_id` | uuid | no | | LR → `professional` | |
| `starts_at` | timestamptz | no | | | |
| `ends_at` | timestamptz | no | | | `CHECK starts_at < ends_at`. |
| `reason` | varchar(256) | sí | | | |

Índice: `(clinic_id, professional_id, starts_at)` para RF7 y RF8.

#### `professional_service`

Qué servicios está habilitado para atender un profesional (RF4). Vive aquí, junto a las
agendas, porque disponibilidad y reserva lo leen en cada petición.

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `professional_id` | uuid | no | | PK, LR → `professional` | |
| `service_id` | uuid | no | | PK, LR → `service` | |
| `specialty_id` | uuid | no | | LR → `specialty` | La especialidad del servicio cuando se hizo la asociación. **Copia deliberada**, ver [más abajo](#desviaciones-deliberadas). |

#### `appointment`

La entidad central (RF9-RF13).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `appointment_id` | uuid | no | `uuidv7()` | PK | |
| `professional_id` | uuid | no | | LR → `professional` | |
| `patient_id` | uuid | no | | LR → `patient` | |
| `service_id` | uuid | no | | LR → `service` | |
| `starts_at` | timestamptz | no | | | |
| `ends_at` | timestamptz | no | | | `CHECK ends_at = starts_at + duration_minutes` (I4). **Copia deliberada**, ver [más abajo](#desviaciones-deliberadas). |
| `duration_minutes` | int | no | | | La duración del servicio al momento de reservar. `CHECK > 0` y `<= 1440` (un día; las consultas dependen de ese límite). |
| `status` | varchar(16) | no | `'booked'` | | `booked`, `attended`, `no_show`, `cancelled`, `rescheduled` (`CHECK`). |
| `cancel_reason` | varchar(256) | sí | | | La API lo exige al cancelar (RF11). |
| `cancelled_by` | uuid | sí | | LR → `app_user` | Quién canceló (RF11). |
| `rescheduled_from_id` | uuid | sí | | FK → `appointment`, UQ con `clinic_id` | En el reemplazo: la cita que reemplaza (RF10). Única, así que una cita se reemplaza a lo sumo una vez. |
| `created_by` | uuid | no | | LR → `app_user` | Quién reservó. |
| `created_at` | timestamptz | no | `now()` | | |
| `status_changed_at` | timestamptz | no | `now()` | | Último cambio de estado; lo pone el trigger si la actualización no lo hizo. |
| `status_changed_by` | uuid | sí | | LR → `app_user` | |
| `updated_at` | timestamptz | no | `now()` | | Cualquier cambio; lo pone el trigger. |

Restricciones que sostienen las invariantes:

- `EXCLUDE no_overlap_professional (clinic_id =, professional_id =, tstzrange(starts_at, ends_at, '[)') &&) WHERE status = 'booked'` (I1).
- `EXCLUDE no_overlap_patient` con `patient_id` (I2).
- Trigger `trg_appointment_status_transition`: un estado distinto de `booked` nunca cambia (RF13).

Índices y la consulta que sirve cada uno: [indexes.es.md](indexes.es.md).

#### `clinical_note`

La nota que escribe un profesional sobre una cita atendida (RF15). Solo ese profesional la
lee o la edita; cada lectura y escritura deja un evento de auditoría (RF18).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, FK | |
| `clinical_note_id` | uuid | no | `uuidv7()` | PK | |
| `appointment_id` | uuid | no | | FK, UQ con `clinic_id` | `(clinic_id, appointment_id)` → `appointment`: la nota y su cita siempre están en la misma clínica. Una nota por cita. |
| `professional_id` | uuid | no | | LR → `professional` | Autor; la RLS lo compara con el `professional_id` del token. **Copia deliberada**, ver [más abajo](#desviaciones-deliberadas). |
| `appointment_status` | varchar(16) | no | `'attended'` | | `CHECK = 'attended'`. **Copia deliberada**, ver [más abajo](#desviaciones-deliberadas). |
| `content` | text | no | | | |
| `created_at` | timestamptz | no | `now()` | | |
| `updated_at` | timestamptz | no | `now()` | | La pone un trigger en cada actualización. |

#### `outbox` (appointments_db)

Misma estructura que en users_db. Dos tipos de evento: `AuditRecorded` (lecturas y
escrituras de notas, que audit-service entrega a `audit_log`) y `AgendaChanged` (cambió la
agenda de un profesional; appointments-service lo entrega a Redis para invalidar la caché
de disponibilidad, I8). Un índice parcial sobre `created_at WHERE published_at IS NULL`
guarda solo los eventos pendientes.

#### `idempotency_keys`

Reservada para un encabezado `Idempotency-Key` en las reservas: la respuesta guardada se
devolvería a una petición reintentada. **Todavía no la usa** la API ([concurrency.es.md, límites conocidos](concurrency.es.md)).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `key` | varchar(128) | no | | PK | La llave del cliente. |
| `request_hash` | varchar(64) | no | | | Hash de la petición, para rechazar la misma llave con otro cuerpo. |
| `response_status` | smallint | no | | | |
| `response_body` | jsonb | no | | | |
| `created_at` | timestamptz | no | `now()` | | |
| `expires_at` | timestamptz | no | `now() + 24 h` | | |

### logs_db

#### `audit_log`

Bitácora de solo inserción de toda lectura y escritura de notas clínicas y del contacto de
pacientes (RF18), que consulta el administrador de la clínica (RF19).

| Columna | Tipo | Nulo | Defecto | Llave | Descripción |
| --- | --- | --- | --- | --- | --- |
| `clinic_id` | uuid | no | | PK, LR → `clinic` | |
| `audit_log_id` | uuid | no | `uuidv7()` | PK | El `event_id` del evento del outbox del que viene. |
| `app_user_id` | uuid | no | | LR → `app_user` | Quién. |
| `patient_id` | uuid | no | | LR → `patient` | Sobre quién. |
| `action` | varchar(16) | no | | | `read`, `create`, `update` (`CHECK`). |
| `resource` | varchar(32) | no | | | `clinical_note`, `patient_contact` (`CHECK`). |
| `resource_id` | uuid | no | | LR → nota o paciente | Qué nota, o el contacto de qué paciente. |
| `occurred_at` | timestamptz | no | `now()` | | Cuándo pasó, no cuándo lo copió el relay. |

Unos triggers rechazan `UPDATE`, `DELETE` y `TRUNCATE`, incluso al dueño de la tabla; el
rol de la aplicación solo tiene `SELECT` e `INSERT` (I6). Índices:
`(clinic_id, occurred_at)`, `(clinic_id, patient_id, occurred_at)`,
`(clinic_id, app_user_id, occurred_at)`, uno por cada filtro de RF19.

## Normalización

### Dependencias funcionales del dominio

Las reglas del enunciado, escritas como dependencias (→ se lee "determina"):

- Una clínica: `clinic_id → identifier, name, time_zone, is_active`; `identifier → clinic_id`.
- Una especialidad: `specialty_id → name`; `name → specialty_id`.
- Un servicio: `(clinic_id, service_id) → specialty_id, name, duration_minutes, is_active`;
  `(clinic_id, name) → service_id`.
- Un usuario: `app_user_id → keycloak_sub, clinic_id, role_code, is_active`;
  `keycloak_sub → app_user_id`. Un rol: `role_code → description`.
- Un profesional: `(clinic_id, professional_id) → app_user_id, full_name, is_active`;
  `(clinic_id, app_user_id) → professional_id`. Especialidades y servicios son
  multivaluados: un profesional tiene varios de cada uno.
- Un paciente: `(clinic_id, patient_id) → identification, full_name, birth_date, phone, email`;
  `(clinic_id, identification) → patient_id`.
- Una cita: `(clinic_id, appointment_id) →` profesional, paciente, servicio, `starts_at`,
  `duration_minutes`, estado y sus campos de historia. Además
  `starts_at, duration_minutes → ends_at`.
- Una nota: `(clinic_id, clinical_note_id) → appointment_id, content, ...`;
  `(clinic_id, appointment_id) → clinical_note_id` (una nota por cita).

### Primera forma normal

Cada columna guarda un solo valor y ninguna tabla tiene grupos repetidos.

- **Los horarios** son una fila por bloque (`weekday`, `start_time`, `end_time`), no un
  arreglo ni un texto "lunes: 08-12, 13-17". Eso es lo que permite que una restricción
  `EXCLUDE` prohíba bloques traslapados y que RF7 lea un solo día.
- **Las especialidades de un profesional** y **los servicios de un profesional** son tablas
  propias (`professional_specialty`, `professional_service`), no listas dentro de
  `professional`.
- **Los datos de contacto** son columnas separadas (`phone`, `email`), un valor cada una.
- **El estado** es un solo valor; su historia está en columnas separadas
  (`status_changed_at`, `status_changed_by`, `cancel_reason`, `cancelled_by`) y en la
  cadena de `rescheduled_from_id`, no en una lista.
- Toda tabla tiene llave primaria, así que ninguna fila se repite.

Las únicas columnas no atómicas son `outbox.payload` e `idempotency_keys.response_body`
(`jsonb`). Son mensajes, no datos del dominio: se escriben una vez, el relay los lee
enteros o se le devuelven enteros al cliente, y nunca se consultan por sus atributos. Los
campos de auditoría de un `payload` se vuelven columnas propias al llegar a `audit_log`.

### Segunda forma normal

Ninguna columna que no sea de la llave puede depender de solo una parte de una llave
compuesta. Toda tabla de un inquilino tiene la llave `(clinic_id, <entidad>_id)`, así que
la pregunta es si algo depende solo de `clinic_id` o solo del id de la entidad.

- **Solo de `clinic_id`**: nada. Los datos propios de la clínica (`name`, `time_zone`)
  viven en `clinic` y no se repiten en ninguna tabla: appointments-service le pide la zona
  horaria a clinics-service en vez de guardarla junto a las citas.
- **Solo del id de la entidad**: un UUID v7 es único en la práctica, así que
  `appointment_id` solo identificaría la fila. Pero la base solo hace cumplir la unicidad
  del par, y el par es lo que hace que las llaves foráneas compuestas mantengan a un hijo
  en la clínica de su padre (`clinical_note (clinic_id, appointment_id) → appointment`).
  Con el par como llave, todas las demás columnas dependen de la llave completa.
- **`professional_specialty`** es toda llave: no hay nada que revisar.
- **`professional_service`** tiene la llave `(clinic_id, professional_id, service_id)`, y
  `specialty_id` depende solo de `service_id`. **Es el único lugar que rompe la 2FN, a
  propósito**: se explica [más abajo](#desviaciones-deliberadas).

### Tercera forma normal

Ninguna columna que no sea de la llave puede depender de otra columna que tampoco lo sea.

- **`service.duration_minutes`** se queda en `service`, el único lugar que la define.
  `appointment.duration_minutes` no es una copia de ella sino otro hecho: la duración con
  que se reservó la cita. Si la clínica cambia después el servicio a 45 minutos, las citas
  existentes conservan sus 30 (I4). Igual que una línea de factura conserva el precio al
  que se vendió.
- **Las descripciones de los roles** están en `role`; `app_user` solo guarda `role_code`.
- **Los nombres de las especialidades** están en `specialty`; servicios y profesionales
  apuntan a ella.
- **El nombre de un profesional** está en `professional`, no se repite en citas ni agendas,
  que solo llevan el `professional_id`.
- **El contacto de un paciente** está solo en `patient`. Las citas y la bitácora guardan
  solo el `patient_id`.
- Tres columnas sí dependen de otras que no son de la llave, a propósito:
  `appointment.ends_at` (de `starts_at` y `duration_minutes`),
  `clinical_note.professional_id` y `clinical_note.appointment_status` (de la cita a la
  que pertenece la nota). Se explican [más abajo](#desviaciones-deliberadas).

**Boyce-Codd.** Además de las llaves primarias, los determinantes son
`clinic.identifier`, `specialty.name`, `(clinic_id, name)` de `service`,
`app_user.keycloak_sub`, `(clinic_id, app_user_id)` de `professional`,
`(clinic_id, identification)` de `patient` y `(clinic_id, appointment_id)` de
`clinical_note`. Cada uno está declarado `UNIQUE`: son llaves candidatas, así que esas
tablas también están en FNBC.

## Desviaciones deliberadas

Cada lugar donde el modelo guarda algo que podría derivar, con el motivo y qué lo mantiene
consistente.

| Dónde | Qué repite | Por qué | Qué lo mantiene consistente | Costo |
| --- | --- | --- | --- | --- |
| `appointment.ends_at` | `starts_at + duration_minutes` | Las restricciones de exclusión que sostienen I1 e I2 necesitan el intervalo como expresión sobre columnas de la fila, y las consultas de RF7, RF8 y RF20 comparan el fin directamente en vez de recalcularlo en cada fila. | `CHECK (ends_at = starts_at + make_interval(mins => duration_minutes))`: el motor rechaza cualquier fila donde no coincida. | 8 bytes por cita. |
| `professional_service.specialty_id` | `service.specialty_id`, que vive en otra base | El servicio y su especialidad viven en clinics_db. Copiar la especialidad al hacer la asociación permite que disponibilidad y reserva (RF7-RF9) comprueben "este profesional todavía puede atender este servicio" dentro de appointments_db, en la misma transacción, sin llamar a clinics-service. Si la clínica cambia después la especialidad del servicio, el valor guardado ya no coincide y la asociación deja de ofrecer espacios hasta que se vuelva a hacer, lo que vuelve a validar que el profesional tenga la especialidad nueva (RF4). | La asociación solo la escribe el servicio que valida la especialidad contra users-service; reserva y disponibilidad la comparan con la especialidad actual del servicio. | Una asociación desactualizada no ofrece espacios hasta que un administrador la renueve. |
| `clinical_note.professional_id` | `appointment.professional_id` | La RLS deja a un profesional leer solo sus notas. Con el autor en la nota, la política es `professional_id = app_current_professional_id()`, una comparación simple sobre la fila. Sin él, la política necesitaría una subconsulta a `appointment` por cada nota leída. | El servicio lo escribe a partir de la cita, en la misma transacción que valida que quien llama es el profesional de esa cita; la política rechaza una inserción con otro profesional. | 16 bytes por nota. |
| `clinical_note.appointment_status` | `appointment.status` al momento de la nota | Deja en la fila la regla "solo las citas atendidas tienen nota" y el estado que tenía la cita cuando se escribió. | `CHECK (appointment_status = 'attended')`, y el servicio escribe la nota solo después de leer la cita como `attended`, en la misma transacción. Una cita atendida nunca vuelve a cambiar de estado (RF13). | No agrega información que la cita no tenga; documenta la regla donde está la nota. |
| `audit_log.patient_id` con `resource = 'patient_contact'` | `resource_id`, que es el mismo paciente | La bitácora tiene una sola forma para todas las entradas, así que RF19 filtra por paciente con un solo índice, tanto para notas como para contacto. | El relay valida cada evento antes de insertarlo. | 16 bytes por entrada de contacto. |

### Otras decisiones que no son de normalización

- **No hay llaves foráneas entre bases.** Cada servicio es dueño de su base; una referencia
  a una fila de otro servicio se valida por la API de ese servicio al escribirla. Una llave
  foránea no puede abarcar dos bases de PostgreSQL, y juntarlas desharía la separación
  entre servicios. El costo es que una fila borrada en otro lado dejaría un id huérfano;
  las entidades a las que apuntan otras bases (clínicas, servicios, usuarios,
  profesionales, pacientes) nunca se borran físicamente, solo se desactivan, así que eso
  no pasa.
- **`audit_log` no tiene llaves foráneas ni siquiera en su propia base.** Es historia: una
  entrada debe sobrevivir a lo que le pase a la nota, el paciente o el usuario que nombra.
- **`specialty` es global, no por clínica.** "Cardiología" significa lo mismo en todas las
  clínicas, y una lista global le permite a la plataforma mantener un solo catálogo. Es la
  única tabla del dominio sin `clinic_id`, y nada en ella es privado de una clínica.
- **`clinic_id` en todas las llaves, aun donde bastaría el id de la entidad**: ver la
  segunda forma normal arriba. Es redundante en teoría (un UUID v7 no se repite) y es lo
  que hace funcionar el aislamiento y las llaves foráneas compuestas.
