# Datos semilla de demo

[English](seed-data.md) · **Español**

`docker compose up` deja el sistema poblado: tres clínicas en operación (y una
suspendida), varios profesionales por clínica, sus usuarios de Keycloak y cerca de mil
citas repartidas entre agosto de 2026 y febrero de 2027, en todos los estados. Todos
los nombres, ids y correos son inventados.

## Cómo se carga

| Qué | Archivo | Lo carga |
| --- | --- | --- |
| Clínicas, especialidades, servicios | [`database/clinics/seed.sql`](../database/clinics/seed.sql) | `db_clinics` con el volumen vacío |
| Usuarios, profesionales, pacientes | [`database/users/seed.sql`](../database/users/seed.sql) | `db_users` con el volumen vacío |
| Horarios, bloqueos, citas, notas | [`database/appointments/seed.sql`](../database/appointments/seed.sql) | `db_appointments` con el volumen vacío |
| Bitácora | [`database/logs/seed.sql`](../database/logs/seed.sql) | `db_logs` con el volumen vacío |
| Usuarios de Keycloak | [`keycloak/seed-users.json`](../keycloak/seed-users.json) | el job `keycloak-seed` |

PostgreSQL ejecuta los SQL solo cuando el volumen está vacío. Los volúmenes
existentes conservan sus datos; reiniciar Compose no vuelve a cargar la semilla.
Use un entorno descartable separado con volúmenes nuevos para probar otra versión.
No elimine volúmenes compartidos. El README raíz indica la configuración previa al arranque.

## De dónde sale

Los cinco archivos se generan; no se editan a mano. Los datos viven en
[`database/seed/data.mjs`](../database/seed/data.mjs) y
[`database/seed/generate.mjs`](../database/seed/generate.mjs) los escribe:

```bash
npm run seed:generate   # reescribe los cinco archivos
npm run seed:check      # falla si están desactualizados (corre en CI)
```

- Una sola fuente para todas las bases. Un id aparece en hasta cuatro bases y en
  Keycloak (un profesional está en `users_db`, en `appointments_db` y en el token).
  Escribirlos desde una sola lista los mantiene alineados.
- Citas curadas y generadas. Unas quince citas tienen ids fijos porque los docs,
  la colección de Postman y la demo las usan. El resto se genera a partir de los
  horarios con una semilla aleatoria fija, así que la salida es la misma en cada
  corrida y en cada máquina.
- Se valida antes de escribir. El generador rechaza una semilla que rompa el
  esquema o una regla de los servicios: reservas traslapadas de un profesional o de un
  paciente (I1, I2), una cita fuera del horario o dentro de un bloqueo (I3), una
  duración distinta a la del servicio (I4), un servicio o un paciente de otra clínica,
  un adulto en un servicio pediátrico, una nota de una cita no atendida, una cita
  reprogramada sin su reemplazo o una fecha posterior a la fecha de la semilla.
- CI la carga. El job de integración carga los cuatro esquemas y la semilla en
  PostgreSQL 18, igual que Compose, así que una semilla que rompe una restricción
  rompe el build.
- Filas compactas. Las filas generadas escriben cada id como un número;
  `pg_temp.seed_id(n)` lo convierte en el mismo UUID que `id(n)` construye en `data.mjs`.

Los datos están escritos como se ven el **2026-11-14** (`SEED_NOW`): las citas
anteriores ya tienen resultado y las posteriores están casi todas reservadas.

## Clínicas

| Clínica | Identificador | Estado | Profesionales |
| --- | --- | --- | --- |
| Central San Jose Clinic | `clinic-sj-01` | activa | Mora, Solis, Arias (y Campos, inactivo) |
| East Curridabat Clinic | `clinic-curri-02` | activa | Vega, Quesada |
| North Heredia Clinic | `clinic-her-03` | activa | Chaves, Alfaro |
| Liberia Clinic | `clinic-lib-04` | suspendida | ninguno: registrada, todavía sin usuarios |

Todas están en `America/Costa_Rica` (UTC-6, sin horario de verano).

## Usuarios

Todos entran con la contraseña de `KEYCLOAK_TEST_PASSWORD` por el cliente
`integration-tests`.

| Usuario | Rol | Clínica | Notas |
| --- | --- | --- | --- |
| `platform.admin` | platform_admin | ninguna | Da de alta clínicas; sin datos clínicos |
| `admin.sj` | clinic_admin | San José | Primer administrador de la clínica |
| `reception.sj` | receptionist | San José | |
| `reception2.sj` | receptionist | San José | Una segunda recepcionista para la demo del "último espacio" |
| `dr.mora` | professional | San José | Medicina general, cardiología |
| `dr.solis` | professional | San José | Pediatría; ofrecía la visita a domicilio retirada |
| `dr.arias` | professional | San José | Medicina general, controles |
| `dr.campos` | professional | San José | **Inactivo**: se fue en septiembre, cuenta de Keycloak deshabilitada |
| `admin.curri` | clinic_admin | Curridabat | Primer administrador de la clínica |
| `reception.curri` | receptionist | Curridabat | |
| `dr.vega` | professional | Curridabat | Medicina general, dermatología |
| `dr.quesada` | professional | Curridabat | Pediatría, medicina general |
| `admin.heredia` | clinic_admin | Heredia | Primera administradora de la clínica |
| `reception.heredia` | receptionist | Heredia | |
| `dr.chaves` | professional | Heredia | Medicina general, cardiología |
| `dr.alfaro` | professional | Heredia | Nutrición, medicina general; también trabaja sábados |

## Servicios y agendas

