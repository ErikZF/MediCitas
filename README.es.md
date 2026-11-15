# MediCitas

[English](README.md) · **Español**

[![CI](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml/badge.svg)](https://github.com/ErikZF/MediCitas/actions/workflows/ci.yml)

Plataforma SaaS multi-tenant de citas médicas (Proyecto Semestral, Etapa 1 · OLTP), construida como microservicios en Node.js + TypeScript.

## Estructura

```
services/
  edge-gateway/          única entrada pública; reenvía cada ruta a su servicio
  clinics-service/       clínicas, especialidades y servicios   → clinics_db
  users-service/         usuarios, profesionales y pacientes    → users_db
  appointments-service/  agenda, citas y notas clínicas         → appointments_db
  audit-service/         bitácora append-only                   → logs_db
  Dockerfile             imagen de cualquier servicio (--build-arg SERVICE=...)
packages/                librerías compartidas que los servicios importan por nombre,
                         por ejemplo @medicitas/http, @medicitas/auth y @medicitas/db
database/                esquema de cada base
deploy/                  manifiestos Kubernetes (Kustomize + Kind) y scripts de despliegue
keycloak/                realm versionado
docs/                    documentación
postman/                 colección de demo y plantilla segura de entorno
requests/                recorrido REST Client y ejemplo de entorno local
```

Es un workspace de npm: un solo `npm install` en la raíz instala todo.

## Comandos

```bash
npm install
npm run build        # paquetes compartidos y luego servicios
npm run typecheck
npm test             # pruebas unitarias; las de integración se saltan sin base de datos
npm run test:all     # suites y E2E Compose (requiere Docker; vea límites)
npm run dev -w services/edge-gateway
```

Los comandos en el host requieren Node.js **>=22.18** y npm. Ejecute
`npm run build:packages` antes de arrancar un servicio en desarrollo. Cada servicio
carga el `.env` raíz; el comando del gateway arranca solo el gateway.

## Arranque local

Instale Docker Engine/Desktop con Compose v2 (contenedores Linux). Desde la raíz,
copie `.env.example` a `.env` **solo si `.env` todavía no existe**
(`Copy-Item .env.example .env` en PowerShell, `cp .env.example .env` en Bash).
Guarde las credenciales en ese archivo local ignorado. Revise las credenciales de
bases y Keycloak, `KEYCLOAK_TEST_PASSWORD`, `KEYCLOAK_USER_ADMIN_SECRET` y la
contraseña de Redis junto con `REDIS_URL`. Conserve los hosts por nombre de servicio
y las URL internas para Compose; `KEYCLOAK_ISSUER` debe coincidir con la URL usada
para obtener tokens desde el host.

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail=50 keycloak-seed
curl http://localhost:3000/health
```

El puerto del host predeterminado es `API_PORT=3000`; en PowerShell también sirve
`Invoke-RestMethod http://localhost:3000/health`. Se espera `{"status":"ok"}`.
Compose arranca cuatro bases PostgreSQL **18**, Keycloak, su carga de usuarios de
una sola ejecución, Redis y los cinco servicios HTTP. El esquema y las semillas SQL
se ejecutan solo sobre **volúmenes de base vacíos**; los existentes se conservan y
no se migran automáticamente. El job de semillas debe terminar con código 0; no
queda corriendo. Para investigar fallas use `docker compose logs --tail=50 <servicio>`.

Solo el gateway publica un puerto HTTP de la aplicación por defecto. Keycloak usa
8080; PostgreSQL appointments/users/logs/clinics usa 5433/5434/5435/5436 y Redis,
6379. Compose no restringe estos mapeos a loopback; use este entorno de desarrollo
en una máquina de confianza. `private_net` es interna; solo Keycloak y el gateway
se conectan también a `public_net`. El gateway reenvía las rutas de dominio al servicio que
la atiende, con el header Authorization incluido, así que toda la API queda en
`http://localhost:3000` (por ejemplo `GET /availability?...`, `POST /appointments`,
`GET /audit/logs`). Cada servicio sigue verificando el token por su cuenta. Un upstream
inalcanzable produce 502 `upstream_unavailable`; un timeout de socket de 15 segundos,
504 `upstream_timeout`; y una URL de upstream ausente, 503 `upstream_not_configured`.
El gateway reenvía tokens y los servicios de dominio los autentican. Compruebe un servicio privado dentro de Compose:

```bash
docker compose exec clinics-service node -e "fetch('http://127.0.0.1:' + process.env.API_INTERNAL_PORT + '/health').then(r => r.json()).then(console.log)"
```

Para llamar a un servicio directamente desde el host (opcional), cree localmente `.env.compose-demo.yaml`, ignorado:

```yaml
services:
  clinics-service:
    ports: ["127.0.0.1:3001:3000"]
    networks: [private_net, public_net]
  users-service:
    ports: ["127.0.0.1:3002:3000"]
    networks: [private_net, public_net]
  appointments-service:
    ports: ["127.0.0.1:3003:3000"]
    networks: [private_net, public_net]
  audit-service:
    ports: ["127.0.0.1:3004:3000"]
    networks: [private_net, public_net]
```

```bash
docker compose -f docker-compose.yml -f .env.compose-demo.yaml up -d --build
```

Estos mapeos suponen `API_INTERNAL_PORT=3000` y puertos del host libres. Use las
mismas opciones `-f` con los comandos posteriores de Compose. Las URL directas son
`http://localhost:3001` a `http://localhost:3004`, respectivamente; las URL internas
no cambian. El override conserva `private_net` para tráfico entre servicios y añade
`public_net` porque `private_net` es interna; publicar puertos por sí solo no basta
para acceder desde el host. `/health` indica que el servidor responde; no comprueba
bases, identidad ni caché. Las llamadas de dominio necesitan tokens vigentes de
Keycloak con clínica y rol correctos; vea el [contrato de la API](docs/api.es.md).
Detenga la pila con `docker compose stop` (con las mismas opciones `-f` si las usó).

`npm test` puede omitir integraciones si faltan PostgreSQL, Redis o la configuración
de Keycloak. Vea [requisitos de pruebas y cobertura de CI](docs/ci-cd.es.md) y el
[recorrido de Postman](postman/README.es.md) para preparar la demo.

## Pruebas

```bash
npm run test:all
```

El runner levanta PostgreSQL 18 y Redis descartables para las suites y luego
ejecuta el recorrido de Compose. Prepare `.env` como se indicó e instale antes
las dependencias npm. La etapa 2 recompila y modifica la pila de demo, conservando
los volúmenes existentes. Las pruebas de Keycloak con realm temporal aún necesitan
configuración aparte y pueden omitirse. La limpieza predeterminada de la etapa 1
elimina sus contenedores y volúmenes. Opciones, resultados registrados y límites:
[informe de pruebas](docs/test-report.es.md).

## Documentación

| Tema | Español | English |
| --- | --- | --- |
| Contrato de la API | [docs/api.es.md](docs/api.es.md) | [docs/api.md](docs/api.md) |
| Demo Postman | [postman/README.es.md](postman/README.es.md) | [postman/README.md](postman/README.md) |
| Bases de datos y RLS | [docs/database.es.md](docs/database.es.md) | [docs/database.md](docs/database.md) |
| Diccionario de datos | [docs/data-dictionary.es.md](docs/data-dictionary.es.md) | [docs/data-dictionary.md](docs/data-dictionary.md) |
| Normalización hasta 3FN | [docs/normalization.es.md](docs/normalization.es.md) | [docs/normalization.md](docs/normalization.md) |
| Arquitectura multi-tenancy | [docs/multitenancy.es.md](docs/multitenancy.es.md) | [docs/multitenancy.md](docs/multitenancy.md) |
| Comparación de multi-tenancy | [docs/database-comparison.es.md](docs/database-comparison.es.md) | [docs/database-comparison.md](docs/database-comparison.md) |
| RLS frente a la columna discriminadora, medido | [docs/rls-comparison.es.md](docs/rls-comparison.es.md) | [docs/rls-comparison.md](docs/rls-comparison.md) |
| Identidad con Keycloak | [docs/keycloak.es.md](docs/keycloak.es.md) | [docs/keycloak.md](docs/keycloak.md) |
| Datos semilla de demo | [docs/seed-data.es.md](docs/seed-data.es.md) | [docs/seed-data.md](docs/seed-data.md) |
| Concurrencia: el último espacio | [docs/concurrency.es.md](docs/concurrency.es.md) | [docs/concurrency.md](docs/concurrency.md) |
| Caché de disponibilidad | [docs/cache.es.md](docs/cache.es.md) | [docs/cache.md](docs/cache.md) |
| Índices y sus planes | [docs/indexes.es.md](docs/indexes.es.md) | [docs/indexes.md](docs/indexes.md) |
| Informe de pruebas | [docs/test-report.es.md](docs/test-report.es.md) | [docs/test-report.md](docs/test-report.md) |
| CI/CD | [docs/ci-cd.es.md](docs/ci-cd.es.md) | [docs/ci-cd.md](docs/ci-cd.md) |
| Despliegue en Kubernetes | [deploy/README.es.md](deploy/README.es.md) | [deploy/README.md](deploy/README.md) |
| Capa de datos `@medicitas/db` | [packages/db/README.es.md](packages/db/README.es.md) | [packages/db/README.md](packages/db/README.md) |

Las guías mantenidas tienen versiones en inglés y español enlazadas al inicio.
Actualice ambas juntas. La [captura histórica de planes](docs/indexes-plans.md)
se conserva en su idioma original. La guía de despliegue cubre un entorno local
opcional; Compose sigue siendo el arranque de la Etapa 1.

## Declaración de uso de IA

Usamos inteligencia artificial para implementar buena parte del código de
MediCitas y para crear pruebas. La entrega combina código escrito por nosotros
con código generado con IA a partir de nuestras indicaciones.

Planeamos el proyecto y trabajamos su diseño entre los tres integrantes del
equipo, tomando como punto de partida la consulta que hicimos al profesor. A partir
de esa conversación decidimos trabajar con una arquitectura de microservicios e
investigamos cómo implementarla. Con esa base, fuimos definiendo las tecnologías
que usaríamos, cómo abordar cada problema y qué buenas prácticas seguir. Esas
decisiones orientaban las solicitudes a la IA: le indicábamos qué debía implementar,
con qué tecnologías y bajo qué condiciones.

También recurrimos a la IA para agilizar la escritura de pruebas, dado el volumen
de trabajo que requerían. Nosotros especificábamos los tipos de pruebas, los
casos que queríamos cubrir, el comportamiento esperado y las herramientas con
las que debían implementarse. Con esas indicaciones, la IA nos ayudaba a producir
el código de las pruebas.
En la documentación también usamos IA para afinar la redacción, ordenar las
explicaciones y darles un formato más claro y presentable. Nos ayudó a pulir los
textos y mantener un estilo uniforme entre las guías, para que el trabajo fuera
más fácil de leer y consultar. Además, usamos IA para las traducciones de la
documentación entre español e inglés.

Revisábamos el código generado para comprobar que tuviera sentido, respetara el
diseño acordado y resolviera el problema planteado. Consideramos que la IA puede
acelerar buena parte de la implementación cuando el equipo tiene claro qué quiere
construir y guía ese trabajo. La responsabilidad por las decisiones, la revisión
y el contenido final de esta entrega sigue siendo nuestra.
