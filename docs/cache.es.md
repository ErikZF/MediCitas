# Caché de disponibilidad (tarjeta E8)

[English](cache.md) · **Español**

appointments-service guarda en Redis las **ventanas libres de un profesional en un día**.
RF7 (un profesional, un día) y RF8 (todos los profesionales, un rango de fechas) la leen
primero y solo van a PostgreSQL por los días que faltan.

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

**Cuando Redis falla, las respuestas se vuelven más lentas, nunca viejas.**

- Una invalidación fallida se reintenta una vez.
- Si vuelve a fallar, se encola y el breaker se abre.
- Antes de volver a confiar en la caché, se reproduce la cola.
- Si se acumulan más de 1000 invalidaciones, el pod se salta la caché durante un TTL completo, para que todo valor anterior haya expirado.

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

## Resultados

La tabla muestra la mediana de tres corridas en un contenedor Linux de 2 vCPU y 7 GB,
con PostgreSQL 16 y Redis 7 en la misma máquina.

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
- **La latencia que queda no es trabajo de agenda.** RF7 sigue comprobando en PostgreSQL que el profesional ofrece el servicio. Cada petición además pasa por la verificación del JWT, la preparación de la sesión RLS y la serialización JSON.
- **clinics-service y users-service son sustitutos en memoria**, así que estos números aíslan a appointments-service y su base.
- **Los números vienen de una máquina local.** En Kubernetes, Redis y PostgreSQL están a un salto de red, lo que vuelve más lentas ambas filas; cada fallo que va a PostgreSQL cuesta más que un acierto en Redis, así que la diferencia debería crecer, no achicarse.
