# Contrato de la API de MediCitas (J5)

[English](api.md) · **Español**

## Arquitectura de la API

Las rutas de dominio usan HTTP/JSON y se agrupan por responsabilidad: appointments
contiene horarios, reservas y consultas de citas; audit lee la base de bitácora,
que está separada. La reserva obtiene datos del catálogo y del paciente mediante
dependencias inyectadas antes de su transacción, de modo que las consultas externas
quedan fuera de ella. Algunos de los endpoints que esos adaptadores llaman todavía
están pendientes (ver más abajo).

La identidad se delega en Keycloak, así que la API de dominio no maneja inicio de
sesión ni credenciales. Donde la verificación del Bearer está conectada, el servicio
deriva la clínica y el rol del token verificado. Los permisos controlan las acciones,
y Row-Level Security (RLS) de PostgreSQL impone el acceso por clínica dentro de las
transacciones. Tomar la clínica de la identidad impide que quien llama elija otro
tenant mediante campos de la petición; los límites de la conexión de autenticación
descritos abajo siguen siendo esenciales.

La disponibilidad es una foto, no una reserva. Por eso la reserva deja la decisión
final sobre solapes a las restricciones de PostgreSQL, que también aplican a
inserciones concurrentes. La API expone esa distinción como 201 para una reserva
concedida, 409 para un conflicto de agenda y 422 para entradas inválidas o reglas de
negocio. El gateway es el punto de entrada público previsto, pero hoy solo sirve la
raíz y health, y no reenvía peticiones.

## Disponibilidad real de las rutas

Las rutas de abajo son relativas a su **servicio dueño**. Todavía no hay prefijo
público ni proxy del gateway hacia ellas. Una ruta implementada y probada mediante
`createApp(deps)` no necesariamente queda expuesta con `npm run dev`.

