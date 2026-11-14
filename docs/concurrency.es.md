# Concurrencia: el último espacio (tarjeta E11)

[English](concurrency.md) · **Español**

> Dos recepcionistas reservan el último espacio de la agenda exactamente al mismo tiempo.
> ¿Qué hace el sistema, por qué, y cómo se demuestra?

## La respuesta

Una reserva se concede con **201** y la otra se rechaza con **409 `slot_taken`**.
La base nunca tiene dos citas `booked` solapadas para ese profesional (I1).
Esto no depende del momento exacto, de cuántas réplicas del servicio haya ni de la
caché: PostgreSQL lo decide en el `INSERT`, mediante una restricción de exclusión.

## Qué pasa, paso a paso

```text
Recepcionista A (T1)                          Recepcionista B (T2)
--------------------                          --------------------
BEGIN (READ COMMITTED)                        BEGIN (READ COMMITTED)
advisory lock compartido del profesional      advisory lock compartido (no espera a T1)
validaciones: ofrece el servicio, dentro      mismas validaciones: también pasan,
del horario, sin bloqueos                     porque T1 todavía no confirmó nada
INSERT cita 09:00-09:30                       INSERT cita 09:00-09:30
  -> ocupa el espacio en el índice GiST         -> encuentra la tupla de T1 en el índice:
                                                   espera a que T1 termine
COMMIT -> 201                                 T1 confirmó -> conflicto -> 23P01
                                              ROLLBACK -> 409 slot_taken
```

Las dos transacciones pasan todas las validaciones, porque cada una solo ve datos
confirmados. Lo que protege el espacio no son las validaciones, sino la restricción de
[`database/appointments/init.sql`](../database/appointments/init.sql):

```sql
CONSTRAINT no_overlap_professional EXCLUDE USING gist (
    clinic_id                           WITH =,
    professional_id                     WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
) WHERE (status = 'booked')
```

- **`EXCLUDE ... WITH &&`** prohíbe dos filas cuyos intervalos se solapen. El motor lo
  verifica también contra filas que otras transacciones insertaron pero todavía no
  confirmaron, y hace que la segunda espere a la primera. Si la primera confirma, la
  segunda falla con `23P01`; si la primera hace rollback, la segunda pasa.
- **`'[)'`** incluye el inicio y excluye el fin, así que 09:00-09:30 y 09:30-10:00 no se
  solapan: se permiten citas pegadas.
- **`WHERE (status = 'booked')`** solo cuenta las citas vigentes. Cancelar o reprogramar
  libera el tiempo en el mismo `COMMIT` (I7).
- `@medicitas/db` traduce el `23P01` de esta restricción a **409 `slot_taken`**, y el de
  `no_overlap_patient` a **409 `patient_overlap`** (I2). El cliente nunca ve SQLSTATE.

## Nivel de aislamiento: READ COMMITTED

`withTenantTx` lo fija de forma explícita en cada transacción
(`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`), así que no depende de lo que el driver
o el ORM elijan por defecto.

**Alcanza** porque la corrección no viene de lo que lee la transacción. Dos transacciones
que leen "el espacio está libre" al mismo tiempo es justo el caso de arriba, y la
restricción lo resuelve al escribir.

**Por qué no SERIALIZABLE.**

- También impediría la doble reserva, pero abortando una transacción con `40001`. Es un
  error genérico: el servicio tendría que reintentar y recién entonces enterarse de que el
  espacio está tomado. Con la restricción, la respuesta es directa y específica
  (`slot_taken`).
- Rastrea dependencias de lectura (predicate locks), así que aborta transacciones que en
  realidad no chocaban. Con carga, eso significa más reintentos y más latencia.
- No protege nada adicional: cada invariante importante ya es una restricción, un trigger
  o un lock.

**Por qué no REPEATABLE READ.** Le da a cada transacción una foto fija, lo que no ayuda:
las dos seguirían viendo el espacio libre. Además, en PostgreSQL puede abortar un update con
`40001` cuando una fila cambió después de la foto.

## Los otros invariantes bajo concurrencia

| Invariante | Qué lo impone | Dónde |
| --- | --- | --- |
| **I1** sin solapes por profesional | `no_overlap_professional` (EXCLUDE) | `init.sql` |
| **I2** sin solapes por paciente en una clínica | `no_overlap_patient` (EXCLUDE) | `init.sql` |
| **I3** dentro del horario, fuera de bloqueos | Validaciones dentro de la transacción más un **advisory lock de transacción** por profesional: compartido al reservar, exclusivo al cambiar la agenda | `db/locks.ts` |
| **I4** duración fijada por el servicio | El body no puede enviarla; `CHECK (ends_at = starts_at + duration_minutes)` | `slot-rules.ts`, `init.sql` |
| **I7** cancelar libera el espacio al instante | Las restricciones solo cuentan `booked`; el cambio y la liberación son un solo `COMMIT` | `init.sql`, `lifecycle.service.ts` |
| **RF13** solo transiciones válidas | `SELECT ... FOR UPDATE` sobre la cita, más un trigger que impide salir de un estado final | `lifecycle.service.ts`, `init.sql` |

**Por qué I3 necesita un lock.** Una reserva revisa los bloqueos, y un bloqueo nuevo busca
las reservas con las que se cruza. Sin coordinación, las dos cosas pueden correr al mismo
tiempo: la reserva no ve el bloqueo, el bloqueo no ve la reserva, y ambas confirman. El lock
impone un orden: muchas reservas corren en paralelo (compartido), pero un cambio de agenda
las espera y ellas lo esperan a él (exclusivo). Quien llega segundo ve al primero: una
reserva que llega después recibe **422 `professional_unavailable`**, y un bloqueo que llega
después devuelve la reserva en su lista de `conflicts` (RF6). Es un lock de transacción
(`pg_advisory_xact_lock`): se libera en el `COMMIT` o el `ROLLBACK` y es seguro detrás de
PgBouncer en modo transacción.

