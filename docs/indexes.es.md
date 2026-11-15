# Índices justificados con su plan

[English](indexes.md) · **Español**

El enunciado pide que *"los índices creados se justifican con el plan de ejecución de la
consulta que pretenden servir, empezando por RF7"* (núcleo 8). Este documento lista cada
índice de `appointments_db` y `logs_db`, la consulta que sirve y su plan antes y después de
la tarjeta E10. La salida completa de `EXPLAIN (ANALYZE, BUFFERS)` está en
[indexes-plans.md](indexes-plans.md).

## Cómo se midió

```bash
TEST_DATABASE_URL='postgres://<usuario>:<contraseña>@localhost:5433/postgres' \
npm run explain:indexes -w services/appointments-service
```

[`scripts/explain-indexes.ts`](../services/appointments-service/scripts/explain-indexes.ts)
crea dos bases desechables con los `init.sql` reales y carga:

- **328 230 citas**: 3 clínicas, 15 profesionales cada una, dos años de días hábiles con 14
  espacios por día. Las pasadas tienen su desenlace y las futuras están casi todas `booked`.
- **2 205 bloqueos**, los horarios semanales, los servicios que ofrece cada profesional y una
  nota clínica para un tercio de las citas atendidas.
- **1 200 000 eventos de auditoría** (400 000 por clínica, 20 000 pacientes, 50 usuarios).

Después corre cada consulta **como `medicitas_app` y con el contexto de la clínica cargado**,
así que las políticas RLS forman parte del plan, igual que en producción. Cada consulta corre
dos veces: con los índices y el texto de consulta de antes de la E10, y con los actuales. Los
tiempos son medianas de 5 corridas registradas previamente en un contenedor de
2 vCPU con PostgreSQL 16. Compose usa 18; no se repitieron aquí, así que no se
verificó que los planes ni tiempos coincidan en 18. Los buffers son páginas de
8 KB de memoria o disco. Use un login administrativo en una instancia PostgreSQL
18 descartable: el script crea y borra bases. El comando usa sintaxis Bash.

## Resultados

| Consulta | Antes | Después | Índice usado después |
| --- | --- | --- | --- |
| **RF7** citas `booked` de un profesional en un día | 3.11 ms · 3 207 buffers | **0.06 ms · 31** | `idx_appointment_professional_starts_at` |
| **RF8** citas `booked` de tres profesionales en una semana | 4.19 ms · 4 000 | **0.29 ms · 263** | `idx_appointment_professional_starts_at` |
| RF7 bloqueos de un profesional en un día | 0.06 ms · 31 | 0.04 ms · 21 | `idx_schedule_block_professional_starts_at` |
| RF7 horario semanal de un profesional | 0.03 ms · 3 | 0.03 ms · 3 | `no_overlap_working_hours` (restricción) |
| RF7/RF9 ¿el profesional ofrece el servicio? | 0.01 ms · 2 | 0.01 ms · 2 | `professional_service_pkey` |
| RF8 profesionales que ofrecen un servicio | 0.02 ms · 2 | 0.01 ms · 2 | `professional_service_pkey` |
| **RF20** agenda de toda la clínica en un día | 22.98 ms · 7 722 | **0.41 ms · 40** | `idx_appointment_clinic_starts_at` |
| **RF20** agenda de un profesional en un día | 8.98 ms · 7 392 | **0.05 ms · 31** | `idx_appointment_professional_starts_at` |
| RF16 historial de citas de un paciente | 0.10 ms · 31 | 0.07 ms · 32 | `idx_appointment_patient_starts_at` |
| **RF21** citas por estado en un mes | 25.59 ms · 7 722 | **5.62 ms · 34** | `idx_appointment_clinic_starts_at` (solo índice) |
| RF15 nota clínica de una cita | 0.02 ms · 3 | 0.03 ms · 4 | `UNIQUE (clinic_id, appointment_id)` |
| RF19 bitácora de un paciente | 0.09 ms · 23 | 0.06 ms · 23 | `idx_audit_log_clinic_patient` |
| RF19 bitácora de un usuario en una semana | 1.25 ms · 101 | 0.16 ms · 69 | `idx_audit_log_clinic_user` |
| RF19 bitácora completa de la clínica en un día | 1.41 ms · 38 | 0.75 ms · 15 | `idx_audit_log_clinic_occurred_at` |

