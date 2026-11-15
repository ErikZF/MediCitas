# RLS frente a la columna discriminadora, medido

[English](rls-comparison.md) · **Español**

El módulo adicional para grupos de tres, opción 2: *implementar Row-Level Security en
paralelo a la estrategia de multi-tenancy elegida y comparar ambas sobre las mismas
consultas, con pruebas de aislamiento y mediciones.* La comparación escrita de estrategias
y la decisión están en [database-comparison.es.md](database-comparison.es.md); cómo funciona
el aislamiento capa por capa, en [multitenancy.es.md](multitenancy.es.md).

## Las dos estrategias

Las dos guardan todas las clínicas en las mismas tablas, separadas por una columna
`clinic_id` (esquema compartido). Se diferencian en **quién hace cumplir** que una consulta
solo toque su clínica.

| | Columna discriminadora | Row-Level Security |
| --- | --- | --- |
| Dónde vive la regla | En cada consulta del código: `WHERE clinic_id = $clinica` | En el motor: una política por tabla y comando, en [`init.sql`](../database/appointments/init.sql) |
| De dónde sale la clínica | Del valor que pase el código | Del contexto de sesión, que `withTenantTx` carga desde el token verificado con `app_set_session_context()`, local a la transacción |
| Una consulta que olvida el filtro | Ve todas las clínicas | Ve solo su clínica |
| Una escritura en otra clínica | Pasa | Se rechaza (`WITH CHECK`) |
| Sin contexto | No aplica | No ve nada (falla cerrado) |
| La salta | Cualquier error en cualquier consulta | Los superusuarios y los roles con `BYPASSRLS`, que los servicios nunca usan |

MediCitas usa **las dos**: la columna está en todas las tablas, primera en cada llave
primaria y en cada índice, y los servicios filtran por ella donde ayuda al plan; RLS es lo
que garantiza I5. Este documento mide cuánto cuesta cada una y qué protege cada una.

## Cómo se comparó

```bash
TEST_DATABASE_URL=postgres://<usuario>:<clave>@localhost:55432/postgres \
npm run measure:rls -w services/appointments-service
```

`npm run test:all -- --no-e2e --keep` deja un PostgreSQL 18 corriendo en esa dirección.

[`scripts/measure-rls.ts`](../services/appointments-service/scripts/measure-rls.ts) carga el
mismo volumen que las mediciones de índices ([indexes.es.md](indexes.es.md)): **328 230
citas** en 3 clínicas y **1 200 000 eventos de auditoría**, con los índices de `init.sql`.
Luego corre 11 consultas de RF7, RF8, RF15, RF16, RF19, RF20 y RF21, cada una de cinco
maneras, sobre los mismos datos:

| Variante | Rol | Filtro de inquilino en la consulta | RLS |
| --- | --- | --- | --- |
| **Solo columna** | Un rol con los privilegios de `medicitas_app` y `BYPASSRLS` | Sí | Apagado |
| **Solo RLS** | `medicitas_app`, con el contexto de sesión | No | Encendido |
| **Ambas** | `medicitas_app`, con el contexto de sesión | Sí | Encendido (lo que hacen los servicios) |
| **RLS, en caché** / **Ambas, en caché** | Igual que arriba, después de reescribir las políticas con `(SELECT app_current_role())` en vez de `app_current_role()` | | Encendido |

Los tiempos son la mediana de 7 corridas en un contenedor de 2 vCPU con PostgreSQL 16
(Compose usa 18; los planes son del mismo tipo). Los buffers son páginas de 8 KB: muestran el
trabajo, y el tiempo su costo en esa máquina. El script también comprueba que todas las
variantes devuelvan las mismas filas.

## Aislamiento

[`tests/integration/rls-vs-column.test.ts`](../services/appointments-service/tests/integration/rls-vs-column.test.ts)
hace los mismos intentos contra las dos estrategias, como recepción de la clínica A, con una
cita en la clínica A y otra en la clínica B. Corre con todas las demás pruebas
(`npm run test:all`).

