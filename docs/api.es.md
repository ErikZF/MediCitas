# Contrato de la API de MediCitas

[English](api.md) · **Español**

## Arquitectura de la API

Las rutas de dominio usan HTTP/JSON y se agrupan por responsabilidad: appointments
contiene horarios, reservas y consultas de citas; audit lee la base de bitácora,
que está separada. La reserva obtiene datos del catálogo y del paciente mediante
dependencias inyectadas antes de su transacción, de modo que las consultas externas
quedan fuera de ella. Las consultas de catálogo, profesional y paciente ya existen.

La identidad se delega en Keycloak, así que la API de dominio no maneja inicio de
sesión ni credenciales. En el arranque normal, los servicios de dominio
derivan la clínica y el rol del Bearer verificado. Los permisos controlan las acciones,
y Row-Level Security (RLS) de PostgreSQL impone el acceso por clínica dentro de las
transacciones. Quien llama no puede elegir otro tenant mediante campos de la petición.

La disponibilidad es una foto, no una reserva. Por eso la reserva deja la decisión
final sobre solapes a las restricciones de PostgreSQL, que también aplican a
inserciones concurrentes. La API expone esa distinción como 201 para una reserva
concedida, 409 para un conflicto de agenda y 422 para entradas inválidas o reglas de
negocio. El gateway es el punto de entrada público: reenvía cada ruta al servicio que la
atiende (ver abajo).

## Disponibilidad real de las rutas

Las rutas de abajo son las mismas a través del gateway (`http://localhost:3000` con
Compose) y en su **servicio dueño**. Todas las funciones de
esta tabla se conectan en su `server.ts` normal; las pruebas también pueden inyectar
dependencias mediante `createApp(deps)`.

| Servicio | Rutas activas al arrancar normalmente | Dependencias | Acceso desde el host con Compose por defecto |
| --- | --- | --- | --- |
| edge-gateway | `GET /`, `GET /health`, y todas las rutas de abajo reenviadas a su servicio | Las cuatro `*_SERVICE_URL` | `API_PORT` (3000 por defecto) |
| clinics-service | `/health`, RF1 `/clinics`, RF3 `/services`, RF4 `/specialties`, `/clinic/time-zone` | Base clinics, Keycloak; users para RF1 | Solo red privada |
| users-service | `/health`, RF2 `/users`, RF4 `/professionals`, RF14 `/patients` | Base users, Admin API de Keycloak, clinics | Solo red privada |
| appointments-service | `/health`, asociaciones RF4, RF5-RF13, RF15-RF16, RF20-RF21 de abajo | Base appointments, clinics, users, Keycloak; caché/relay de agenda Redis opcionales | Solo red privada |
| audit-service | `/health`, RF19 `/audit/logs`, y el relay de auditoría RF18 en segundo plano | Base logs, Keycloak; bases appointments y users para el relay | Solo red privada |