| Servicio / funcionalidad | Implementada | Dependencias para montarla en `createApp` | Activa al arrancar `server.ts` | Compose / gateway |
| --- | --- | --- | --- | --- |
| Los cinco servicios: `GET /health`; gateway: `GET /` | Sí | Ninguna para montar health | Sí, si el servicio arranca bien | Compose no tiene servicios HTTP; el gateway solo sirve sus dos rutas |
| clinics: catálogo de servicios (RF3) | Sí | `serviceCatalog: { db }` | Sí: base de clinics y Bearer verificado | Sin ruta de punta a punta |
| clinics: especialidades (datos de referencia de RF4) | Sí | `serviceCatalog: { db }` | Sí: misma base de clinics y verificación del Bearer | Sin ruta de punta a punta |
| users: registro de profesionales (RF4 parcial) | Sí | `professionals: { db, specialties }` | Sí: base de users, `CLINICS_SERVICE_URL` y Bearer verificado | Sin ruta de punta a punta |
| appointments: horarios y bloqueos (RF5-RF6) | Sí | `schedule: { db, directory }` | Sí: base de appointments, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` y Bearer verificado | Sin ruta de punta a punta |
| appointments: disponibilidad (RF7-RF8) | Sí | `availability: { db, catalog, directory }` | Sí: base de appointments, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` y Bearer verificado; caché de Redis si hay `REDIS_URL` | Sin ruta de punta a punta |
| appointments: reserva, consulta y ciclo de vida (RF9-RF13) | Sí | `booking: { db, catalog, patients }` | Sí: base de appointments, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` y Bearer verificado | Sin ruta de punta a punta |
| appointments: historial del paciente (RF16) | Sí | `patientHistory: { db }` | Sí: base de appointments y Bearer verificado | Sin ruta de punta a punta |
| appointments: nota clínica (RF15) y sus eventos de auditoría (productor de RF18) | Sí | `clinicalNotes: { db }` | Sí: base de appointments y Bearer verificado | Sin ruta de punta a punta |
| appointments: agenda del día (RF20) | Sí | `dailyAgenda: { db, clinics }` | Sí: base de appointments, `CLINICS_SERVICE_URL` y Bearer verificado | Sin ruta de punta a punta |
| appointments: conteos (RF21) | Sí | `appointmentCounts: { db }` | Sí: mismo arranque de appointments y Bearer verificado | Sin ruta de punta a punta |
| audit: consulta de la bitácora (RF19) | Sí | `auditQuery: { db }` | Sí: crea una conexión a la base de logs y exige Bearer | Sin ruta de punta a punta |

Las asociaciones de servicios de RF4 siguen pendientes. Compose levanta hoy
PostgreSQL, Keycloak y Redis, sin servicios HTTP.

**Dependencias de appointments-service.** Reservas, disponibilidad y horarios llaman
a otros servicios con el Bearer de quien llama, antes de abrir cualquier transacción:

| Llamada | Para qué | Estado hoy |
| --- | --- | --- |
| clinics `GET /services/:serviceId` | Duración, zona horaria de la clínica e `isActive` | Existe, pero responde 403 a tokens de recepción y de profesional |
| users `GET /professionals/:professionalId` | Que el profesional pertenezca a la clínica | Todavía no implementado |
| users `GET /patients/:patientId` | Que el paciente pertenezca a la clínica; solo se lee `patientId` | Todavía no implementado (RF14) |

Un 404 de esos servicios se responde como 404. Cualquier otra falla (403, 5xx,
timeout, cuerpo inutilizable) se responde como 503 `dependency_unavailable`.

## Identidad, permisos y formatos compartidos

- RF3 y las rutas de RF4 de abajo verifican el Bearer y derivan de él el contexto del tenant.
- Todas las rutas de appointments-service y RF19 verifican `Authorization: Bearer <access_token>`
  cuando se montan sin un `resolveContext` que lo reemplace, cosa que solo hacen las pruebas.
  MediCitas no tiene endpoint de inicio de sesión. `x-test-context` es solo para pruebas.
- La clínica viene de la identidad verificada, nunca de campos del body o del query ni
  de los headers `x-clinic-id` / `x-role`. El acceso se limita a esa clínica.
- Los tokens necesitan `exp`, `sub`, issuer y audience correctos, un `app_user_id`
  UUID (o `user_id`), un rol de dominio y un `clinic_id` UUID para los roles de clínica;
  los profesionales además necesitan un `professional_id` UUID. El rol es el claim
  `role` válido o el primer rol reconocido en `realm_access.roles`. `platform_admin`
  no tiene clínica y no puede usar las operaciones de dominio de abajo.
- Los bodies JSON usan `Content-Type: application/json`. Los GET documentados no
  llevan body. Los identificadores de ruta son UUID; un ID de ruta mal formado
  devuelve **404**, no 422. Los UUID en bodies y queries se validan con 422.
- Los instantes de entrada usan ISO 8601 con `Z` o un desfase explícito, por ejemplo
  `2027-01-04T09:00:00-06:00`; los de salida usan UTC con `Z`.
  Codifique `+` como `%2B` en los queries para conservar los desfases positivos.
- Las fechas de disponibilidad usan `YYYY-MM-DD` en la zona IANA de la clínica.
  Los intervalos de citas y bloqueos son `[inicio, fin)`: citas pegadas no se
  solapan. El rango de fechas de RF8 incluye ambos extremos.
- RF3, el registro de profesionales, reservar, reprogramar, cancelar, el desenlace,
  RF19 y RF21 usan objetos estrictos: los campos extra producen 422. Los esquemas
  de horarios, bloqueos y disponibilidad descartan los campos desconocidos; esos
  campos no pueden cambiar la clínica. RF16 no acepta filtros en el query.

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
health. Users además requiere `CLINICS_SERVICE_URL`.

## Catálogo de servicios (clinics-service, RF3)

Acceso: solo `clinic_admin`. POST/GET/PUT/DELETE usan `service:create`,
`service:read`, `service:update` y `service:delete`, respectivamente.
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
Las asociaciones de servicios de RF4 siguen pendientes. appointments-service rechaza
las reservas nuevas y la disponibilidad de un servicio inactivo con 422
`service_inactive`, y sigue permitiendo reprogramar sus citas existentes. La
autorización interna del catálogo está pendiente: esta lectura devuelve 403 a los
tokens de recepción y de profesional, y appointments-service lo responde como 503
`dependency_unavailable`.

## Registro de profesionales (RF4 parcial)

Ambas rutas exigen `clinic_admin` con `professional:create`. El catálogo de
especialidades permite el registro sin dar permisos de gestión de servicios.

| Dueño | Método y ruta | Entrada | Salida exitosa |
| --- | --- | --- | --- |
| clinics | `GET /specialties` | Sin query | 200 `[{ specialtyId, name }]`, global, ordenado por nombre y luego ID |
| users | `POST /professionals` | `{ appUserId, fullName, specialtyIds }` | 201 `{ professionalId, appUserId, fullName, isActive: true, specialtyIds }` |

El body es estricto: appUserId UUID, fullName sin espacios extremos de 1-128
caracteres y un arreglo no vacío de UUID de especialidades distintos. No se aceptan
parámetros de query. El app_user existente debe estar activo, tener el rol
`professional` y pertenecer a la clínica del contexto verificado. Users valida las
especialidades contra clinics antes de su transacción local; el app_user existente y
la cuenta de Keycloak no cambian. Los specialtyIds de salida son UUID canónicos
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
deben ser válidos para los dos. La asignación de servicios de RF4 y la verificación de
cobertura de especialidades siguen pendientes; el registro no crea identidades ni
actualiza claims de Keycloak.

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
omite inicios en el pasado. Con `REDIS_URL` configurado, las lecturas pasan por la
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
  cancelReason: string|null, rescheduledFromId: UUID|null
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
nunca contiene el texto de la nota. Copiar los eventos a `audit_log` en `logs_db` es
tarea del relay (tarjeta N10), que todavía no está implementado.

## Historial del paciente (appointments-service, RF16)

`GET /patients/:patientId/appointments`, sin body ni filtros en el query.
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
auditoría; leer eventos no demuestra que RF18 los esté produciendo.

## Errores compartidos

Estas respuestas complementan los códigos específicos de cada operación. La primera
falla de middleware, validación o dominio decide la respuesta. Los textos se
conservan tal como los emite el código, incluidos los dos mensajes en español que hoy
emite la autenticación.

| HTTP | Respuesta / causa |
| --- | --- |
| 400 | `{"error":"Bad request."}` para JSON mal formado |
| 401 | Falta de contexto: `{"error":"Authentication required."}`. Con `requiereToken`: `{"error":"falta el token de acceso"}` o `{"error":"token inválido o expirado"}` |
| 403 | Dominio, permisos o RLS: `{"error":"Request rejected.","code":"forbidden"}` |
| 404 | Recurso: `{"error":"Request rejected.","code":"not_found"}`. Ruta inexistente o no montada: `{"error":"Route not found."}` |
| 409 | Conflictos de cada ruta; el adaptador de base de datos también mapea `duplicate`, `overlap` y `concurrency_conflict` (reintentos de la transacción agotados), con `error: "Request rejected."` |
| 413 | El body JSON excede el límite del parser: `{"error":"Request rejected."}` |
| 422 | `{"error":"Request rejected.","code":"<regla>"}`; además de las reglas listadas, el mapeo de la base incluye `invalid_reference`, `missing_field`, `invalid_value`, `invalid_input` |
| 503 | Falla de una dependencia: `{"error":"Service unavailable.","code":"timeout"}`, `database_unavailable` o `dependency_unavailable` (otro servicio de MediCitas), con `Retry-After: 1` |
| 500 | Error inesperado: `{"error":"Internal server error."}`; configuración JWT inválida: `{"error":"Authentication unavailable."}` |

Los errores no exponen mensajes internos, valores enviados ni SQLSTATE.
Un 503 no garantiza que reintentar un POST sea seguro sin idempotencia.

## Colección para la demo

La Etapa 2 entregará la colección versionada de peticiones con la configuración del
entorno, las URL de los servicios y variables locales para los tokens. Todavía no se
ha creado. Los usuarios semilla por rol y clínica y el recorrido completo por gateway
y Compose siguen pendientes de validar; ningún token real ni secreto va en Git.

## Evidencia revisada y trabajo pendiente

Contrastado con el código y las pruebas existentes; **durante la etapa 1 de J5 no se
ejecutaron peticiones ni pruebas**. Las pruebas existentes tienen alcances parciales,
incluidos PostgreSQL y dependencias simuladas, sin validar la pila completa con
Keycloak y gateway. El detalle de cobertura corresponde a J7. El registro de RF4 está
implementado; su contrato de asignación de servicios sigue pendiente. Todavía no hay
contrato HTTP operativo para RF1-RF2, **RF14** (registro y actualización de pacientes)
ni para RF18 (el relay que copia los eventos de auditoría a `logs_db`).
