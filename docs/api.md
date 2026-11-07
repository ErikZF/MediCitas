# API quick start

MediCitas runs as microservices in one npm workspace. Every service responds to
`GET /health`; the edge gateway also keeps `GET /`. Clinical features are not
connected yet.

## Layout

| Folder | What it is |
| --- | --- |
| `services/edge-gateway` | Single entry point. Formerly `api/`. |
| `services/clinics-service` | Clinics, specialties and service catalog (`clinics_db`). |
| `services/users-service` | Users, professionals and patients (`users_db`). |
| `services/appointments-service` | Schedules, appointments and clinical notes (`appointments_db`). |
| `services/audit-service` | Append-only audit log (`logs_db`). |
| `packages/*` | Shared libraries, for example `@medicitas/http` (startup, logger, errors) and `@medicitas/auth` (JWT 401/403). |

Services import the shared packages by name, for example `@medicitas/http`.
`npm run build:packages` compiles them; the root `build`, `typecheck` and
`test` scripts run it first.

## Set the port

`API_INTERNAL_PORT` is required. It must be a whole number from 1 to 65535.
Each service reads it from its own environment, so in Docker every container
can use the same value.

## Start a service locally

From the repository root:

```powershell
npm install
npm run build:packages
npm run dev -w services/edge-gateway
```

To run two services at once, give each one a different port, for example
`$env:API_INTERNAL_PORT=3001; npm run dev -w services/clinics-service`.

The services are not in `docker-compose.yml` yet (card N1). One Dockerfile
builds any of them from the repository root:

```powershell
docker build -f services/Dockerfile --build-arg SERVICE=edge-gateway -t medicitas/edge-gateway .
```

## Check the routes

Open these addresses while the gateway is running:

| Address | Expected response |
| --- | --- |
| http://localhost:3000/ | `Hello World!` (200) |
| http://localhost:3000/health | `{"status":"ok"}` (200) |

The other services answer `{"status":"ok","service":"<name>"}` on `/health`.
`/health` does not check the database or identity service.

## Run the tests

From the repository root:

```powershell
npm run typecheck
npm test
```

`typecheck` builds the shared packages and checks TypeScript in every
workspace. `npm test` builds the shared packages, then runs each workspace's
tests once. The gateway's tests still remove its `dist` folder and build fresh
JavaScript first, so the startup tests launch the new build.

Two empty placeholders are excluded until they get real tests:
`packages/auth/tests/test.ts` (card J1) and
`services/appointments-service/tests/race/test.ts` (card E6).

To run one workspace only: `npm test -w services/edge-gateway`.

## Stop

Press `Ctrl+C` in the terminal running the service.
