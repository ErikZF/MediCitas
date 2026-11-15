# Informe de pruebas

[English](test-report.md) · **Español**

Cobertura por requisito funcional (RF) e invariante (I), opciones del runner y
resultados registrados.

## Cómo se corren

```bash
npm install
npm run test:all
```

Prepare `.env` solo si no existe, como indica el [README raíz](../README.es.md#arranque-local).
El runner requiere Docker con Compose, Node.js >=22.18, dependencias npm y puertos
de prueba libres. Automatiza PostgreSQL/Redis, pero no prepara la fixture optativa
de Keycloak `j2`. Ejecuta dos etapas:

1. **Pruebas unitarias, de integración y de carrera** de los ocho workspaces. El
   comando levanta un PostgreSQL 18 y un Redis desechables
   ([`docker-compose.test.yml`](../docker-compose.test.yml), puertos 55432 y 56379,
   datos en memoria), compila todo, corre cada suite y borra los contenedores. Cada
   suite crea sus propias bases a partir de los `init.sql` reales, así que nunca toca
   la pila de demo en esta etapa. La limpieza predeterminada elimina el proyecto
   de pruebas con sus volúmenes/huérfanos; `--keep` la desactiva. También reemplaza
   el directorio local `test-results/`. La duración depende de la máquina.
2. **De punta a punta** ([`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs)):
   25 pasos a través del gateway de la pila que levanta `docker compose up`, con tokens
   reales de Keycloak, Redis real y el relay de auditoría. El comando corre antes
   `docker compose up -d --build`, para que la pila ejecute el código de esta copia y no
   una imagen vieja (solo recompila lo que cambió; los datos se quedan), y espera a que
   Keycloak tenga los usuarios de demo.

Al final imprime una línea por suite. El código 0 indica que pasaron las etapas
ejecutadas; Vitest aún puede reportar pruebas omitidas, incluidas las del realm
temporal. Los reportes
de vitest quedan en `test-results/` (ignorado por git).

| Opción | Qué hace |
| --- | --- |
| `npm run test:all -- --no-e2e` | Solo la etapa 1 |
| `npm run test:e2e` | Solo la etapa 2 |
| `npm run test:all -- --keep` | Deja corriendo los contenedores de prueba |
| `npm run test:all -- --external` | Usa URL de prueba predefinidas en vez de contenedores; conserva la etapa 2 salvo que se combine con `--no-e2e` |

La etapa 2 deja rastro en los datos de demo, como cualquier usuario de la API: una
clínica nueva, un servicio, un profesional, un paciente, algunas citas y el desenlace de
una reserva ya empezada de dr.mora. Recompila la pila de demo y conserva sus
volúmenes. Use datos locales descartables, no bases compartidas. El recorrido
consume la 804 u otra reserva elegible de los últimos 45 días; las reservas
preparadas pueden agotarse. No elimine volúmenes para reiniciar datos compartidos.

**En CI** ([ci-cd.es.md](ci-cd.es.md)), el job `integration-tests` corre la etapa 1 con
el mismo comando contra contenedores de servicio de PostgreSQL 18 y Redis, y el job
`e2e-compose` corre la etapa 2 como lo haría el evaluador: un clon nuevo,
`cp .env.example .env` y el comando documentado.

## Corrida registrada de etapa 1

Resultados de etapa 1 registrados en `69a9c81` para 2026-11-15:

| Suite | Pasan | Fallan | Saltadas |
| --- | ---: | ---: | ---: |
| `packages/auth` | 162 | 0 | 0 |
| `packages/db` | 62 | 0 | 0 |
| `packages/http` | 9 | 0 | 0 |
| `services/edge-gateway` | 40 | 0 | 0 |
| `services/clinics-service` | 7 | 0 | 0 |
| `services/users-service` | 15 | 0 | 2 |
| `services/appointments-service` | 161 | 0 | 0 |
| `services/audit-service` | 28 | 0 | 0 |
| **Total** | **484** | **0** | **2** |

Las dos pruebas saltadas de users-service crean usuarios en un realm desechable de
Keycloak (`J2_TEMP_REALM=1`) que solo existe en la máquina de quien las corre. Lo que
comprueban tiene cobertura RF1/RF2 separada en el E2E del realm de demo; eso no
significa que se ejecutaran las pruebas omitidas. Vea [prerrequisitos de Keycloak](ci-cd.es.md).

El workflow configura la etapa 2 para pushes a `main`, `feat/**`, `fix/**` y PR
hacia `main`. Vea la [configuración de CI](ci-cd.es.md).

## Qué demuestra cada tipo de prueba

| Tipo | Dónde | Qué es real | Qué se reemplaza |
| --- | --- | --- | --- |
| **Unitaria** | `*/tests/unit`, `packages/auth/tests` | La lógica: cálculo de espacios y zonas horarias, matriz de permisos, contexto de inquilino desde el token, mapeo de errores, reintentos | La base de datos (stubs) |
| **Integración** | `*/tests/integration` | La app HTTP del servicio, el esquema real (restricciones, triggers, RLS, roles) en PostgreSQL 18, Redis | La mayoría de las suites inyecta la identidad que traería el token; varias arrancan el servidor normal y firman JWT reales con una llave de prueba, y `packages/auth` prueba la validación de la firma |
| **Carrera** | `appointments-service/tests/race` | Handlers HTTP concurrentes contra PostgreSQL | Identidad y dependencias de catálogo/paciente inyectadas |
| **Punta a punta** | `deploy/scripts/test-all-endpoints.mjs` | La pila de `docker compose up`: cinco servicios HTTP incluido el gateway, cuatro bases, Keycloak, Redis, los relays | Nada |

## Requisitos funcionales

Las rutas son relativas a la carpeta `tests/` de cada servicio. "E2E" es un paso de la
etapa de punta a punta.

| RF | Qué se comprueba | Dónde |
| --- | --- | --- |
| **RF1** Alta de clínica con su primer administrador | Primer administrador obligatorio, zona horaria válida, campos que controla el dueño; el alta coordina clínica, `users_db` y Keycloak con recuperación, no mediante una transacción distribuida | clinics `unit/clinic-registration.test.ts`; E2E "POST /clinics" |
| **RF2** Gestión de usuarios: alta, baja lógica, rol | Escrituras entre clínicas y actores de plataforma rechazados antes de tocar Keycloak; una asignación de rol fallida revierte el SQL y borra la cuenta; la entrada pública no fija clínica ni identidad | users `integration/user-management.test.ts`, `unit/user-management.test.ts`; E2E "POST /users", "PUT role & DELETE" |
| **RF3** Catálogo de servicios | CRUD de nombre, duración, especialidad y estado; ids de otras clínicas invisibles; RLS lo hace cumplir por su cuenta | clinics `integration/service-catalog.test.ts`; E2E "RF3 lifecycle" |
| **RF4** Profesionales, especialidades y servicios | Registro local seguido de sincronización del claim Keycloak; especialidades incompatibles e ids ajenos rechazados; un servicio asociado da espacios y reservas reales | users `integration/professionals.test.ts`; pasos "RF4" del E2E |
| **RF5** Horario semanal | Turnos partidos, reemplazo, traslape rechazado por el motor (409), un profesional solo su propio horario | appointments `integration/schedule.test.ts` |
| **RF6** Bloqueos de agenda | Un bloqueo lista las citas reservadas que traslapa; listado por rango; permisos | appointments `integration/schedule.test.ts`, `race/block-vs-booking.test.ts` |
| **RF7** Espacios libres de un profesional en una fecha | Turno partido en hora local menos reservas y bloqueos; días pasados; horario de verano; 404/422 | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF8** Disponibilidad por servicio en un rango | Profesionales con espacio y solo los días con espacios; límites del rango | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF9** Reservar | 201, 409 `slot_taken`, 409 `patient_overlap`, 422 en cada caso inválido (fuera de horario, bloqueo, servicio no ofrecido, en el pasado, duración en el cuerpo), 403, 404 | appointments `integration/booking.test.ts`; E2E "POST /appointments" |
| **RF10** Reprogramar | La vieja queda `rescheduled`, la nueva apunta a ella, en la misma transacción; un fallo revierte todo; dos recepcionistas a la vez: un 201 y un 409 | appointments `integration/lifecycle.test.ts`; E2E "reschedule" |
| **RF11** Cancelar | Se guardan el motivo y quién canceló; el espacio queda libre de inmediato | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **RF12** Desenlace | Después del inicio; clinic_admin/recepción o el profesional dueño; luego es final | appointments `integration/lifecycle.test.ts`; E2E "outcome" |
| **RF13** Solo transiciones válidas | Salir de un estado final o reprogramar dos veces da 409; cancelar/reprogramar una cita iniciada da 422; el trigger también rechaza transiciones de estado inválidas | appointments `integration/lifecycle.test.ts` |
| **RF14** Pacientes | Registro y cambio de contacto atómicos con su evento de auditoría; duplicados y entrada inválida; por clínica | users `integration/patients.test.ts`; E2E "patients" |
| **RF15** Nota clínica | Solo el profesional que atendió la escribe y la lee; una por cita, también en carrera; recepción y admin reciben 403 | appointments `integration/clinical-note.test.ts`; E2E "note" |
| **RF16** Historial del paciente | Todos los estados, orden estable, separado por paciente y por clínica | appointments `integration/patient-history*.test.ts`, `unit/patient-history.test.ts` |
| **RF17** Autenticación y autorización | Firma, emisor, audiencia y vencimiento validados con las llaves del proveedor; 401 sin token válido, 403 para un rol fuera de la matriz; nunca se confía en roles que vengan en la petición | auth `jwt.test.ts`, `authorization.test.ts`, `permissions.test.ts`, `tenant-context.test.ts`; appointments `unit/app-wiring.test.ts`; E2E "401" |
| **RF18** Auditar toda lectura y escritura de notas y contacto | Lecturas/escrituras de nota y escrituras de contacto encolan eventos atómicamente; no hay lectura de contacto; los reintentos del relay deduplican por ID | appointments `integration/clinical-note.test.ts`; users `integration/patients.test.ts`; audit `integration/audit-relay.test.ts`; E2E "RF18" |
| **RF19** Consulta de la bitácora del admin de clínica | Filtros por usuario, paciente y fechas; solo clinic_admin; solo su clínica | audit `integration/audit-query*.test.ts`, `integration/audit-runtime.test.ts` |
| **RF20** Agenda del día | Vista de clínica y de profesional, límites de medianoche local (también en días con cambio de horario), sin datos clínicos ni de contacto | appointments `integration/daily-agenda.test.ts` |
| **RF21** Conteo por estado | Límites inclusivo y exclusivo, desfases equivalentes, ceros, solo su clínica | appointments `integration/appointment-counts*.test.ts`, `unit/appointment-counts.test.ts` |

## Invariantes

| Invariante | Qué se comprueba | Dónde |
| --- | --- | --- |
| **I1** Un profesional sin reservas traslapadas | 2 recepcionistas por el mismo espacio, 100 veces: siempre un 201 y un 409; 50 a la vez: un 201 y 49 409; al final ningún profesional tiene dos reservas traslapadas. También el 409 `slot_taken` simple | appointments `race/test.ts`, `integration/booking.test.ts`; db `integration/tenant-tx.test.ts` |
| **I2** Un paciente sin reservas traslapadas en una clínica | El mismo paciente con dos profesionales a la vez: un 201 y un 409 `patient_overlap`, también en concurrencia | appointments `race/test.ts`, `integration/booking.test.ts` |
| **I3** Dentro del horario y fuera de los bloqueos | 422 fuera de horario o dentro de un bloqueo; una reserva y un bloqueo enviados juntos 60 veces: o el bloqueo reporta la reserva ganadora o se rechaza la reserva posterior; cambios posteriores de agenda pueden dejar conflictos | appointments `integration/booking.test.ts`, `race/block-vs-booking.test.ts` |
| **I4** La duración la fija el servicio | El cuerpo no puede mandar el fin ni la duración (422); el fin siempre es el inicio más los minutos del servicio; `CHECK` en el esquema | appointments `integration/booking.test.ts` |
| **I5** Ningún dato de una clínica alcanzable desde otra | Las suites listadas ejercitan IDs de otra clínica, filtros/headers manipulados y RLS sin filtros de aplicación; la reutilización de conexiones comprueba limpieza de contexto. Es cobertura representativa, no prueba exhaustiva de toda combinación de rutas | db `integration/tenant-tx.test.ts`; appointments `integration/*` (booking, schedule, availability, lifecycle, clinical-note, daily-agenda, patient-history, counts); users `integration/patients.test.ts`, `user-management.test.ts`; clinics `integration/service-catalog.test.ts`; audit `integration/audit-query.test.ts`, `audit-append-only.test.ts`; auth `authorization.test.ts` |
| **I6** La bitácora no se modifica desde la aplicación | El rol de la aplicación no puede hacer `UPDATE`, `DELETE` ni `TRUNCATE` (no tiene el privilegio), y los triggers rechazan los tres incluso al dueño de la tabla | audit `integration/audit-append-only.test.ts`, `integration/audit-relay.test.ts` |
| **I7** Cancelar o reprogramar libera el espacio de inmediato | El espacio aparece libre en la siguiente consulta, también con caché | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **I8** La disponibilidad nunca contradice la base | Reservar un espacio listado y volver a consultar: ya no aparece, sin esperar ningún vencimiento; lectores y escritores intercalados; invalidaciones perdidas recuperadas desde el outbox; con Redis caído se lee de PostgreSQL | appointments `integration/availability-cache.test.ts`, `integration/agenda-relay.test.ts`, `unit/agenda-cache.test.ts`; E2E "Redis cache invalidation" |

I3 conserva límites ante cambios posteriores de horario e I8 ante invalidación
asíncrona y fallos entre réplicas; vea [concurrencia](concurrency.es.md) y
[caché](cache.es.md). Estas pruebas no acreditan ambos invariantes sin condiciones.

## Criterios de aceptación del enunciado

Evidencia correspondiente a cada criterio de aceptación:

| # | Criterio | Cómo se muestra |
| --- | --- | --- |
| 1 | Levanta solo | `docker compose up` (README); el job `e2e-compose` lo hace desde un clon nuevo |
| 2 | El ciclo de la cita se cumple | RF9-RF13 arriba; el E2E usa citas distintas para reserva/cancelación y desenlace |
| 3 | La identidad se exige y se respeta | RF17 arriba; el E2E comprueba 401 sin token y 403 con el rol equivocado |
| 4 | El aislamiento se sostiene | I5 arriba |
| 5 | La caché no miente | I8 arriba |
| 6 | La carrera tiene una sola ganadora | I1 arriba (`race/test.ts`, reproducible: 100 iteraciones en cada corrida) |
| 7 | Las pruebas corren | `npm run test:all` |
