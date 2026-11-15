# Caché de disponibilidad

[English](cache.md) · **Español**

appointments-service guarda en Redis las **ventanas libres de un profesional en un día**.
RF7 (un profesional, un día) y RF8 (todos los profesionales, un rango de fechas) la leen
primero y cargan de PostgreSQL los días faltantes. También consultan asociaciones
de servicios; un acierto de caché no elimina toda consulta a la base.

## Diseño

| Pieza | Dónde | Qué hace |
| --- | --- | --- |
| Cache-aside | `modules/availability/availability.service.ts` | Busca, calcula en PostgreSQL lo que falta y lo guarda. |
| Claves | `cache/agenda-cache.ts` | `avail:v1:{clinic:professional}:g<gen>:v<ver>:<date>` |
| Invalidación | servicios de reservas, ciclo de vida y horarios | Después del `COMMIT`, sube un contador. |
| Circuit breaker | `cache/circuit-breaker.ts` | Tras 3 fallas, se salta Redis durante 5 s; las peticiones van a PostgreSQL. |
| Conexión | `cache/redis.ts` | `CACHE_ENABLED`, `REDIS_URL`, `CACHE_TTL_SECONDS` |

**Dos contadores en el nombre de la clave.**

- `gen` (por profesional) sube cuando cambian los horarios o los bloqueos, lo que mueve todos los días de ese profesional a claves nuevas.
- `ver` (por profesional y día) sube al reservar, cancelar, reprogramar o registrar un desenlace.

Los lectores leen ambos contadores **antes** de leer PostgreSQL y guardan en la clave
armada con ellos. Un escritor que confirma en medio sube un contador antes de responder,
así que un guardado tardío cae en una clave que nadie volverá a leer y expira con su TTL.
Por eso alcanza con un `SET` simple y no hace falta un compare-and-set en Lua. El TTL
(600 s por defecto) solo limpia claves huérfanas; no es lo que mantiene la caché correcta.

**Los escritores que no conocen la zona horaria de la clínica** (cancelar, desenlace)
invalidan la fecha UTC y sus dos vecinas (`possibleLocalDates`). Las invalidaciones de
más son baratas.

Una invalidación fallida hace que el proceso afectado omita la caché:

- Una invalidación fallida se reintenta una vez.
- Si vuelve a fallar, se encola y el breaker se abre.
- Antes de volver a confiar en la caché, se reproduce la cola.
- Si se acumulan más de 1000 invalidaciones, el pod se salta la caché durante un TTL completo, para que todo valor anterior haya expirado.

Si el proceso muere entre `COMMIT` e invalidación, la cola en memoria se pierde.
Con la caché habilitada, cada transacción que cambia una agenda también inserta un
evento `AgendaChanged` en la tabla `outbox`, en la misma transacción
([`db/agenda-outbox.ts`](../services/appointments-service/db/agenda-outbox.ts)):

| Escritura | Payload del evento |
| --- | --- |
| Reservar | `{ professionalId, dates: [día] }` |
| Reprogramar | un evento para el día viejo y otro para el nuevo (pueden ser dos profesionales) |
| Cancelar, registrar el desenlace | `{ professionalId, dates: [fecha UTC y sus vecinas] }` |
| Horarios, bloqueos | `{ professionalId, dates: null }` (todos los días: sube `gen`) |

Un relay en cada pod ([`cache/agenda-relay.ts`](../services/appointments-service/cache/agenda-relay.ts))
toma los eventos pendientes cada segundo con `FOR UPDATE SKIP LOCKED`, los aplica en Redis y
los marca publicados en la misma transacción. Si Redis falla, la transacción hace rollback y
los eventos esperan a la siguiente pasada. Corre como `medicitas_relay` y solo toma
`AgendaChanged`: los eventos `AuditRecorded` son del relay de auditoría.

La invalidación directa corre después del commit y antes de responder. El relay
reintenta las pendientes; consultar cada segundo no limita el plazo de datos viejos.
Un proceso puede morir después del commit o fallar al invalidar mientras otro sigue
leyendo Redis. El breaker y la cola son locales a cada proceso. Estos casos dejan
I8 sin demostrar ante fallos o múltiples réplicas. Las claves versionadas protegen
consultas posteriores a un aumento exitoso del contador; no hacen atómica una
lectura ya iniciada con una escritura concurrente. Solo se escriben eventos con la caché habilitada.

## Cómo medirla

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
TEST_REDIS_URL=redis://localhost:6379 \
npm run measure:availability -w services/appointments-service
```

El script corre la misma carga dos veces, una sin caché (`CACHE_ENABLED=false`) y otra
con Redis. Cada corrida usa su propia base desechable con la misma semilla:

- 2 profesionales, de lunes a viernes de 08:00 a 12:00 y de 13:00 a 17:00, durante 20 días hábiles.
- 6 citas reservadas por profesional por día.
- Un bloqueo de una hora cada cinco días.

La mezcla de peticiones es 80 % RF7 y 20 % RF8, repartida por turnos entre todos los días
y profesionales. Primero van 200 peticiones de calentamiento y luego 2000 medidas, con 20
en paralelo. Se pueden cambiar con `MEASURE_REQUESTS` y `MEASURE_CONCURRENCY`.

*Consultas de agenda por petición* cuenta las sentencias SQL que tocan `working_hours`,
`schedule_block` o `appointment`, que es el trabajo que la caché busca ahorrar.

## Resultados registrados

Son medianas reportadas previamente de tres corridas en un contenedor Linux de
2 vCPU y 7 GB, con PostgreSQL 16 y Redis 7. No se repitieron en esta revisión;
Compose usa PostgreSQL 18. No acreditan el rendimiento actual de la pila completa.

| Caché | p50 | p95 | p99 | Peticiones/s | Consultas de agenda por petición | Tasa de aciertos |
| --- | --- | --- | --- | --- | --- | --- |
| Apagada (`CACHE_ENABLED=false`) | 35.4 ms | 57.6 ms | 71.6 ms | 521 | 3.00 | — |
| Encendida (Redis) | 20.6 ms | 30.9 ms | 41.6 ms | 904 | 0.00 | 100.0 % |

Con la caché encendida:

- p50 y p95 bajan alrededor de un 45 %.
- El throughput sube alrededor de 1.7 veces.
- Ninguna consulta de agenda llega a PostgreSQL una vez que la caché está caliente.

## Salvedades

- **La tasa de aciertos es el mejor caso.** Nada escribe durante la medición. En uso real cada reserva sube un contador de día, así que la siguiente lectura de ese día es un fallo.
- **La latencia que queda no es trabajo de agenda.** RF7 sigue comprobando en PostgreSQL que el profesional ofrece el servicio. El helper de medición inyecta contexto de tenant: mide la preparación RLS y la serialización JSON, pero no la verificación real de JWT contra Keycloak.
- **clinics-service y users-service son sustitutos en memoria**, así que estos números aíslan a appointments-service y su base.
- Los números corresponden a esa carga local. La red, escrituras, réplicas y latencia
  de dependencias pueden cambiar el resultado; no se acredita una mejora en Kubernetes.
- Use PostgreSQL 18 y Redis en una instancia descartable de pruebas. El helper crea
  y borra bases y requiere un login administrativo de pruebas. La asignación de
  variables de arriba es Bash; para PowerShell vea [requisitos de pruebas](ci-cd.es.md).