RF7, RF8, RF20 y RF21 pasan de leer miles de páginas (en la práctica, todas las citas del
profesional o de la clínica) a leer unas pocas decenas. Las demás consultas ya eran baratas;
en ellas el cambio quita índices sin perder nada.

## Lo que mostraron los planes

**1. Los planes RLS registrados no usaron el solape de rangos como condición de índice.** El índice obvio para
"las citas que se cruzan con un día" es un GiST sobre `tstzrange(starts_at, ends_at)`, y las
restricciones `EXCLUDE` ya tienen uno. Pero los planes lo usaban solo para `clinic_id` y
`professional_id`, y filtraban el rango fila por fila. La razón: con RLS activo, PostgreSQL
solo deja correr antes de la política los operadores **leakproof**, y eso incluye las
condiciones de índice. `=`, `<` y `>` sobre uuids y timestamps son leakproof; `&&` sobre rangos
no lo es (`pg_proc.proleakproof = false`). Reescribir la consulta con `&&` la volvió más lenta.
Por eso los índices nuevos son btrees sobre columnas simples, comparadas con `<` y `>`.

**2. Un btree necesita los dos extremos del intervalo.** "Se cruza con `[from, to)`" es
`starts_at < to AND ends_at > from`, y un índice sobre `starts_at` solo puede usar la primera
mitad: recorre desde el principio de los tiempos hasta `to`. La solución sale del dominio: una
cita debe caber en un bloque de horario (I3), y los horarios nunca cruzan la medianoche, así
que **ninguna cita dura más de 1440 minutos**. Los días locales pueden variar
con el horario de verano; la optimización depende del límite explícito de duración. El esquema lo dice
(`CHECK appointment_within_one_day (duration_minutes <= 1440)`), y las consultas agregan la
condición redundante `starts_at > from - 1 día`
([`domain/appointment-bounds.ts`](../services/appointments-service/domain/appointment-bounds.ts)).
Con los dos límites, RF7 lee 31 páginas en lugar de 3 207.

**3. El orden de las columnas sigue a la consulta.** Toda consulta filtra por clínica (RLS
agrega `clinic_id = app_current_clinic_id()` aunque el código no lo haga), luego por una
igualdad (profesional, paciente, usuario) y luego por un rango o un orden (`starts_at`,
`occurred_at`). Los índices tienen exactamente ese orden. Primero las igualdades y el rango al
final: después de la columna del rango, las columnas siguientes ya no achican el recorrido.

**4. Las llaves por tenant de estas dos bases empiezan con `clinic_id`.**
Un índice separado en esa columna duplica el prefijo de la llave. E10 quitó esos
duplicados de las tablas listadas abajo; clinics/users conservan algunos.

**5. `status` solo no es selectivo.** `idx_appointment_status` tenía cinco valores posibles para
cientos de miles de filas, y ninguna consulta filtra solo por estado. RF7 filtra por estado
después de que el índice ya redujo todo a unas pocas filas.

## Índice por índice

**Creados**

| Índice | Sirve a | Por qué esas columnas |
| --- | --- | --- |
| `appointment (clinic_id, professional_id, starts_at)` | RF7, RF8, RF20 de un profesional | Clínica y profesional son igualdades; `starts_at` entre los dos límites. No es parcial: RF20 también necesita las citas canceladas y atendidas. |
| `appointment (clinic_id, starts_at) INCLUDE (status)` | RF20 de la clínica, RF21 | El mismo rango por clínica. `INCLUDE (status)` permite que RF21 cuente solo con el índice (*Index Only Scan*), sin visitar la tabla. |
| `appointment (clinic_id, patient_id, starts_at)` | RF16 | El historial sale del índice ya ordenado por fecha; solo se ordena el desempate por id. |
| `schedule_block (clinic_id, professional_id, starts_at)` | RF7, RF8 | Un índice en lugar de dos (`clinic_id` y `professional_id` combinados con un *BitmapAnd*). Los bloqueos pueden durar días, así que aquí solo aplica el límite superior; un profesional tiene pocos bloqueos. |
| `audit_log (clinic_id, occurred_at)` | RF19 por rango de fechas | Ya en el orden de la respuesta. |
| `audit_log (clinic_id, patient_id, occurred_at)` | RF19 por paciente | Igualdad y luego orden. |
| `audit_log (clinic_id, app_user_id, occurred_at)` | RF19 por usuario (y rango) | Igualdad y luego rango y orden. |