| Intento | Solo columna | RLS |
| --- | --- | --- |
| La consulta tiene el filtro correcto | Solo clínica A | Solo clínica A |
| La consulta olvidó el filtro | **Clínicas A y B** | Solo clínica A |
| El id de clínica viene de la petición y se manipuló a B | **Clínica B** | Nada |
| Insertar una cita para la clínica B | **Se inserta** | Se rechaza: `new row violates row-level security policy` |
| Cancelar las citas de la clínica B | **1 fila cambiada** | 0 filas |
| Una sesión sin contexto de inquilino | (no existe) | Nada |

La columna discriminadora es exactamente tan segura como la consulta menos cuidadosa que se
llegue a escribir. RLS convierte esos mismos errores en resultados vacíos o en errores. El
script de medición repite el caso del filtro olvidado sobre el volumen grande: solo columna
ve 3 clínicas, RLS ve 1.

## Rendimiento

| Consulta | Filas | Solo columna | Solo RLS | Ambas (servicios) | RLS, en caché | Ambas, en caché |
| --- | ---: | --- | --- | --- | --- | --- |
| RF7 · citas reservadas de un profesional en un día | 11 | 0.05 ms, 32 buf | 0.05 ms, 32 buf | 0.04 ms, 32 buf | 0.04 ms, 32 buf | 0.06 ms, 32 buf |
| RF8 · citas reservadas de tres profesionales en una semana | 169 | 0.15 ms, 102 buf | 0.23 ms, 263 buf | 0.24 ms, 102 buf | 0.18 ms, 102 buf | 0.15 ms, 102 buf |
| RF7 · bloqueos de un profesional en un día | 0 | 0.02 ms, 20 buf | 0.03 ms, 20 buf | 0.03 ms, 20 buf | 0.04 ms, 20 buf | 0.05 ms, 20 buf |
| RF7 · horario semanal de un profesional | 10 | 0.01 ms, 3 buf | 0.02 ms, 3 buf | 0.03 ms, 3 buf | 0.03 ms, 3 buf | 0.02 ms, 3 buf |
| RF8 · profesionales que ofrecen un servicio | 3 | 0.01 ms, 1 buf | 0.03 ms, 2 buf | 0.02 ms, 2 buf | 0.01 ms, 1 buf | 0.02 ms, 1 buf |
| RF20 · agenda de toda la clínica en un día | 210 | 0.16 ms, 41 buf | 0.35 ms, 41 buf | 0.35 ms, 41 buf | 0.15 ms, 41 buf | 0.16 ms, 41 buf |
| RF16 · historial de citas de un paciente | 30 | 0.06 ms, 32 buf | 0.07 ms, 32 buf | 0.06 ms, 32 buf | 0.04 ms, 32 buf | 0.04 ms, 32 buf |
| RF21 · citas por estado en un mes | 2 | 1.60 ms, 50 buf | 4.59 ms, 50 buf | 7.32 ms, 50 buf | 1.24 ms, 50 buf | 1.44 ms, 50 buf |
| RF15 · nota clínica de una cita | 1 | 0.02 ms, 4 buf | 0.02 ms, 4 buf | 0.03 ms, 4 buf | 0.02 ms, 4 buf | 0.02 ms, 4 buf |
| RF19 · bitácora de un paciente | 20 | 0.03 ms, 23 buf | 0.06 ms, 23 buf | 0.06 ms, 23 buf | 0.04 ms, 23 buf | 0.04 ms, 23 buf |
| RF19 · bitácora completa de la clínica en un día | 550 | 0.20 ms, 15 buf | 0.52 ms, 15 buf | 0.63 ms, 15 buf | 0.16 ms, 15 buf | 0.24 ms, 15 buf |

Las diferencias de menos de unos 0.05 ms son ruido en esta máquina.

### Qué muestran los planes

- **RLS usa los mismos índices.** El `clinic_id = app_current_clinic_id()` de la política
  pasa a formar parte del *Index Cond*, igual que un `clinic_id = '…'` literal: la función
  es `STABLE`, así que PostgreSQL la evalúa una vez al empezar el recorrido y busca en el
  índice con ese valor. Cada consulta lee prácticamente las mismas páginas en todas las
  variantes, con una excepción (siguiente punto). Por eso las llaves primarias y los índices
  empiezan con `clinic_id`.
