# Comparación de estrategias de multi-tenancy

[English](database-comparison.md) · **Español**

Las clínicas comparten tablas en cada base de servicio. Comparamos filtros de
aplicación, RLS y una base por tenant para elegir cómo aislar sus datos.

## Row Level Security

RLS es la capa elegida sobre el discriminador `clinic_id`. Las políticas filtran
filas según la clínica de la transacción, con excepciones por rol para la
administración de plataforma y los catálogos globales.

`USING` controla la visibilidad; `WITH CHECK` valida filas insertadas o actualizadas.
Las políticas requieren contexto verificado y un rol SQL restringido. Superusuarios
y roles con `BYPASSRLS` lo omiten; no protege frente a un login de base comprometido.

## Columna discriminadora

Es parecida a RLS, pero no la impone el motor de PostgreSQL. En este caso, la columna
discriminadora se impone en la capa del ORM, haciendo que cada consulta filtre por una
columna; aquí, la columna discriminadora sería clinic_id.

Los filtros mantienen visible la selección de clínica en cada consulta, pero
omitir uno puede exponer filas.

## Base de datos por tenant

Una base por tenant separa datos y agrega trabajo operativo:

Beneficios:
- Separar bases reduce consultas accidentales entre tenants; el acceso sigue dependiendo de credenciales y enrutamiento.
- Si una clínica necesita escalar su tráfico, el sistema permite escalar solo ese tenant.
- Las métricas por base ayudan a atribuir almacenamiento y actividad a cada tenant.

Desventajas:
- Tener scripts para crear cada base podría complicar la implementación.
- El aprovisionamiento, las migraciones y los respaldos se multiplican por tenant.
  Las bases pueden compartir una instancia PostgreSQL; no requieren un contenedor cada una.


Un esquema por tenant separaría tablas dentro de una misma base, pero
multiplicaría las migraciones DDL y exigiría enrutar cada clínica a su esquema.
Lo descartamos para mantener un esquema por servicio.

## Decisión tomada

Usamos `clinic_id` y RLS en tablas compartidas, con permisos en la API e identidad
local a la transacción. Esto mantiene un esquema por servicio y aplica el filtrado
en el motor. El costo es mantener políticas e inicializar contexto en cada
transacción. No afirmamos que sea la opción de menor costo de rendimiento. Hay
una base por servicio; no una base por tenant.

La comparación medida de RLS contra la columna discriminadora sola, sobre las mismas
consultas y con los mismos intentos de fuga, está en [rls-comparison.es.md](rls-comparison.es.md).