**Conservados, con la consulta a la que sirven**

| Índice | Sirve a |
| --- | --- |
| Llaves primarias `(clinic_id, id)` | Toda lectura por id (cita, nota, bloqueo) y RLS por clínica |
| `no_overlap_professional`, `no_overlap_patient` (GiST, `EXCLUDE`) | I1 e I2 en cada reserva ([concurrency.es.md](concurrency.es.md)) |
| `no_overlap_working_hours` (GiST, `EXCLUDE`) | Turnos solapados, y la lectura de la semana de un profesional en RF7 |
| `professional_service_pkey (clinic_id, professional_id, service_id)` | "¿Este profesional lo ofrece?" y "¿quién lo ofrece?" de RF8 |
| `UNIQUE (clinic_id, appointment_id)` en `clinical_note` | Una nota por cita, y la búsqueda de RF15 |
| `idx_outbox_pending (created_at) WHERE published_at IS NULL` | Relays de agenda y auditoría leyendo eventos pendientes en orden; parcial, así que solo guarda lo pendiente |

**Quitados**

| Índice | Por qué |
| --- | --- |
| `idx_*_clinic_id` en `appointment`, `working_hours`, `schedule_block`, `professional_service`, `clinical_note`, `audit_log` | Duplicaban la primera columna de la llave primaria |
| `idx_appointment_professional_id`, `idx_appointment_patient_id` | Reemplazados por los índices compuestos de arriba |
| `idx_appointment_status` | No es selectivo; ninguna consulta lo usa solo |
| `idx_working_hours_professional_id` | Ya lo cubre el índice del `EXCLUDE` |
| `idx_schedule_block_professional_id` | Reemplazado por el índice compuesto |
| `idx_prof_service_professional_id` | La llave primaria ya empieza con esa columna |
| `idx_clinical_note_appointment_id`, `idx_clinical_note_professional_id` | El `UNIQUE` sirve la búsqueda; ninguna consulta filtra notas por profesional (lo hace RLS, después de la búsqueda) |
| `idx_audit_log_app_user_id`, `idx_audit_log_patient_id`, `idx_audit_log_occurred_at` | Reemplazados por compuestos con `clinic_id` primero |

**Todavía sin consulta en la Etapa 1** (se conservan; sus dueños deberían justificarlos o
quitarlos): `idx_appointment_clinic_updated_at`, `idx_appointment_clinic_status_changed_at`
(se agregaron con las marcas del ciclo de vida; ninguna consulta actual los justifica) e `idx_idempotency_keys_expires_at` (para un trabajo de limpieza
que todavía no existe). Antes de la E10, el planificador incluso usaba
`idx_appointment_clinic_status_changed_at` para RF20 y RF21, solo porque empieza con
`clinic_id`: ese era el recorrido de 7 722 páginas.

## Costos

- **Espacio.** Los índices de `appointment` pasaron de 10 (76 MB) a 9 (121 MB): menos índices,
  pero más anchos, porque cada uno lleva `clinic_id` y el `INCLUDE`. 45 MB más a cambio de unas
  50 veces menos trabajo en las consultas más frecuentes.
- **Escrituras.** Cada índice se actualiza en cada inserción. Hay un índice menos en
  `appointment`, `schedule_block` y `audit_log` (que recibe una fila por cada lectura de una
  nota), dos menos en `working_hours` y `professional_service`, y tres menos en
  `clinical_note`.
- **El límite depende de una regla.** Si algún servicio necesitara citas de más de un día,
  habría que cambiar el `CHECK` y, con él, el límite de las consultas. Ambos apuntan a
  `domain/appointment-bounds.ts`.

## Aplicarlo a una base existente

Las bases nuevas reciben estos índices de `init.sql`. Para un volumen anterior a
E10, revise los scripts y respalde los datos antes de ejecutarlos como dueño del
esquema (ambos se pueden repetir). No se ejecutaron en esta revisión documental:

```bash
psql "$APPOINTMENTS_DB_URL" -f database/updates/appointments/upgrade-e10-indexes.sql
psql "$LOGS_DB_URL" -f database/updates/logs/upgrade-e10-indexes.sql
```