- **Un plan cambió por lo que sabe el planificador.** En RF8 con solo RLS, la clínica no se
  conoce al planificar (viene de una función), la estimación de filas cambia y el
  planificador eligió un recorrido de índice simple que leyó 263 páginas en vez de uno de
  tipo bitmap que lee 102. Con el filtro también en la consulta (*Ambas*), el plan es el
  mismo que con la columna. Es una de las razones por las que los servicios conservan el
  filtro en sus consultas aunque RLS alcanzaría.
- **El costo de RLS es una revisión del rol por fila.** Además de la clínica, cada política
  revisa el rol: `app_current_role() IN ('clinic_admin', 'receptionist', 'professional')`.
  Esa parte no puede ir al índice, así que es un *Filter* que llama a una función PL/pgSQL
  **una vez por fila**. Con 11 filas no se nota; RF21 cuenta 4 830 filas y paga cerca de
  3 ms; el día de bitácora, 550 filas, cerca de 0.3 ms. El filtro también cambia la
  estimación de filas del planificador, por eso RF21 pasó de una agregación con hash a un
  ordenamiento.
- **Ambas cuesta casi lo mismo que solo RLS**: la revisión del rol por fila está en las dos.
  La clínica se revisa una sola vez: cuando la consulta dice `clinic_id = 'A'` y la política
  dice `clinic_id = app_current_clinic_id()`, PostgreSQL deduce un *One-Time Filter*
  `app_current_clinic_id() = 'A'`, evaluado una vez por consulta. De paso es una comprobación
  de consistencia gratis: si el código y la sesión no coincidieran en la clínica, la consulta
  no devolvería nada.
- **Guardar en caché las funciones elimina el costo.** Escrita como
  `(SELECT app_current_role())`, la llamada se vuelve un *InitPlan*: se evalúa una vez por
  consulta y su resultado se reutiliza en cada fila. Con las políticas reescritas así, RLS
  cuesta lo mismo que la columna (RF21: 1.24 ms contra 1.60 ms; RF20: 0.15 ms contra
  0.16 ms) y conserva todas las garantías: las comprobaciones de aislamiento del script dan
  el mismo resultado.

## Decisión

**RLS se queda como garantía, y la columna se queda como modelo de datos y como filtro de
las consultas.** Sobre la columna sola, RLS agrega lo que muestra la tabla de aislamiento,
que es la propia I5: un filtro olvidado, un parámetro manipulado o una escritura en otra
clínica dejan de ser fugas. Lo que cuesta aquí, con este volumen, es la revisión del rol por
fila, a lo sumo unos milisegundos en la consulta más grande, y las mediciones muestran cómo
eliminarla.

| | Lo que se gana con RLS | Lo que se cede |
| --- | --- | --- |
| Seguridad | El aislamiento no depende de que todas las consultas estén bien; también se revisan las escrituras; sin contexto no hay filas | Un rol con `BYPASSRLS`, o una conexión de superusuario, ve todo: los servicios nunca usan uno |
| Rendimiento | Los mismos índices y páginas que con la columna | Una revisión del rol por fila (hasta ~3 ms en RF21 aquí), que se elimina guardando en caché las funciones; los planes que dependen de la clínica se estiman con menos precisión sin el filtro en la consulta |
| Operación | La regla se escribe una vez por tabla, en SQL, junto a los datos | Hay que cargar el contexto en cada transacción (`withTenantTx` lo hace, local a la transacción, así que es seguro con un pool y con PgBouncer en modo transacción); los errores son menos explícitos (un resultado vacío en vez de un 403); las pruebas tienen que correr como `medicitas_app`, no como el dueño |

**Siguiente paso, no aplicado en este cambio:** reescribir las políticas de los cuatro
`init.sql` con la forma en caché `(SELECT app_current_…())`. El script ya demuestra que
devuelve las mismas filas y elimina el costo por fila; aplicarlo implica cambiar todas las
políticas y agregar los scripts de actualización para las bases existentes, así que va en
su propio cambio, con la suite completa de pruebas como verificación.
