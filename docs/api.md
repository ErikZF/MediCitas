# API quick start

The API currently responds to `GET /` and `GET /health`. The health route
checks that Express responds. Clinical features and authentication are not
connected yet.

## Set the port

`API_INTERNAL_PORT` is required. It must be a whole number from 1 to 65535.
## Start only the API

Open PowerShell in the repository root:

```powershell
cd C:\Proyecto1BDII\MediCitas
docker compose --env-file .env.example build api
docker compose --env-file .env.example up -d --no-deps api
```

`--no-deps` starts the API without starting PostgreSQL or Keycloak. The build
installs dependencies inside the image. It does not use Windows `node_modules`.

## Check the routes

Open these addresses while the API is running:

| Address | Expected response |
| --- | --- |
| http://localhost:3000/ | `Hello World!` (200) |
| http://localhost:3000/health | `{"status":"ok"}` (200) |

`/health` does not check the database or identity service. If you choose a
different `API_PORT`, use that port in the addresses.

## Run the tests

From the repository root:

```powershell
docker compose --env-file .env.example exec -T api npm run typecheck
docker compose --env-file .env.example exec -T api npm test
```

`typecheck` checks TypeScript. `npm test` removes the generated `dist` folder,
builds fresh JavaScript, then runs `vitest run` once and exits. The startup
tests launch that new build. The empty authentication and concurrency files
are excluded; they do not provide test coverage. A failed build stops the test
command before Vitest runs.

## stop

`stop api` stops only the API. It does not remove containers or volumes.