| Profesional | Servicios (minutos) | Horario (hora local) |
| --- | --- | --- |
| Dr. Laura Mora | General Consultation (30), Cardiology Evaluation (45) | lun-vie 08-12, lun-jue 13-17 |
| Dr. Carlos Solis | Pediatric Checkup (30), Home Visit (60, **inactivo** desde octubre) | lun-vie 09-13 |
| Dr. Pablo Arias | General Consultation (30), Follow-up Visit (20) | lun, mié, vie 07-11; mar, jue 13-19 |
| Dr. Elena Vega | General Consultation (30), Dermatology Screening (30) | lun-jue 08-16 |
| Dr. Mariana Quesada | Pediatric Checkup (30), General Consultation (30) | lun-vie 13-18 |
| Dr. Ricardo Chaves | General Consultation (30), Cardiology Evaluation (45) | lun-vie 08-12, lun y mié 14-18 |
| Dr. Paula Alfaro | Nutrition Counseling (40), General Consultation (30) | mar-sáb 09-15 |

Bloqueos de agenda: Mora la tarde del 24 de diciembre, Vega de vacaciones del 21 de
diciembre al 3 de enero, Chaves en un congreso el 26 de noviembre, Solis con
incapacidad en septiembre, Alfaro en un curso la mañana del 15 de enero. Nadie tiene
citas en los feriados de Costa Rica.

## Citas

| Clínica | Total | booked | attended | no_show | cancelled | rescheduled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| San José | 430 | 81 | 244 | 43 | 39 | 23 |
| Curridabat | 289 | 68 | 154 | 26 | 25 | 16 |
| Heredia | 316 | 67 | 174 | 23 | 33 | 19 |
| **Todas** | **1035** | **216** | **572** | **92** | **97** | **58** |

- Las agendas se llenan conforme se acerca la fecha: el pasado está lleno en cerca
  de una cuarta parte, diciembre menos y enero menos todavía. Febrero de 2027 solo
  tiene citas curadas, lo que deja espacio para la demo; consulte disponibilidad antes de reservar.
- Toda cita pasada tiene resultado, salvo unas pocas de los últimos diez días que
  siguen `booked`, como la 804: todavía no se registró su resultado.
- Toda cita `rescheduled` tiene su reemplazo (`rescheduled_from_id`), con el mismo
  paciente y profesional, de 1 a 14 días después.
- Las reservas las hace recepción (a veces el administrador de la clínica) de 1 a 21
  días antes, en horario de oficina; el profesional registra el resultado justo
  después de la consulta.
- **490 notas clínicas**: la mayoría de las consultas atendidas tiene una, y algunas
  se editaron después.
- **1138 registros de bitácora** (RF18): cada nota creada o editada; el profesional
  leyendo la nota anterior al empezar la siguiente consulta; recepción leyendo o
  corrigiendo el contacto del paciente al reservar.

### Citas curadas

Todas en `America/Costa_Rica`. Los ids son `019a0000-0000-7000-8000-000000000NNN`.

| Id | Clínica | Qué es |
| --- | --- | --- |
| 801 | San José | Atendida por la Dra. Mora, con la nota 901 |
| 802 → 803 | San José | Reprogramada; su reemplazo está reservado el 2027-02-01 |
| 804 | San José | Reservada y ya empezada: lista para registrar su resultado |
| 805 | San José | Cancelada por recepción, con motivo |
| 806 | Curridabat | Reservada el 2027-02-02: un usuario de la clínica 1 no debe verla |
| 807 | San José | El paciente no se presentó |
| 808 | Curridabat | Atendida por la Dra. Vega, con la nota 902 |
| 809 | Heredia | Reservada el 2027-02-03 |
| 810 | Heredia | Atendida por la Dra. Alfaro; la nota 903 se editó al día siguiente |
| 811 | Heredia | Cita futura cancelada por la administradora de la clínica |
| 812 → 813 | Curridabat | Cita pediátrica movida una semana después |
| 814 | San José | Visita a domicilio antes de retirar el servicio, con la nota 904 |
| 815 | San José | Atendida por el Dr. Campos antes de irse, con la nota 905 |

## Pacientes

69 pacientes. Los siete con id fijo (601-607) son los que usan los docs y Postman;
solo aparecen en el historial pasado, nunca en una reserva futura, así que la semilla inicial deja espacio
para reservas de demo. Las ejecuciones anteriores pueden ocupar esos espacios. Los otros 62 son generados: cerca de uno de cada
cuatro es menor de edad, y solo los menores se reservan en servicios pediátricos.
Algunos no tienen teléfono o correo, lo que ambas columnas permiten.

## Rangos de ids

| Rango (último grupo) | Qué |
| --- | --- |
| `101`-`104` | clínicas |
| `201`-`205`, `301`-`311` | especialidades, servicios |
| `401`-`416`, `1001`-`1016` | `app_user_id` y `sub` de Keycloak del mismo usuario |
| `501`-`508` | profesionales |
| `601`-`607`, `610001`... | pacientes con nombre fijo y generados |
| `701`..., `751`-`755` | horarios, bloqueos |
| `801`-`815`, `901`-`905` | citas y notas curadas |
| `2000001`..., `3000001`..., `4000001`... | citas, notas y registros de bitácora generados |

## Límites

- **Las fechas no se mueven.** Los datos se ven desde el 2026-11-14. Pasada esa
  fecha, las citas de noviembre y diciembre siguen `booked` hasta que alguien
  registre su resultado, como en una clínica real. Para mover toda la semilla, cambie
  `SEED_NOW` y las fechas del historial en `data.mjs` y regenere.
- **Volumen para la demo, no para mediciones.** Mil citas hacen que las agendas se
  vean reales. Las mediciones de índices generan su propio conjunto de datos, mucho
  más grande ([indexes.es.md](indexes.es.md)).