Compose arranca los cinco servicios HTTP, cuatro bases PostgreSQL 18, Keycloak,
su carga de usuarios y Redis. Envíe las peticiones de dominio al gateway. Elige el servicio por la ruta: `/working-hours`
`/blocks` y `/services` de un profesional, y `/appointments` de un paciente van a appointments-service;
las demás rutas de `/professionals` y `/patients`, a users-service. Quita los headers de
salto (hop-by-hop) y `x-test-context`, agrega `X-Forwarded-*`, y responde 502
`upstream_unavailable`, 504 `upstream_timeout` o 503 `upstream_not_configured` cuando no
alcanza un servicio. El override de puertos local del
[README](../README.es.md#arranque-local) es solo para llamar a un servicio directamente.

Reservas, disponibilidad y horarios llaman a otros servicios con el Bearer de quien
llama antes de la transacción que consulta o cambia la agenda. La reprogramación
primero lee la cita actual en otra transacción para obtener su ID de servicio:

| Llamada | Para qué | Estado hoy |
| --- | --- | --- |
| clinics `GET /services/:serviceId` | Especialidad, duración, zona horaria e `isActive` | Los tres roles de clínica |
| users `GET /professionals/:professionalId` | Profesional activo de la clínica | 200 `{ professionalId }`; el administrador recibe también `specialtyIds` |
| users `GET /patients/:patientId` | Que el paciente pertenezca a la clínica; solo se lee `patientId` | Implementado (RF14): 200 `{ patientId }` |

Un 404 de esos servicios se responde como 404. Cualquier otra falla (403, 5xx,
timeout de 3 segundos, cuerpo inutilizable) se responde como 503 `dependency_unavailable`.

## Identidad, permisos y formatos compartidos

- Las rutas de dominio de clinics y users verifican Bearer y derivan de él el contexto.
- Todas las rutas de appointments-service y RF19 verifican `Authorization: Bearer <access_token>`
  cuando se montan sin un `resolveContext` que lo reemplace, cosa que solo hacen las pruebas.
  MediCitas no tiene endpoint de inicio de sesión. `x-test-context` es solo para pruebas.
- La clínica viene de la identidad verificada, nunca de campos del body o del query ni
  de los headers `x-clinic-id` / `x-role`. El acceso se limita a esa clínica.
- Los tokens necesitan `exp`, `sub`, issuer y audience correctos, un `app_user_id`
  UUID (o `user_id`), un rol de dominio y un `clinic_id` UUID para los roles de clínica;
  los profesionales además necesitan un `professional_id` UUID. El rol es el claim
  `role` válido o el primer rol reconocido en `realm_access.roles`. `platform_admin`
  no tiene clínica y solo puede dar de alta clínicas y usar su bootstrap interno.
- Los bodies JSON usan `Content-Type: application/json`. Los GET documentados no
  llevan body. Los identificadores de ruta son UUID; un ID de ruta mal formado
  devuelve **404**, no 422 (el bootstrap interno usa 422). Los UUID en bodies y queries se validan con 422.
- Los instantes de entrada usan ISO 8601 con `Z` o un desfase explícito, por ejemplo
  `2027-01-04T09:00:00-06:00`; los de salida usan UTC con `Z`.
  Codifique `+` como `%2B` en los queries para conservar los desfases positivos.
- Las fechas de disponibilidad usan `YYYY-MM-DD` en la zona IANA de la clínica.
  Los intervalos de citas y bloqueos son `[inicio, fin)`: citas pegadas no se
  solapan. El rango de fechas de RF8 incluye ambos extremos.
- RF3, el registro de profesionales, reservar, reprogramar, cancelar, el desenlace,
  RF19 y RF21 usan objetos estrictos: los campos extra producen 422. Los esquemas
  de horarios, bloqueos y disponibilidad descartan los campos desconocidos; esos
  campos no pueden cambiar la clínica. RF16 ignora los parámetros del query.

Abajo, **roles de clínica** significa `clinic_admin`, `receptionist` y `professional`.
Todas las rutas de dominio montadas pueden devolver 401 por falta de contexto, 403 por
acceso denegado y los [errores compartidos](#errores-compartidos); los casos
adicionales se listan en cada ruta.

## Health y raíz pública

Sin autenticación, parámetros ni body; respuesta exitosa: 200.

| Servicio | Método y ruta | Salida |
| --- | --- | --- |
| edge-gateway | `GET /` | Texto `Hello World!` |
| edge-gateway | `GET /health` | `{"status":"ok"}` |
| clinics-service | `GET /health` | `{"status":"ok","service":"clinics-service"}` |
| users-service | `GET /health` | `{"status":"ok","service":"users-service"}` |
| appointments-service | `GET /health` | `{"status":"ok","service":"appointments-service"}` |
| audit-service | `GET /health` | `{"status":"ok","service":"audit-service"}` |

Health no comprueba que PostgreSQL, Keycloak o Redis estén listos. Clinics, users y
audit necesitan una configuración de base válida para arrancar, incluso para servir
health. Users además requiere `CLINICS_SERVICE_URL`; su adaptador de identidad
necesita URL de Admin API de Keycloak, realm y secreto de cliente para gestionar
usuarios. Appointments requiere las URL
de clinics/users y configuración válida de caché cuando esté habilitada.

## Alta de clínicas y usuarios (RF1-RF2)

| Dueño / rol | Método y ruta | Entrada | Éxito |
| --- | --- | --- | --- |
| clinics / platform_admin | `POST /clinics` | `{ name, identifier, timeZone, administrator: { username, initialPassword } }` | 201 `{ clinicId, identifier, appUserId }` |
| users / clinic_admin | `POST /users` | `{ username, initialPassword, role }` | 201 `{ appUserId, clinicId, role }` |
| users / clinic_admin | `PUT /users/:id/role` | `{ role }` | 204 |
| users / clinic_admin | `DELETE /users/:id` | Sin body | 204, baja lógica |

Bodies estrictos. Nombre/identificador de clínica: 128/32 caracteres recortados;
`timeZone` debe ser zona IANA. Username: 3-128 caracteres recortados; contraseña
inicial: 12-256 caracteres. Roles: `clinic_admin`, `receptionist`, `professional`.
No hay listado de clínicas/usuarios, GET de usuario ni login de dominio.

Body inválido: 422 `invalid_request`; ID de usuario mal formado o invisible: 404.
Conflictos del alta: 409 `clinic_exists`/`bootstrap_conflict`; dependencias: 503
`bootstrap_unavailable`. Un alta incompleta se puede reintentar con el mismo
identificador, nombre, zona y username del administrador. Gestión de usuarios:
409 `username_taken`/`conflict`, 401 `identity_out_of_date` o 503
`identity_unavailable`/`activation_unconfirmed`. Para el último, el header
`Location: /users/:id/role` del POST identifica la recuperación con PUT y el mismo
rol; no repita a ciegas la creación. Cambiar rol invalida sesiones; obtenga tokens nuevos.

Handshake interno de RF1, también exclusivo de platform_admin: clinics
`GET /clinics/:id/pending-admin` devuelve 200 `{ clinicId, appUserId, username }`
solo para clínicas pendientes (si no, 404). Users `POST /users/bootstrap/:id` recibe
`{ initialPassword }`, consulta ese registro y devuelve 201
`{ appUserId, clinicId, role: "clinic_admin" }`; entrada inválida: 422, pendiente
inexistente: 404, conflictos: 409, dependencias: 503. Para la demo use `POST /clinics`.

Los roles de clínica leen `GET /clinic/time-zone` en clinics: sin query/body;
200 `{ clinicId, timeZone }`, 422 si hay query y 404 si la clínica no existe.

## Catálogo de servicios (clinics-service, RF3)

Los roles de clínica pueden consultar un servicio individual con `schedule:read`. Solo `clinic_admin` puede listar o gestionar servicios.
La clínica y la identidad vienen solo del Bearer verificado.

| Método y ruta | Salida exitosa |
| --- | --- |
| `POST /services` | 201 `Service`, activo; `Location: /services/:serviceId` |
| `GET /services` | 200 `Service[]`, solo activos, ordenados por nombre y luego ID |
| `GET /services/:serviceId` | 200 `Service`, incluidos los servicios retirados de la clínica |
| `PUT /services/:serviceId` | 200 `Service` actualizado; los inactivos devuelven 404 |
| `DELETE /services/:serviceId` | 204; pone `isActive: false` y conserva la fila; repetirlo también devuelve 204 |

POST/PUT exigen exactamente `{ name, durationMinutes, specialtyId }`: nombre sin
espacios extremos de 1-128 caracteres, duración entera de 1-2147483647 y el UUID de
una especialidad existente.
`Service = { serviceId, name, durationMinutes, specialtyId, isActive, timeZone }`;
`isActive` es solo de salida y `timeZone` viene de la clínica. PUT no puede reactivar.
Campos extra o cualquier query devuelven 422 `invalid_request`; una especialidad
inexistente devuelve 422 `invalid_reference`. Los nombres siguen siendo únicos en la
clínica después de retirar el servicio (409 `duplicate`). Un ID mal formado,
desconocido o de otra clínica devuelve 404 `not_found`.

Retirar un servicio no cambia las citas ni las asociaciones de `professional_service`.
appointments-service rechaza
las reservas nuevas y la disponibilidad de un servicio inactivo con 422
`service_inactive`, y sigue permitiendo reprogramar sus citas existentes.

## Registro de profesionales y asociación a servicios (RF4)

El registro y la asociación exigen `clinic_admin` con `professional:create`. El catálogo de
especialidades permite el registro sin dar permisos de gestión de servicios.

| Dueño | Método y ruta | Entrada | Salida exitosa |
| --- | --- | --- | --- |
| clinics | `GET /specialties` | Sin query | 200 `[{ specialtyId, name }]`, global, ordenado por nombre y luego ID |
| users | `POST /professionals` | `{ appUserId, fullName, specialtyIds }` | 201 `{ professionalId, appUserId, fullName, isActive: true, specialtyIds }` |
| appointments | `PUT /professionals/:professionalId/services/:serviceId` | Sin campos ni query | 204, también al repetir |

`GET /professionals/:professionalId` en users-service exige `schedule:read`
(los tres roles de clínica), UUID en la ruta y ningún query. Devuelve 200
`{ professionalId }`; el administrador recibe también `specialtyIds`. Los perfiles
desconocidos, inactivos o de otra clínica devuelven 404; campos extra en el query,
422; y roles sin permiso, 403.

El body es estricto: appUserId UUID, fullName sin espacios extremos de 1-128
caracteres y un arreglo no vacío de UUID de especialidades distintos. No se aceptan
parámetros de query. El app_user existente debe estar activo, tener el rol
`professional` y pertenecer a la clínica del contexto verificado. Users valida las
especialidades contra clinics antes de su transacción local. Después sincroniza `professional_id` en la cuenta de Keycloak para los tokens nuevos.
Ante 503 `identity_unavailable`, repetir el mismo registro. Si repara el claim, responde 200. Los specialtyIds de salida son UUID canónicos
ordenados. No hay ruta para editar el perfil.

Usuarios desconocidos o de otra clínica devuelven 404 `not_found`; usuarios inactivos
o con otro rol devuelven 422 `invalid_professional_user`; especialidades desconocidas
devuelven 422 `invalid_reference`; una entrada inválida devuelve 422
`invalid_request`; un perfil existente devuelve 409 `duplicate`. Una falla del
catálogo, una respuesta inválida o su timeout de 5 segundos devuelven 503
`catalog_unavailable` sin escrituras locales. También aplican los 401/403 y errores
compartidos.

`CLINICS_SERVICE_URL` es la URL base alcanzable de clinics. El cliente reenvía el
Bearer original; ambos servicios lo verifican por separado, así que issuer y audience
deben ser válidos para los dos. La asociación consulta a ambos propietarios antes de escribir en `professional_service`.
Los IDs ajenos o desconocidos devuelven 404. Un servicio retirado o una especialidad incompatible devuelven 422
(`service_inactive` o `specialty_mismatch`). Si cambia la especialidad del servicio, disponibilidad y reserva exigen una asociación que coincida.

## Horarios y bloqueos (appointments-service, RF5-RF6)

Lectura: `clinic_admin`, `receptionist`, `professional` (`schedule:read`).
Escritura: `clinic_admin`, o `professional` para su propio `professionalId`
(`schedule:manage`). Recepción solo puede leer.

| Método y ruta | Entrada | Salida exitosa | Rechazos específicos |
| --- | --- | --- | --- |
| `GET /professionals/:professionalId/working-hours` | UUID en la ruta | 200 `{ workingHours: WorkingHours[] }`, ordenados por día de la semana y hora de inicio | 404 UUID mal formado |
| `PUT /professionals/:professionalId/working-hours` | UUID y `{ workingHours: [{ weekday, startTime, endTime }] }` | 200 `{ workingHours: WorkingHours[] }`, guardados y ordenados | 404 profesional fuera de la clínica según `directory`; 409 `schedule_overlap`; 422 `invalid_request` |
| `GET /professionals/:professionalId/blocks` | UUID; instantes opcionales `from` y/o `to` en el query; si van ambos, `from < to` | 200 `{ blocks: Block[] }`, ordenados por inicio; solo los bloqueos que se cruzan con el rango | 404 UUID mal formado; 422 `invalid_request` |
| `POST /professionals/:professionalId/blocks` | UUID y `{ startsAt, endsAt, reason? }`; inicio antes del fin; el motivo opcional se recorta, 1-256 caracteres | 201 `{ block: Block, conflicts: Conflict[] }` | 404 profesional fuera de la clínica según `directory`; 422 `invalid_request` |

`workingHours` acepta 0-42 entradas; `weekday` es un entero de 0 (domingo) a
6 (sábado). Las horas usan `HH:MM` o `HH:MM:00`, con el inicio antes del fin;
`24:00` se permite como hora de fin.
PUT reemplaza toda la semana en una transacción; `[]` la vacía. Si hay solape, el
rollback conserva el horario anterior.

```text
WorkingHours = { workingHoursId: UUID, weekday: number, startTime: "HH:MM", endTime: "HH:MM" }
Block        = { scheduleBlockId: UUID, professionalId: UUID, startsAt: ISO, endsAt: ISO, reason: string|null }
Conflict     = { appointmentId: UUID, patientId: UUID, startsAt: ISO, endsAt: ISO }
```

Crear un bloqueo devuelve las citas `booked` que se cruzan con él, sin cancelarlas.
GET de horarios o bloqueos devuelve 200 con una lista vacía para un UUID válido sin
filas visibles, incluidos profesionales desconocidos o de otra clínica.

## Disponibilidad (appointments-service, RF7-RF8)

Acceso: los tres roles de clínica; `platform_admin` recibe 403.

| Método y ruta | Query requerido | Salida exitosa | Rechazos específicos |
| --- | --- | --- | --- |
| `GET /availability/professionals/:professionalId` | `serviceId` UUID y `date` local; UUID del profesional en la ruta | 200 `{ professionalId, serviceId, durationMinutes, timeZone, date, slots: Slot[] }` | 404 UUID de ruta mal formado o recurso fuera de la clínica según las dependencias; 422 `invalid_request`, `service_not_offered`, `service_inactive` o `invalid_availability_input` |
| `GET /availability` | `serviceId` UUID, fechas locales `from` y `to` | 200 `{ serviceId, durationMinutes, timeZone, from, to, professionals: [{ professionalId, days: [{ date, slots: Slot[] }] }] }` | 404 servicio fuera de la clínica según `catalog`; 422 `invalid_request` o `invalid_availability_input` |

`Slot = { startsAt: ISO, endsAt: ISO }`.
RF8 incluye ambas fechas, acepta como máximo 31 días y rechaza rangos invertidos.
Solo aparecen profesionales y días con espacios disponibles. Sin espacios, RF7
devuelve `slots: []` y RF8 devuelve `professionals: []`, ambos con 200.

La disponibilidad resta bloqueos y citas `booked`, usa la duración del servicio y
omite inicios en el pasado. Con `REDIS_URL` configurado y `CACHE_ENABLED` distinto
de `false`, las lecturas pasan por la
caché de Redis ([cache.es.md](cache.es.md)). Un espacio listado no queda reservado.

## Reservar y consultar una cita (appointments-service, RF9)

### `POST /appointments`

Permiso efectivo: `clinic_admin` o `receptionist` (`appointment:book`).
Body obligatorio y estricto; no se aceptan `clinicId`, `endsAt` ni `durationMinutes`:

```json
{
  "professionalId": "9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03",
  "patientId": "b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06",
  "serviceId": "d4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08",
  "startsAt": "2027-01-04T09:00:00-06:00"
}
```

Estos UUID ilustran la forma de la petición; no son datos de demo validados. La
duración y el fin salen del servicio. El inicio debe estar en el futuro, el
profesional debe ofrecer el servicio y el intervalo debe caber dentro de un bloque de
horario sin cruzar bloqueos. El paciente y el servicio deben pertenecer a la clínica.

| Desenlace | Respuesta y significado |
| --- | --- |
| **201 concedida** | `Appointment` con `status: "booked"`, `cancelReason: null`, `rescheduledFromId: null`; incluye el ID guardado, inicio, fin y duración |
| **409 conflicto** | `{"error":"Request rejected.","code":"slot_taken"}` si se solapa con otra cita del profesional; `patient_overlap` si el paciente ya ocupa ese intervalo en la clínica |
| **422 solicitud inválida** | `{"error":"Request rejected.","code":"invalid_request"}` por un body inválido o campos extra; otros códigos de regla: `starts_in_past`, `service_inactive`, `service_not_offered`, `professional_unavailable`, `outside_working_hours` |

Si aplican varios conflictos, el orden en que se reportan no está garantizado. Las
referencias que no existen en la clínica pueden devolver 404; también aplican los
errores compartidos.

**`Idempotency-Key` no está implementado.** Repetir un POST no garantiza la misma
respuesta ni recuperar una reserva cuya respuesta se perdió.

### `GET /appointments/:appointmentId`

Sin body ni query. Acceso: roles de clínica (`appointment:read`). Devuelve 200 con
`Appointment`; 404 `not_found` para un UUID mal formado o una cita invisible o
desconocida, incluida una de otra clínica.

DTO compartido por reserva, consulta y ciclo de vida, sin envoltorio:

```text
Appointment = {
  appointmentId: UUID, professionalId: UUID, patientId: UUID, serviceId: UUID,
  startsAt: ISO, endsAt: ISO, durationMinutes: number,
  status: "booked"|"attended"|"no_show"|"cancelled"|"rescheduled",
  cancelReason: string|null, rescheduledFromId: UUID|null,
  createdAt: ISO, statusChangedAt: ISO, statusChangedBy: UUID|null, updatedAt: ISO
}
```

No hay ruta implementada para un listado general de citas.

## Ciclo de vida de la cita (appointments-service, RF10-RF13)

Se requiere un UUID `appointmentId` en la ruta. Todos los bodies son estrictos.

| Método y ruta | Permiso | Body | Salida exitosa | Rechazos específicos |
| --- | --- | --- | --- | --- |
| `POST /appointments/:appointmentId/reschedule` | `appointment:reschedule`: clinic_admin, receptionist | `{ startsAt, professionalId? }`; inicio con desfase, UUID de profesional opcional | 201 con la nueva `Appointment` en `booked`, con `rescheduledFromId` igual al ID anterior | 409 `invalid_transition`, `slot_taken`, `patient_overlap`; 422 `invalid_request`, `appointment_started` y errores de las reglas de reserva |
| `POST /appointments/:appointmentId/cancel` | `appointment:cancel`: clinic_admin, receptionist | `{ reason }`; texto recortado, 1-256 caracteres | 200 con `Appointment` en `cancelled` y el motivo | 409 `invalid_transition`; 422 `invalid_request` o `appointment_started` |
| `POST /appointments/:appointmentId/outcome` | `appointment:record-outcome`: clinic_admin, receptionist, professional solo para sus propias citas | `{ outcome: "attended" o "no_show" }` | 200 con `Appointment` en ese estado | 409 `invalid_transition`; 422 `invalid_request` o `appointment_not_started`; 403 para un profesional que actúa sobre una cita visible de otro profesional |

Las tres devuelven 404 para un UUID mal formado o una cita invisible o desconocida;
reprogramar también puede devolver 404 si el servicio no está en la clínica.
Cancelar y reprogramar exigen `startsAt > now`; registrar el desenlace exige
`startsAt <= now`.

Solo `booked` puede pasar a `rescheduled`, `cancelled`, `attended` o `no_show`; los
cuatro son estados finales. No hay un PATCH genérico de estado. Reprogramar conserva
el paciente y el servicio, puede cambiar el profesional y recalcula la duración y el
fin desde el catálogo. La cita vieja pasa a `rescheduled` y la nueva se crea de forma
atómica: si falla, la reserva original se conserva. Después use el **ID nuevo**; una
cita cancelada no puede pasar luego a atendida.

## Nota clínica (appointments-service, RF15)

Se requiere un UUID `appointmentId` en la ruta. Solo el profesional de la cita puede
usar estas rutas. Los bodies son estrictos.

| Método y ruta | Permiso | Body | Salida exitosa | Rechazos específicos |
| --- | --- | --- | --- | --- |
| `POST /appointments/:appointmentId/note` | `clinical-note:create`: professional | `{ content }`; texto recortado, 1-20000 caracteres | 201 con `ClinicalNote` | 409 `note_exists`; 422 `invalid_request` o `appointment_not_attended` |
| `GET /appointments/:appointmentId/note` | `clinical-note:read`: professional | Ninguno | 200 con `ClinicalNote` | 404 `not_found` si la cita todavía no tiene nota |
| `PUT /appointments/:appointmentId/note` | `clinical-note:update`: professional | `{ content }`, mismas reglas | 200 con `ClinicalNote` y un `updatedAt` nuevo | 404 `not_found` si la cita todavía no tiene nota; 422 `invalid_request` |

```text
ClinicalNote = {
  clinicalNoteId: UUID, appointmentId: UUID, professionalId: UUID,
  content: string, createdAt: ISO, updatedAt: ISO
}
```

- **403 `forbidden`** para recepción, administradores de clínica y cualquier
  profesional que no sea el de la cita. RLS también les oculta la nota.
- **404 `not_found`** para un UUID mal formado o una cita de otra clínica.
- **Una nota por cita.** Dos POST simultáneos dan un 201 y un 409.

**Auditoría (RF18, lado productor).** Cada POST, GET y PUT exitoso inserta un evento
`AuditRecorded` en la tabla `outbox` de `appointments_db`, en la misma transacción.
Si el evento no se puede guardar, la petición falla y la nota no se escribe ni se
devuelve. Las peticiones rechazadas (403, 404, 409, 422) no registran nada.
El payload del evento es
`{ appUserId, patientId, action: "create"|"read"|"update", resource: "clinical_note", resourceId, occurredAt }`;
nunca contiene el texto de la nota. El relay de auditoría de audit-service copia cada
evento a `audit_log` en `logs_db` de forma asíncrona, consultando cada segundo (ver [entrega de RF18](#entrega-de-rf18-audit-service)).

## Pacientes (users-service, RF14 parcial)

| Método y ruta | Permiso | Éxito |
| --- | --- | --- |
| `POST /patients` | `patient:create`: clinic_admin, receptionist | 201 `{ patientId }`, `Location: /patients/:patientId` |
| `PATCH /patients/:patientId` | `patient:update`: clinic_admin, receptionist | 204, sin body |
| `GET /patients/:patientId` | `patient:read`: los tres roles de clínica | 200 `{ patientId }`: pertenece a la clínica del token |

POST exige identification, fullName y birthDate; phone/email son opcionales o null.
PATCH acepta un subconjunto no vacío; omitir conserva el campo y null borra
phone/email. Bodies estrictos; sin query. Límites recortados de identification,
fullName, phone y email: 32/128/32/128. Email válido; birthDate es fecha real no
futura YYYY-MM-DD (fecha UTC del servicio).

Errores: 404 not_found para paciente desconocido/ajeno; 409 duplicate_identification
por clínica; 422 invalid_request para entrada inválida/vacía; 503 audit_unavailable
si falla encolar auditoría de contacto (revierte la escritura). La consulta devuelve
solo patientId, sin contacto ni otros datos personales. El registro encola
`AuditRecorded` en `users_db.outbox` incluso con contacto nulo. PATCH lo encola
cuando incluye `phone` o `email`; editar solo otros campos no produce un evento
de contacto. El relay los entrega a `logs_db`. No hay lectura de contacto ni de
perfil: el permiso de lectura del profesional solo devuelve pertenencia a la clínica.

## Historial del paciente (appointments-service, RF16)

`GET /patients/:patientId/appointments`, sin body. Ignora los parámetros del query.
Permiso `appointment:read`: `clinic_admin`, `receptionist`, `professional`, dentro de
su clínica. Los profesionales pueden leer citas de otros profesionales de esa
clínica; esta respuesta no incluye notas clínicas ni datos de contacto.

200 devuelve un arreglo directamente:

```text
[{ appointmentId: UUID, professionalId: UUID, serviceId: UUID,
   startsAt: ISO, endsAt: ISO, status: string, rescheduledFromId: UUID|null }]
```

Incluye los cinco estados actuales y las citas futuras, ordenadas por `startsAt` y
luego `appointmentId`, de forma descendente. Las citas reemplazadas siguen como
entradas separadas. Si no hay citas visibles devuelve **200 `[]`**, incluso para un
paciente desconocido o con citas solo en otra clínica.

404 `not_found` para un UUID de ruta mal formado. Los errores de Bearer o contexto
siguen las reglas compartidas. No hay filtros por fecha, paginación ni historial de
cambios de estado.

## Agenda del día (appointments-service, RF20)

| Método y ruta | Acceso |
| --- | --- |
| `GET /agenda?date=YYYY-MM-DD` | clinic_admin, receptionist |
| `GET /agenda/professionals/:professionalId?date=YYYY-MM-DD` | clinic_admin, receptionist; professional solo para su propio ID |

Ambas exigen un Bearer verificado y exactamente una fecha `date` válida, en la zona
IANA guardada de la clínica. `CLINICS_SERVICE_URL` provee `GET /clinic/time-zone` con
el mismo Bearer; la clínica, el rol y la zona no se pueden elegir con campos del query
ni con headers. 200 devuelve `{ date, timeZone, professionalId: UUID|null, appointments: [...] }`;
cada entrada tiene `{ appointmentId, professionalId, patientId, serviceId, startsAt,
endsAt, status }`, con instantes en UTC. Se incluyen todos los estados actuales y los
intervalos que se cruzan con el día local, ordenados por inicio, ID de profesional y
luego ID de cita. Sin filas visibles devuelve `appointments: []`, incluso para un
profesional desconocido o de otra clínica. Aplican los 401/403 compartidos; un ID de
ruta mal formado con acceso autorizado devuelve 404, campos inválidos o extra en el
query devuelven 422, y una configuración de clínica no disponible o inválida devuelve
503 `clinic_unavailable`.

## Conteo por estado (appointments-service, RF21)

`GET /appointments/counts?from=<instante>&to=<instante>`, sin body.
Permiso `appointment:count`: `clinic_admin` y `receptionist`. Ambos límites son
obligatorios, con desfase y como máximo precisión de milisegundos; `from < to` se
compara como instantes absolutos. El query estricto rechaza `clinicId`, `patientId`,
etc.

200 devuelve esta forma; los ceros ilustran un rango sin citas:

```json
{
  "counts": { "booked": 0, "attended": 0, "no_show": 0, "cancelled": 0, "rescheduled": 0 },
  "total": 0
}
```

Cuenta los estados **actuales** según `startsAt` en `[from, to)` dentro de la
clínica, no las transiciones ni la hora de creación o de fin. Se incluyen los cinco
contadores y su suma. Una cita reprogramada y su reemplazo cuentan por separado si
ambos inicios caen dentro del rango.

403 `forbidden` para los roles profesional y de plataforma; 422 `invalid_request`
para un rango inválido o campos extra.

## Consulta de la bitácora (audit-service, RF19)

`GET /audit/logs`, sin body. Permiso `audit:read`: solo `clinic_admin`.
Query opcional y estricto: `userId` UUID, `patientId` UUID, `from` y/o `to` como
instantes con desfase y como máximo precisión de milisegundos. Si van ambos,
`from < to`; los filtros se combinan con AND. Sin filtros devuelve todos los eventos
visibles de la clínica; no hay paginación ni límite de resultados.

200 devuelve un arreglo directamente, ordenado por `occurredAt` y luego ID, de forma
ascendente:

```text
[{ auditLogId: UUID, clinicId: UUID, userId: UUID, patientId: UUID,
   action: string, resource: string, resourceId: UUID, occurredAt: ISO }]
```

`userId` corresponde al `app_user_id` del registro, no al `sub` de Keycloak.
El rango filtra `occurredAt`, incluye el límite inferior y excluye el superior; se
permite un solo límite. Sin coincidencias devuelve 200 `[]`.

403 `forbidden` para los roles de recepción, profesional o plataforma;
422 `invalid_request` para filtros inválidos o extra. No se verifica en otros
servicios que el usuario o el paciente existan. No hay rutas POST, PUT ni DELETE de
auditoría.

### Entrega de RF18 (audit-service)

No tiene ruta HTTP: audit-service corre cada segundo un relay que toma los eventos
`AuditRecorded` pendientes del `outbox` de `appointments_db` (notas clínicas) y de
`users_db` (contacto de pacientes) como `medicitas_relay`, con `FOR UPDATE SKIP LOCKED`.
Los inserta en `audit_log` con `audit_log_id = event_id` y `ON CONFLICT DO NOTHING`, como
`medicitas_app` con la clínica de cada evento en el contexto, y luego los marca
publicados. Si `logs_db` está caída, los eventos esperan; si el relay muere después de
insertar, la siguiente pasada no puede duplicarlos. Un evento mal formado se registra
en el log y queda pendiente; los eventos válidos del mismo lote pueden avanzar,
pero 100 eventos mal formados al inicio de una fuente pueden impedir seleccionar
los posteriores. No se garantiza el plazo de entrega. Los eventos `AgendaChanged` no se tocan.

## Errores compartidos

Estas respuestas complementan los códigos específicos de cada operación. La primera
falla de middleware, validación o dominio decide la respuesta. Los textos se
conservan tal como los emite el código.

| HTTP | Respuesta / causa |
| --- | --- |
| 400 | `{"error":"Bad request."}` para JSON mal formado |
| 401 | Clinics/users pueden devolver `{"error":"Tenant context required."}`. Falta de contexto: `{"error":"Authentication required."}`. Con `requireToken`: `{"error":"Missing access token."}` o `{"error":"Invalid or expired token."}` |
| 403 | El middleware de permisos RF1/RF2 puede devolver `{"error":"Permission denied."}`. Dominio, permisos o RLS: `{"error":"Request rejected.","code":"forbidden"}` |
| 404 | Recurso: `{"error":"Request rejected.","code":"not_found"}`. Ruta inexistente o no montada: `{"error":"Route not found."}` |
| 409 | Conflictos de cada ruta; el adaptador de base de datos también mapea `duplicate`, `overlap` y `concurrency_conflict` (reintentos de la transacción agotados), con `error: "Request rejected."` |
| 413 | El body JSON excede el límite del parser: `{"error":"Request rejected."}` |
| 422 | `{"error":"Request rejected.","code":"<regla>"}`; además de las reglas listadas, el mapeo de la base incluye `invalid_reference`, `missing_field`, `invalid_value`, `invalid_input` |
| 503 | Falla de una dependencia: `{"error":"Service unavailable.","code":"timeout"}`, `database_unavailable` o `dependency_unavailable` (otro servicio de MediCitas), con `Retry-After: 1` |
| 500 | Error inesperado: `{"error":"Internal server error."}`; configuración JWT inválida: `{"error":"Authentication unavailable."}` |

Los errores no exponen mensajes internos, valores enviados ni SQLSTATE.
Un 503 no garantiza que reintentar un POST sea seguro sin idempotencia. El gateway
tiene un timeout de socket de 15 segundos, mientras el alta de clínica permite
hasta 45 segundos para su bootstrap. Un timeout del gateway no demuestra que el
alta haya revertido; use las reglas de recuperación documentadas.

## Colección para la demo

Importe la [colección Postman](../postman/collections/medicitas-demo.postman_collection.json)
y siga sus [instrucciones de entorno/tokens locales](../postman/README.es.md).

El [recorrido REST Client](../requests/demo.http) y su
[ejemplo de entorno](../requests/.env.example) versionados usan URL directas y
variables locales de tokens. Las respuestas son esperadas, no evidencia de la pila
completa. Obtenga tokens nuevos de usuarios semilla en Keycloak; no guarde secretos en Git.

## Evidencia revisada y trabajo pendiente

El arranque normal conecta los módulos anteriores con sus adaptadores reales.
Las pruebas HTTP con dependencias inyectadas y la prueba automatizada de carrera
son evidencia separada; su presencia no acredita que Compose o el recorrido
completo de Postman hayan pasado. Vea [cobertura y requisitos de pruebas](ci-cd.es.md).

La lectura de perfil/contacto del paciente sigue sin estar disponible. Las secuencias
de reserva/cancelación y desenlace/nota de Postman usan citas distintas. En esta
revisión sigue sin verificarse una demo con la pila completa que lleve una misma
cita desde la reserva hasta su desenlace.
