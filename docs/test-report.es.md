# Informe de pruebas

[English](test-report.md) · **Español**

Qué prueba cubre cada requisito funcional (RF) y cada invariante (I), cómo se corren
todas con un solo comando y qué dio la última corrida.

## Cómo se corren

```bash
cp .env.example .env   # solo la primera vez; la etapa de punta a punta usa la pila de demo
npm install
npm run test:all
```

Necesita Docker y Node.js 22.18 o superior, nada más: ninguna base que crear, ninguna
variable que exportar, ningún dato que cargar a mano. Corre dos etapas:

1. **Pruebas unitarias, de integración y de carrera** de los ocho workspaces. El
   comando levanta un PostgreSQL 18 y un Redis desechables
   ([`docker-compose.test.yml`](../docker-compose.test.yml), puertos 55432 y 56379,
   datos en memoria), compila todo, corre cada suite y borra los contenedores. Cada
   suite crea sus propias bases a partir de los `init.sql` reales, así que nunca toca
   la pila de demo. Cerca de un minuto.
2. **De punta a punta** ([`deploy/scripts/test-all-endpoints.mjs`](../deploy/scripts/test-all-endpoints.mjs)):
   25 pasos a través del gateway de la pila que levanta `docker compose up`, con tokens
   reales de Keycloak, Redis real y el relay de auditoría. El comando corre antes
   `docker compose up -d --build`, para que la pila ejecute el código de esta copia y no
   una imagen vieja (solo recompila lo que cambió; los datos se quedan), y espera a que
   Keycloak tenga los usuarios de demo.

Al final imprime una línea por suite y termina con 0 solo si todo pasó. Los reportes
de vitest quedan en `test-results/` (ignorado por git).

| Opción | Qué hace |
| --- | --- |
| `npm run test:all -- --no-e2e` | Solo la etapa 1 |
| `npm run test:e2e` | Solo la etapa 2 |
| `npm run test:all -- --keep` | Deja corriendo los contenedores de prueba |
| `npm run test:all -- --external` | Usa `TEST_DATABASE_URL` y `TEST_REDIS_URL` ya definidas en vez de levantar contenedores (CI) |

La etapa 2 deja rastro en los datos de demo, como cualquier usuario de la API: una
clínica nueva, un servicio, un profesional, un paciente, algunas citas y el desenlace de
una reserva ya empezada de dr.mora. `docker compose down -v` vuelve a cargar la semilla.

**En CI** ([ci-cd.es.md](ci-cd.es.md)), el job `integration-tests` corre la etapa 1 con
el mismo comando contra contenedores de servicio de PostgreSQL 18 y Redis, y el job
`e2e-compose` corre la etapa 2 como lo haría el evaluador: un clon nuevo,
`cp .env.example .env` y el comando documentado.

## Última corrida

Etapa 1, 2026-11-15, en la rama que agrega este informe:

| Suite | Pasan | Fallan | Saltadas |
| --- | ---: | ---: | ---: |
| `packages/auth` | 162 | 0 | 0 |
| `packages/db` | 62 | 0 | 0 |
| `packages/http` | 9 | 0 | 0 |
| `services/edge-gateway` | 40 | 0 | 0 |
| `services/clinics-service` | 7 | 0 | 0 |
| `services/users-service` | 15 | 0 | 2 |
| `services/appointments-service` | 186 | 0 | 0 |
| `services/audit-service` | 28 | 0 | 0 |
| **Total** | **509** | **0** | **2** |

Las dos pruebas saltadas de users-service crean usuarios en un realm desechable de
Keycloak (`J2_TEMP_REALM=1`) que solo existe en la máquina de quien las corre. Lo que
comprueban (RF1 y RF2 contra un Keycloak real) también lo comprueba la etapa de punta a
punta, contra el realm de la pila.

La etapa 2 corre en cada push en el job `e2e-compose`; su resultado está en la pestaña
GitHub Actions de cada commit.

## Qué demuestra cada tipo de prueba

| Tipo | Dónde | Qué es real | Qué se reemplaza |
| --- | --- | --- | --- |
| **Unitaria** | `*/tests/unit`, `packages/auth/tests` | La lógica: cálculo de espacios y zonas horarias, matriz de permisos, contexto de inquilino desde el token, mapeo de errores, reintentos | La base de datos (stubs) |
| **Integración** | `*/tests/integration` | La app HTTP del servicio, el esquema real (restricciones, triggers, RLS, roles) en PostgreSQL 18, Redis | La mayoría de las suites inyecta la identidad que traería el token; varias arrancan el servidor normal y firman JWT reales con una llave de prueba, y `packages/auth` prueba la validación de la firma |
| **Carrera** | `appointments-service/tests/race` | Peticiones HTTP concurrentes contra una misma base | Nada |
| **Punta a punta** | `deploy/scripts/test-all-endpoints.mjs` | Toda la pila de `docker compose up`: gateway, cinco servicios, cuatro bases, Keycloak, Redis, los relays | Nada |