**Reprogramar (RF10)** corre en una sola transacción: bloquea la cita vieja (`FOR UPDATE`),
la marca `rescheduled` e inserta la nueva. Como la fila vieja deja de contar primero, mover
una cita 15 minutos más tarde funciona aunque los dos intervalos se crucen. Si el nuevo
horario está tomado, toda la transacción hace rollback y la reserva original queda igual.

## Conflictos y deadlocks

- **Los conflictos esperados** se convierten en códigos estables: `slot_taken`,
  `patient_overlap`, `invalid_transition` (409) y `professional_unavailable` (422).
- **Reintentos.** `withTenantTx` reintenta la transacción completa ante `40001` (falla de
  serialización) y `40P01` (deadlock), hasta 3 intentos con backoff exponencial y jitter
  (base de 20 ms, máximo de 250 ms). PostgreSQL ya hizo rollback, así que volver a correrla
  es seguro. Si todos los intentos fallan: **409 `concurrency_conflict`**.
- **Cómo se evitan los deadlocks.**
  - Cada transacción toma como máximo un lock de agenda por profesional, y reprogramar hacia
    otro profesional toma los dos en un **orden fijo** (ids ordenados).
  - Las llamadas a otros servicios (catálogo, pacientes) ocurren **antes** de abrir la
    transacción, y las invalidaciones de Redis **después** del `COMMIT`. Un reintento nunca
    las repite, y ningún lock queda tomado mientras se espera a la red.

## La caché no puede crear una segunda ganadora

La disponibilidad puede salir de Redis, pero una reserva nunca lee la caché: decide contra
PostgreSQL. Aunque una copia vieja mostrara libre un espacio tomado, el `INSERT` fallaría
con 409. La caché solo puede volver una respuesta lenta o vieja, y el caso viejo ya lo
impide I8 (ver [cache.es.md](cache.es.md)).

## Alternativas descartadas

| Alternativa | Por qué no |
| --- | --- |
| **Revisar y después escribir** (`SELECT` de espacios libres y luego `INSERT`) | Las dos transacciones ven el espacio libre y las dos insertan. Es justo el error que busca la pregunta. |
| **`SELECT ... FOR UPDATE` del profesional** | `appointments_db` no tiene fila del profesional (vive en `users_db`). Además serializaría todas las reservas de un profesional, y no protege I2, que cruza profesionales. |
| **Un lock en Redis** | Redis no es la fuente de verdad. Un lock con TTL puede expirar mientras la transacción sigue corriendo, y una falla de Redis bloquearía o rompería las reservas. La garantía viviría fuera de la base que guarda los datos. |
| **SERIALIZABLE** | Correcto, pero responde con un `40001` genérico, necesita reintentos y aborta transacciones que no chocaban. Ver arriba. |
| **Un mutex en el servicio** | Solo funciona dentro de un proceso. Con dos réplicas no protege nada. |

## Cómo se demuestra

| Prueba | Qué demuestra |
| --- | --- |
| [`tests/race/test.ts`](../services/appointments-service/tests/race/test.ts) | 2 recepcionistas, mismo espacio, **100 iteraciones**: siempre exactamente un 201 y un 409 `slot_taken`, y una sola fila. Luego **50** a la vez: un 201 y 49 409. El mismo paciente con dos profesionales: 409 `patient_overlap` (I2). Al final, ningún profesional tiene dos citas `booked` solapadas (I1). |
| [`tests/race/block-vs-booking.test.ts`](../services/appointments-service/tests/race/block-vs-booking.test.ts) | Una reserva y un bloqueo para la misma hora, **60 iteraciones** (I3): o el bloqueo reporta la reserva como conflicto, o la reserva recibe 422. Si se quita el lock compartido de la reserva, falla en las primeras iteraciones. |
| [`tests/integration/lifecycle.test.ts`](../services/appointments-service/tests/integration/lifecycle.test.ts) | Cancelar libera el tiempo al instante (I7); dos recepcionistas que reprograman la misma cita reciben un 201 y un 409; una reprogramación fallida hace rollback; el trigger rechaza transiciones inválidas incluso sin el servicio (RF13). |
| [`packages/db/tests`](../packages/db/tests) | READ COMMITTED se fija de forma explícita; reintentos de `40001`/`40P01`; nada del contexto de un tenant sobrevive a un commit o un rollback. |

Cada prueba pasa por HTTP al servicio real y al esquema real (restricciones, triggers y RLS)
sobre una base desechable:

```bash
TEST_DATABASE_URL=postgres://<usuario>:<contraseña>@localhost:5433/appointments_db \
npm test -w services/appointments-service
```

## Límites conocidos

- **Todavía no hay `Idempotency-Key`.** Si se pierde la respuesta de un 201 y el cliente
  reintenta, el reintento recibe 409 (`slot_taken` o `patient_overlap`: se cruza con su
  propia reserva). Nada se reserva dos veces, pero el cliente no puede saber que el primer
  intento funcionó.
- **Decide una sola base.** La garantía vale porque las dos reservas llegan al mismo
  PostgreSQL. Un sharding futuro por clínica la conserva, porque una reserva nunca cruza
  clínicas; escribir la agenda de una clínica desde dos regiones no la conservaría.
