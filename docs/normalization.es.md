# Normalización hasta tercera forma normal

[English](normalization.md) · **Español**

MediCitas separa los datos de cada entidad para evitar repetir nombres, descripciones
y contacto en cada reserva. El [diccionario de datos](data-dictionary.es.md) detalla
columnas y fuentes SQL. Los ejemplos hipotéticos explican los pasos hasta 3FN;
las redundancias físicas se tratan por separado.

## 1. Primera forma normal: un valor por atributo

Un profesional puede tener varias especialidades. Guardar `specialty_1`, `specialty_2`
o una lista separada por comas en `professional` dificultaría las consultas y cambios.
En cambio, `professional_specialty` guarda una asignación por fila, identificada por
(`clinic_id`, `professional_id`, `specialty_id`).

Lo mismo ocurre con los horarios: `working_hours` guarda un día y un intervalo por
fila. Dos turnos el lunes son dos filas, en lugar de grupos repetidos de columnas
de inicio y fin. Nombre, fecha de nacimiento, teléfono y correo del paciente son
atributos individuales; la aplicación trata `full_name` como un solo valor.

Estas tablas de dominio usan columnas escalares y claves primarias para identificar
filas. Los documentos JSON de eventos y respuestas tienen otro propósito, explicado
en las excepciones.

## 2. Segunda forma normal: depender de toda la clave

En una tabla con clave compuesta, un atributo que no sea parte de una clave no debe
depender solo de una parte de una clave candidata. Una clave candidata es un conjunto
mínimo que identifica una fila de forma única; agregar un UUID no prueba la normalización.

Pensemos en una tabla hipotética de asignación de servicios con clave
(`clinic_id`, `professional_id`, `service_id`) que además guarde el nombre del
profesional y el nombre y duración del servicio:

- (`clinic_id`, `professional_id`) → nombre del profesional.
- (`clinic_id`, `service_id`) → nombre y duración actual del servicio.

Son dependencias parciales. MediCitas guarda el nombre del profesional en
`professional` y el nombre y duración del servicio en `service`. La asignación
queda en `professional_service`; su copia de `specialty_id` es una excepción
explicada abajo. `professional_specialty` contiene solo los tres atributos de su clave.

Los pacientes tienen claves (`clinic_id`, `patient_id`) y (`clinic_id`, `identification`).
Nombre, fecha de nacimiento y contacto describen la ficha del paciente en esa clínica.
`identification` por sí sola no es clave: dos clínicas pueden registrar el mismo documento.

## 3. Tercera forma normal: separar los datos de otras entidades

Después de 2FN, los atributos que no forman parte de una clave no deberían determinar
otros atributos que tampoco sean parte de una clave. Más precisamente, para cada
dependencia no trivial X → A, X debe ser superclave o A debe pertenecer a una clave
candidata. MediCitas elimina estas dependencias transitivas de los registros centrales:

- Usuario → código de rol → descripción del rol. `app_user` guarda `role_code` y
  `role` guarda la descripción; cambiarla no obliga a actualizar a todos los usuarios.
- Usuario/servicio → clínica → nombre y zona horaria. Estos datos quedan en
  `clinic`, sin copiarlos en usuarios, servicios o citas.
- Servicio → especialidad → nombre de especialidad. `service` guarda `specialty_id`
  y `specialty` guarda el nombre compartido.
- Cita → paciente → nombre y contacto; cita → profesional → nombre. Las citas
  guardan referencias a la ficha del paciente y al perfil profesional.

| Tabla | Determinante → atributos que determina |
| --- | --- |
| `clinic` | `clinic_id` o `identifier` → nombre, zona horaria, estado activo y campos del alta pendiente. |
| `role` | `role_code` → `description`. |
| `specialty` | `specialty_id` o `name` → el otro atributo del catálogo. |
| `app_user` | `app_user_id` o `keycloak_sub` → clínica, rol, estado activo e `is_first_admin`. |
| `service` | (`clinic_id`, `service_id`) o (`clinic_id`, `name`) → especialidad, duración, estado activo y el otro identificador/nombre del servicio. |
| `professional` | (`clinic_id`, `professional_id`) o (`clinic_id`, `app_user_id`) → nombre, estado activo del perfil y el otro identificador. |
| `patient` | (`clinic_id`, `patient_id`) o (`clinic_id`, `identification`) → nombre, nacimiento, contacto y el otro identificador. |
| `appointment` | (`clinic_id`, `appointment_id`) → participantes, servicio, intervalo, duración reservada, estado y datos de los cambios. |