## Requisitos funcionales

Las rutas son relativas a la carpeta `tests/` de cada servicio. "E2E" es un paso de la
etapa de punta a punta.

| RF | Qué se comprueba | Dónde |
| --- | --- | --- |
| **RF1** Alta de clínica con su primer administrador | Primer administrador obligatorio, zona horaria válida, campos que controla el dueño; la clínica, su admin en `users_db` y la cuenta de Keycloak se crean juntos | clinics `unit/clinic-registration.test.ts`; E2E "POST /clinics" |
| **RF2** Gestión de usuarios: alta, baja lógica, rol | Escrituras entre clínicas y actores de plataforma rechazados antes de tocar Keycloak; una asignación de rol fallida revierte el SQL y borra la cuenta; la entrada pública no fija clínica ni identidad | users `integration/user-management.test.ts`, `unit/user-management.test.ts`; E2E "POST /users", "PUT role & DELETE" |
| **RF3** Catálogo de servicios | CRUD de nombre, duración, especialidad y estado; ids de otras clínicas invisibles; RLS lo hace cumplir por su cuenta | clinics `integration/service-catalog.test.ts`; E2E "RF3 lifecycle" |
| **RF4** Profesionales, especialidades y servicios | Registro atómico; especialidades incompatibles e ids ajenos rechazados; un servicio asociado da espacios y reservas reales | users `integration/professionals.test.ts`; pasos "RF4" del E2E |
| **RF5** Horario semanal | Turnos partidos, reemplazo, traslape rechazado por el motor (409), un profesional solo su propio horario | appointments `integration/schedule.test.ts` |
| **RF6** Bloqueos de agenda | Un bloqueo lista las citas reservadas que traslapa; listado por rango; permisos | appointments `integration/schedule.test.ts`, `race/block-vs-booking.test.ts` |
| **RF7** Espacios libres de un profesional en una fecha | Turno partido en hora local menos reservas y bloqueos; días pasados; horario de verano; 404/422 | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF8** Disponibilidad por servicio en un rango | Profesionales con espacio y solo los días con espacios; límites del rango | appointments `unit/availability.test.ts`, `integration/availability.test.ts` |
| **RF9** Reservar | 201, 409 `slot_taken`, 409 `patient_overlap`, 422 en cada caso inválido (fuera de horario, bloqueo, servicio no ofrecido, en el pasado, duración en el cuerpo), 403, 404 | appointments `integration/booking.test.ts`; E2E "POST /appointments" |
| **RF10** Reprogramar | La vieja queda `rescheduled`, la nueva apunta a ella, en la misma transacción; un fallo revierte todo; dos recepcionistas a la vez: un 201 y un 409 | appointments `integration/lifecycle.test.ts`; E2E "reschedule" |
| **RF11** Cancelar | Se guardan el motivo y quién canceló; el espacio queda libre de inmediato | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **RF12** Desenlace | Solo después del inicio, solo el profesional de la cita; luego es final | appointments `integration/lifecycle.test.ts`; E2E "outcome" |
| **RF13** Solo transiciones válidas | Las transiciones prohibidas responden 409: salir de un estado final, reprogramar dos veces, cancelar o reprogramar una cita ya empezada; el trigger las rechaza aunque no pase por el servicio | appointments `integration/lifecycle.test.ts` |
| **RF14** Pacientes | Registro y cambio de contacto atómicos con su evento de auditoría; duplicados y entrada inválida; por clínica | users `integration/patients.test.ts`; E2E "patients" |
| **RF15** Nota clínica | Solo el profesional que atendió la escribe y la lee; una por cita, también en carrera; recepción y admin reciben 403 | appointments `integration/clinical-note.test.ts`; E2E "note" |
| **RF16** Historial del paciente | Todos los estados, orden estable, separado por paciente y por clínica | appointments `integration/patient-history*.test.ts`, `unit/patient-history.test.ts` |
| **RF17** Autenticación y autorización | Firma, emisor, audiencia y vencimiento validados con las llaves del proveedor; 401 sin token válido, 403 para un rol fuera de la matriz; nunca se confía en roles que vengan en la petición | auth `jwt.test.ts`, `authorization.test.ts`, `permissions.test.ts`, `tenant-context.test.ts`; appointments `unit/app-wiring.test.ts`; E2E "401" |
| **RF18** Auditar toda lectura y escritura de notas y contacto | Un evento por acceso, ninguno por un intento rechazado; no hay nota sin su evento; el relay entrega cada evento una vez | appointments `integration/clinical-note.test.ts`; users `integration/patients.test.ts`; audit `integration/audit-relay.test.ts`; E2E "RF18" |
| **RF19** Consulta de la bitácora del admin de clínica | Filtros por usuario, paciente y fechas; solo clinic_admin; solo su clínica | audit `integration/audit-query*.test.ts`, `integration/audit-runtime.test.ts` |
| **RF20** Agenda del día | Vista de clínica y de profesional, límites de medianoche local (también en días con cambio de horario), sin datos clínicos ni de contacto | appointments `integration/daily-agenda.test.ts` |
| **RF21** Conteo por estado | Límites inclusivo y exclusivo, desfases equivalentes, ceros, solo su clínica | appointments `integration/appointment-counts*.test.ts`, `unit/appointment-counts.test.ts` |

