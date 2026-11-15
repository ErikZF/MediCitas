# Demo de MediCitas en Postman

[English](README.md) · **Español**

## Entorno local

1. Arranque Compose con el [override local de puertos del README](../README.es.md#arranque-local).
   Compose por defecto solo publica el gateway, que no tiene proxy de dominio.
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