`working_hours` y `schedule_block` guardan los atributos de cada turno o bloqueo bajo
su clave por clínica. `clinical_note` separa el texto opcional de la consulta de la
reserva; UNIQUE (`clinic_id`, `appointment_id`) permite como máximo una nota por cita.
Las contraseñas y credenciales de identidad pertenecen a Keycloak, fuera de estas cuatro bases.

Para los datos centrales de clínica, rol, especialidad, servicio y paciente, estas
dependencias tienen claves candidatas como determinantes, lo que sustenta la 3FN.
Las excepciones siguientes limitan esa conclusión en el esquema físico.

## Redundancias deliberadas y excepciones físicas

| Caso | Motivo y límite |
| --- | --- |
| `clinic_id` en tablas por clínica | Delimita las claves y permite que RLS filtre cada fila directamente. Su presencia no viola por sí sola la 3FN: el SQL no declara cada UUID aislado como único global. En `professional`, la clínica repite la de `app_user`; el registro valida que coincidan, pero la FK cubre solo `app_user_id`. |
| `professional_service.specialty_id` | Copia la especialidad del servicio al asignarlo. Respecto a la dependencia del catálogo (`clinic_id`, `service_id`) → `specialty_id`, repite un dato determinado por parte de la clave de asignación, una excepción a 2FN/3FN estrictas. Reserva y disponibilidad exigen que coincida con el catálogo actual. Un cambio de catálogo puede dejarla desactualizada hasta reasignar; ninguna FK la sincroniza. |
| `appointment.duration_minutes` | Es una copia histórica. Si un servicio pasa de 30 a 45 minutos, las citas anteriores conservan la duración reservada. Por eso, el ID del servicio actual no determina la duración de todas sus citas. Reprogramar crea una cita de reemplazo con la duración actual del catálogo. |
| `appointment.ends_at` | (`starts_at`, `duration_minutes`) → `ends_at`, aunque esos datos no son clave. Guardar este valor calculado es una excepción a 3FN: aporta el intervalo usado por las restricciones de solapamiento. Un CHECK mantiene la coherencia entre inicio, duración y fin. |
| `clinical_note` | La copia de `professional_id` permite aplicar RLS directamente. `appointment_status` siempre vale `attended`, una constante redundante. Su CHECK no impone el estado ni el profesional de la cita padre; la API comprueba ambos al crear la nota. La constante impide afirmar 3FN estricta para toda la tabla. |
| Campos del alta | `clinic.bootstrap_admin_id` y `bootstrap_username` conservan datos pendientes de aprovisionamiento y se limpian al activar. `app_user.is_first_admin` marca al administrador inicial, con índice único parcial por clínica. |
| `outbox` y `audit_log` | Conservan datos de eventos. El JSON de outbox lleva datos de enrutamiento/auditoría e identificadores repetidos; `AgendaChanged` puede incluir una lista de fechas. La bitácora conserva actor, paciente, recurso e instante como registro de solo inserción. Estas representaciones de eventos quedan fuera de la justificación relacional estricta de 3FN anterior. |
| `idempotency_keys` | Guarda una copia de respuesta en JSON, fuera del modelo central de entidades. La tabla existe, pero la API no la usa. |

Las referencias entre bases son lógicas: no tienen FK física. Esto afecta cómo se
impone la integridad, mientras que la separación de los datos de cada entidad se mantiene.
Véase la [arquitectura de bases](database.es.md#3-integridad-referencial-entre-microservicios).

## Bases nuevas y existentes

Los esquemas `init.sql` entregados incluyen los ALTER al final. Los volúmenes
existentes necesitan las actualizaciones puntuales que correspondan; el upgrade
de outbox de users crea una clave y valor predeterminado distintos de una base nueva.
El [diccionario de datos](data-dictionary.es.md#bases-nuevas-y-existentes) lista esas diferencias.

Detalles de implementación: [asignación de servicios](../services/appointments-service/modules/service-associations/routes.ts),
[reglas de reserva](../services/appointments-service/modules/booking/slot-rules.ts),
[reserva](../services/appointments-service/modules/booking/booking.service.ts),
[reprogramación](../services/appointments-service/modules/booking/lifecycle.service.ts) y
[notas clínicas](../services/appointments-service/modules/clinical-notes/clinical-note.service.ts).