## Invariantes

| Invariante | Qué se comprueba | Dónde |
| --- | --- | --- |
| **I1** Un profesional sin reservas traslapadas | 2 recepcionistas por el mismo espacio, 100 veces: siempre un 201 y un 409; 50 a la vez: un 201 y 49 409; al final ningún profesional tiene dos reservas traslapadas. También el 409 `slot_taken` simple | appointments `race/test.ts`, `integration/booking.test.ts`; db `integration/tenant-tx.test.ts` |
| **I2** Un paciente sin reservas traslapadas en una clínica | El mismo paciente con dos profesionales a la vez: un 201 y un 409 `patient_overlap`, también en concurrencia | appointments `race/test.ts`, `integration/booking.test.ts` |
| **I3** Dentro del horario y fuera de los bloqueos | 422 fuera de horario o dentro de un bloqueo; una reserva y un bloqueo enviados juntos 60 veces: el bloqueo siempre reporta la reserva que le ganó | appointments `integration/booking.test.ts`, `race/block-vs-booking.test.ts` |
| **I4** La duración la fija el servicio | El cuerpo no puede mandar el fin ni la duración (422); el fin siempre es el inicio más los minutos del servicio; `CHECK` en el esquema | appointments `integration/booking.test.ts` |
| **I5** Ningún dato de una clínica alcanzable desde otra | Cada suite repite sus llamadas desde una segunda clínica (404 o vacío), incluidos ids, parámetros de consulta y encabezados manipulados; RLS probado sin el `WHERE` del código; las conexiones del pool no conservan contexto. Los mismos intentos de fuga contra RLS y contra la columna sola ([rls-comparison.es.md](rls-comparison.es.md)) | db `integration/tenant-tx.test.ts`; appointments `integration/rls-vs-column.test.ts`, `integration/*` (booking, schedule, availability, lifecycle, clinical-note, daily-agenda, patient-history, counts); users `integration/patients.test.ts`, `user-management.test.ts`; clinics `integration/service-catalog.test.ts`; audit `integration/audit-query.test.ts`, `audit-append-only.test.ts`; auth `authorization.test.ts` |
| **I6** La bitácora no se modifica desde la aplicación | El rol de la aplicación no puede hacer `UPDATE`, `DELETE` ni `TRUNCATE` (no tiene el privilegio), y los triggers rechazan los tres incluso al dueño de la tabla | audit `integration/audit-append-only.test.ts`, `integration/audit-relay.test.ts` |
| **I7** Cancelar o reprogramar libera el espacio de inmediato | El espacio aparece libre en la siguiente consulta, también con caché | appointments `integration/lifecycle.test.ts`, `integration/availability-cache.test.ts` |
| **I8** La disponibilidad nunca contradice la base | Reservar un espacio listado y volver a consultar: ya no aparece, sin esperar ningún vencimiento; lectores y escritores intercalados; invalidaciones perdidas recuperadas desde el outbox; con Redis caído se lee de PostgreSQL | appointments `integration/availability-cache.test.ts`, `integration/agenda-relay.test.ts`, `unit/agenda-cache.test.ts`; E2E "Redis cache invalidation" |

**Roles de base con menor privilegio** (módulo 5 del núcleo): cada petición corre con el rol
de base de su actor. appointments `integration/db-roles.test.ts` comprueba la matriz de
permisos de cada rol y que una reserva falle cuando el rol de su actor pierde `INSERT`
mientras la del administrador sigue funcionando; db `integration/tenant-tx.test.ts`
comprueba que recepción y administración no pueden leer notas clínicas en el motor.

## Criterios de aceptación del enunciado

| # | Criterio | Cómo se muestra |
| --- | --- | --- |
| 1 | Levanta solo | `docker compose up` (README); el job `e2e-compose` lo hace desde un clon nuevo |
| 2 | El ciclo de la cita se cumple | RF9-RF13 arriba; el E2E reserva, reprograma, cancela y registra un desenlace |
| 3 | La identidad se exige y se respeta | RF17 arriba; el E2E comprueba 401 sin token y 403 con el rol equivocado |
| 4 | El aislamiento se sostiene | I5 arriba |
| 5 | La caché no miente | I8 arriba |
| 6 | La carrera tiene una sola ganadora | I1 arriba (`race/test.ts`, reproducible: 100 iteraciones en cada corrida) |
| 7 | Las pruebas corren | `npm run test:all` |
