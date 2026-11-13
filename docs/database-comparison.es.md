# Propósito de este .md

[English](database-comparison.md) · **Español**

Dejar establecida la decisión de arquitectura de por qué usamos RLS.
Para esto, el enunciado pedía comparar estrategias que pudieran garantizar
la separación de los datos entre clínicas. Las candidatas fueron:

## Row Level Security

Esta es la opción elegida: evita cualquier cruce que las clínicas pudieran tener.
Le indica al motor de base de datos que solo muestre las filas cuyo id de clínica
coincide con el id de clínica de la sesión actual.

Esto además aplica a TODAS las consultas: con RLS tienen una cláusula CHECK que
rechaza cualquier consulta que no sea de la misma clínica.

## Columna discriminadora

Es parecida a RLS, pero no la impone el motor de PostgreSQL. En este caso, la columna
discriminadora se impone en la capa del ORM, haciendo que cada consulta filtre por una
columna; aquí, la columna discriminadora sería clinic_id.

Esta solución funciona como RLS, pero no se impone a nivel del motor de base de datos,
así que la responsabilidad recae en el equipo de backend. A cambio, podría quitarle
algo de carga a la base, según cómo estén implementadas las consultas.

En general es una solución válida, pero no es la que elegiríamos.

## Base de datos por tenant

Tener una base de datos por tenant tiene un gran beneficio y algunas desventajas:

Beneficios:
- Tener una base asignada a cada tenant da aislamiento completo.
- Si una clínica necesita escalar su tráfico, el sistema permite escalar solo ese tenant.
- Saber cuánto cobrarle a cada tenant es muy fácil: basta con medir la base de ese tenant.

Desventajas:
- Tener scripts para crear cada base podría complicar la implementación.
- La memoria mínima del sistema es bastante alta, porque hay que crear una instancia
  de Docker, o crear otro archivo .db dentro del mismo contenedor y asumir cambios de contexto.


## Decisión tomada

Decidimos implementar solo RLS, porque alcanza para imponer la seguridad con la menor pérdida de rendimiento.
