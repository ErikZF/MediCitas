# Demo de MediCitas en Postman

[English](README.md) · **Español**

## Entorno local

1. Arranque Compose como indica el [README](../README.es.md#arranque-local). El gateway en el
   puerto 3000 reenvía todas las rutas de dominio; el override local de puertos solo hace falta
   para llamar a un servicio directamente.
2. Importe [el ejemplo seguro de entorno](environments/medicitas.local.example.postman_environment.json)
   en Postman, duplíquelo como **MediCitas Local** y seleccione la copia.
   Las URL suponen puertos 3000-3004 y Keycloak 8080; ajuste a sus mapeos locales.
3. Complete tokens e `initialPassword` solo en valores locales. No comparta/sincronice
   secretos ni exporte un entorno completo a Git. Si necesita copia en disco, use
   `postman/environments/medicitas.local.postman_environment.json` (ignorado).
   Conserve el ejemplo versionado sin cambios, con los secretos vacíos.

## Tokens

MediCitas no tiene ruta de login. Después de que `keycloak-seed` termine bien,
use una petición local sin guardar en Postman hacia Keycloak:

```text
POST {{keycloakUrl}}/realms/{{realmName}}/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
client_id={{testClientId}}
username=<usuario semilla de abajo>
password=<su KEYCLOAK_TEST_PASSWORD local>
```

Use los valores reales de su `.env` si cambió realm/client/puerto. El cliente de
pruebas es público y permite direct grants; no requiere client secret. Copie solo
el `access_token` devuelto a la variable local correspondiente, **sin `Bearer `**:

| Usuario semilla | Variable local de token | Alcance |
| --- | --- | --- |
| `platform.admin` | `platformAdminToken` | Solo alta de clínicas |
| `admin.sj` | `clinicAdminToken` | Administración y auditoría de clínica 1 |
| `reception.sj` | `receptionistToken` | Pacientes y citas de clínica 1 |
| `dr.mora` | `professionalToken` | Profesional `professionalId` de clínica 1 |

Los UUID del ejemplo vienen de las semillas SQL de clínica 1. `clinicId` documenta
su alcance; las peticiones derivan la clínica del token, no de esa variable. Los
tokens requieren issuer/audience configurados y claims de dominio (vea [API](../docs/api.es.md)).
Renueve tokens vencidos y los afectados por cambios de rol/perfil. No use el token
de la consola de administración de Keycloak para llamadas de dominio.

## Datos para la demo

Importe [MediCitas Demo](collections/medicitas-demo.postman_collection.json) como
colección. Envíe peticiones individuales en orden de carpetas; las opcionales de
alta/administración crean datos extra y no son prerrequisitos de las citas semilla.
Ejecute la limpieza de carpeta 90 al final. No ejecute toda la colección sin atender.
Deténgase ante respuesta inesperada o variable vacía/sin resolver. Los scripts
comprueban estado esperado y capturan UUID nuevos solo ante éxito; una creación
fallida limpia sus variables de salida. Asígnelas manualmente solo desde una
respuesta confirmada. No repita una reserva para recuperar un ID perdido.

Use datos locales descartables. Elija identificadores de clínica, usernames, nombres
de servicio e identificaciones de paciente únicos antes de crear recursos. Defina
`initialPassword` localmente (12-256 caracteres); se usa para el alta y no se guarda
en la plantilla. Las variables vacías `demo*`/`managedUserId` son para recursos nuevos,
separados de los IDs semilla. `appointmentAId` y `replacementAId` comienzan vacíos.
Las fechas e instantes son placeholders deliberados: seleccione fechas futuras en
la zona de la clínica y espacios libres de disponibilidad; use instantes ISO con
`Z` o desfase. Para rangos en queries use `Z` o desfases negativos; codifique un `+`
positivo como `%2B`. RF8 admite hasta 31 fechas incluyendo ambos extremos.

El [recorrido REST Client](../requests/demo.http) es una alternativa de cliente,
no un prerrequisito. El [contrato](../docs/api.es.md) documenta respuestas esperadas;
esta plantilla de entorno por sí sola no demuestra una ejecución con la pila completa.

## Recorrido de citas y auditoría

Después de salud y lecturas de catálogo/paciente semilla, use las carpetas 05-09:

1. Consulte horarios/bloqueos y disponibilidad. Defina `startsA` con un espacio futuro
   de `dayFrom` y `replacementStartsA` con otro libre sin solape. Ambos pacientes
   deben pertenecer a clínica 1; `conflictPatientId` debe estar libre en ese intervalo.
2. Reserve A una vez: **201** captura `appointmentAId`. Consulte disponibilidad otra vez.
   Antes de liberar A, pida el mismo profesional/inicio para el otro paciente:
   **409 `slot_taken`**. La petición con `durationMinutes` extra demuestra
   **422 `invalid_request`**. Conserve `startsA` sin cambios y futuro durante esos pasos.
3. Reprograme A: **201** captura `replacementAId`. Cancele el reemplazo:
   **200 cancelled**; repita la cancelación: **409 `invalid_transition`**.
   Compruebe que el espacio original vuelva a estar libre mientras siga siendo futuro.
4. Por separado revise `startedAppointmentId`: debe estar booked, ya iniciada y ser
   de `dr.mora`. Solo entonces márquela atendida y cree/lea su nota. La semilla 804
   inicia el 2026-11-12; los volúmenes existentes pueden tener otro estado actual.
   Cada repetición necesita una cita preparada. Nunca use A cancelada.
5. Consulte historial, agendas y conteos. Auditoría muestra sin token **401**,
   recepción **403** y administrador de clínica **200**, con filtros AND opcionales.
   Un rango con fechas de eventos semilla puede devolver filas; `[]` también es válido.

Los eventos nuevos de contacto/nota quedan en el outbox de su dueño. Falta el relay
N10 a `logs_db`, así que esos eventos no aparecerán en auditoría mediante esta colección.
El ejemplo secuencial de 409 no sustituye la prueba automatizada de carrera concurrente.

Validación J5: revisión estática de JSON, esquema oficial Postman v2.1, variables,
sintaxis de scripts, rutas/bodies y enlaces. No se ejecutaron peticiones HTTP: este
checkout no tenía `.env` ni proyecto Compose corriendo. Ejecute las peticiones elegidas
contra una pila preparada antes de presentar; las aserciones de estado son expectativas.
