# MediCitas API contract (J5)

## API architecture

Domain routes use HTTP/JSON and are grouped by responsibility: appointments
contains scheduling, booking and appointment queries; audit reads the separate
log database. Booking obtains catalog and patient information through injected
dependencies before its database transaction, keeping external lookups outside
that transaction. Their real service adapters still need to be connected.

Identity is delegated to Keycloak so the domain API does not manage login or
credentials. Where Bearer verification is wired, the service derives the clinic
and role from the verified token. Permissions control actions, while PostgreSQL
Row-Level Security (RLS) enforces clinic access within database transactions.
Taking the clinic from identity prevents callers from selecting another tenant
through request fields; the authentication wiring limits below remain essential.

Availability is a snapshot, not a reservation. Booking therefore leaves the final
overlap decision to PostgreSQL constraints, which also apply to concurrent inserts.
The API exposes that distinction as 201 for a granted booking, 409 for a scheduling
conflict and 422 for invalid input or business rules. The gateway is the planned
public entry point, but currently serves only root/health and forwards no requests.

## Actual route availability

The routes below are relative to their **owning service**. There is no public
prefix or gateway proxy to them yet. A route implemented and tested through
`createApp(deps)` is not necessarily exposed by `npm run dev`.

| Service / feature | Implemented | Dependencies required to mount it in `createApp` | Enabled by normal `server.ts` startup | Compose / gateway |
| --- | --- | --- | --- | --- |
| All five services: `GET /health`; gateway: `GET /` | Yes | None to mount health | Yes, if the service starts successfully | Compose has no HTTP services; gateway only serves its two routes |
| appointments: working hours and blocks (RF5-RF6) | Yes | `schedule: { db, directory }` | No | No end-to-end path |
| appointments: availability (RF7-RF8) | Yes | `availability: { db, catalog, directory }` | No | No end-to-end path |
| appointments: booking, retrieval and lifecycle (RF9-RF13) | Yes | `booking: { db, catalog, patients }` | No | No end-to-end path |
| appointments: patient history (RF16) | Yes | `patientHistory: { db }` | No | No end-to-end path |
| appointments: counts (RF21) | Yes | `appointmentCounts: { db }` | No | No end-to-end path |
| audit: log query (RF19) | Yes | `auditQuery: { db }` | Yes: creates a logs database connection and requires Bearer | No end-to-end path |

`clinics-service` and `users-service` only expose health. Appointments still needs
real catalog/directory adapters and startup wiring. Compose currently starts
PostgreSQL, Keycloak and Redis, without HTTP services.

## Identity, permissions and shared formats

- RF16 and RF19 verify `Authorization: Bearer <access_token>` when mounted without
  a `resolveContext` override. MediCitas has no login endpoint.
- **Other appointments routes do not run `requiereToken` yet.** Mounting them and
  sending Bearer alone is insufficient: authentication must be wired first.
  Without a tenant context they return 401. `x-test-context` is test-only.
- The clinic comes from verified identity, never from body/query fields or
  `x-clinic-id` / `x-role` headers. Access is restricted to that clinic.
- Tokens need `exp`, `sub`, matching issuer/audience, a UUID `app_user_id` (or
  `user_id`), a domain role and a UUID `clinic_id` for clinic roles; professionals
  also need a UUID `professional_id`. The role is the valid `role` claim or the
  first recognized role in `realm_access.roles`. `platform_admin` has no clinic
  and cannot access the domain operations below.
- JSON bodies use `Content-Type: application/json`. Documented GET requests
  require no body. Route identifiers are UUIDs; malformed route IDs return
  **404**, not 422. UUIDs in bodies and queries are validated with 422.
- Input instants use ISO 8601 with `Z` or an explicit offset, for example
  `2027-01-04T09:00:00-06:00`; output timestamps use UTC with `Z`.
  Encode `+` as `%2B` in queries to preserve positive offsets.
- Availability dates use `YYYY-MM-DD` in the clinic's IANA time zone.
  Appointment and block intervals are `[start, end)`: back-to-back appointments
  do not overlap. The RF8 calendar-date range includes both endpoints.
- Booking, rescheduling, cancellation, outcome, RF19 and RF21 use strict objects:
  extra fields produce 422. Working-hours, block and availability schemas strip
  unknown fields; those fields cannot change the clinic. RF16 consumes no query
  filters.

Below, **clinic roles** means `clinic_admin`, `receptionist` and `professional`.
All mounted domain routes can return 401 for missing context, 403 for denied
access and the [shared errors](#shared-errors); additional cases are listed per route.

## Health and public root

No authentication, parameters or body; successful response: 200.

| Service | Method and route | Output |
| --- | --- | --- |
| edge-gateway | `GET /` | Text `Hello World!` |
| edge-gateway | `GET /health` | `{"status":"ok"}` |
| clinics-service | `GET /health` | `{"status":"ok","service":"clinics-service"}` |
| users-service | `GET /health` | `{"status":"ok","service":"users-service"}` |
| appointments-service | `GET /health` | `{"status":"ok","service":"appointments-service"}` |
| audit-service | `GET /health` | `{"status":"ok","service":"audit-service"}` |

Health does not check PostgreSQL, Keycloak or Redis readiness. Audit needs valid
database configuration to start normally, even to serve health.

## Working hours and blocks (appointments-service, RF5-RF6)

Read: `clinic_admin`, `receptionist`, `professional` (`schedule:read`).
Write: `clinic_admin`, or `professional` for their own `professionalId`
(`schedule:manage`). Receptionists can only read.

| Method and route | Input | Successful output | Specific rejections |
| --- | --- | --- | --- |
| `GET /professionals/:professionalId/working-hours` | Route UUID | 200 `{ workingHours: WorkingHours[] }`, ordered by weekday and start time | 404 malformed UUID |
| `PUT /professionals/:professionalId/working-hours` | UUID and `{ workingHours: [{ weekday, startTime, endTime }] }` | 200 `{ workingHours: WorkingHours[] }`, stored and ordered | 404 professional not in clinic according to `directory`; 409 `schedule_overlap`; 422 `invalid_request` |
| `GET /professionals/:professionalId/blocks` | UUID; optional `from` and/or `to` query instants; if both, `from < to` | 200 `{ blocks: Block[] }`, ordered by start; only blocks overlapping the range | 404 malformed UUID; 422 `invalid_request` |
| `POST /professionals/:professionalId/blocks` | UUID and `{ startsAt, endsAt, reason? }`; start before end; optional reason is trimmed, 1-256 characters | 201 `{ block: Block, conflicts: Conflict[] }` | 404 professional not in clinic according to `directory`; 422 `invalid_request` |

`workingHours` accepts 0-42 entries; `weekday` is an integer from 0 (Sunday)
to 6 (Saturday). Times use `HH:MM` or `HH:MM:00`, with start before end;
`24:00` is allowed as an end time.
PUT transactionally replaces the entire week; `[]` clears it. On overlap,
rollback preserves the previous working hours.

```text
WorkingHours = { workingHoursId: UUID, weekday: number, startTime: "HH:MM", endTime: "HH:MM" }
Block        = { scheduleBlockId: UUID, professionalId: UUID, startsAt: ISO, endsAt: ISO, reason: string|null }
Conflict     = { appointmentId: UUID, patientId: UUID, startsAt: ISO, endsAt: ISO }
```

Creating a block returns overlapping `booked` appointments without cancelling
them. GET working-hours/blocks returns 200 with an empty list for a valid UUID
with no visible rows, including unknown or other-clinic professionals.

## Availability (appointments-service, RF7-RF8)

Access: all three clinic roles; `platform_admin` receives 403.

| Method and route | Required query | Successful output | Specific rejections |
| --- | --- | --- | --- |
| `GET /availability/professionals/:professionalId` | `serviceId` UUID and local `date`; professional UUID in route | 200 `{ professionalId, serviceId, durationMinutes, timeZone, date, slots: Slot[] }` | 404 malformed route UUID or resource not in clinic according to dependencies; 422 `invalid_request`, `service_not_offered` or `invalid_availability_input` |
| `GET /availability` | `serviceId` UUID, local `from` and `to` dates | 200 `{ serviceId, durationMinutes, timeZone, from, to, professionals: [{ professionalId, days: [{ date, slots: Slot[] }] }] }` | 404 service not in clinic according to `catalog`; 422 `invalid_request` or `invalid_availability_input` |

`Slot = { startsAt: ISO, endsAt: ISO }`.
RF8 includes both dates, accepts at most 31 days and rejects reversed ranges.
Only professionals and days with available slots appear. When no slots exist,
RF7 returns `slots: []` and RF8 returns `professionals: []`, both with 200.

Availability subtracts blocks and `booked` appointments, uses service duration
and omits past starts. Redis caching is not wired in. A listed slot is not reserved.

## Booking and retrieving an appointment (appointments-service, RF9)

### `POST /appointments`

Effective permission: `clinic_admin` or `receptionist` (`appointment:book`).
Required, strict body; `clinicId`, `endsAt` and `durationMinutes` are not accepted:

```json
{
  "professionalId": "9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03",
  "patientId": "b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06",
  "serviceId": "d4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08",
  "startsAt": "2027-01-04T09:00:00-06:00"
}
```

These UUIDs illustrate the request shape, not validated demo data. Duration and
end come from the service. The start must be in the future, the professional must
offer the service, and the interval must fit within one working-hours block
without crossing schedule blocks. Patient and service must belong to the clinic.

| Outcome | Response and meaning |
| --- | --- |
| **201 granted** | `Appointment` with `status: "booked"`, `cancelReason: null`, `rescheduledFromId: null`; includes stored ID, start, end and duration |
| **409 conflict** | `{"error":"Request rejected.","code":"slot_taken"}` for a professional overlap; `patient_overlap` when the patient already occupies that interval in the clinic |
| **422 invalid request** | `{"error":"Request rejected.","code":"invalid_request"}` for an invalid body or extra fields; other rule codes: `starts_in_past`, `service_not_offered`, `professional_unavailable`, `outside_working_hours` |

If several conflicts apply, their reporting order is not guaranteed. References
not found in the clinic can return 404; shared errors also apply.

**`Idempotency-Key` is not implemented.** Repeating a POST does not guarantee the
same response or recovery of a booking after a lost response.

### `GET /appointments/:appointmentId`

No body or query. Access: clinic roles (`appointment:read`). Returns 200 with
`Appointment`; 404 `not_found` for a malformed UUID or an invisible/unknown
appointment, including one from another clinic.

Shared DTO for booking, retrieval and lifecycle, with no wrapper:

```text
Appointment = {
  appointmentId: UUID, professionalId: UUID, patientId: UUID, serviceId: UUID,
  startsAt: ISO, endsAt: ISO, durationMinutes: number,
  status: "booked"|"attended"|"no_show"|"cancelled"|"rescheduled",
  cancelReason: string|null, rescheduledFromId: UUID|null
}
```

There is no implemented route for a general appointment listing.

## Appointment lifecycle (appointments-service, RF10-RF13)

A route `appointmentId` UUID is required. All bodies are strict.

| Method and route | Permission | Body | Successful output | Specific rejections |
| --- | --- | --- | --- | --- |
| `POST /appointments/:appointmentId/reschedule` | `appointment:reschedule`: clinic_admin, receptionist | `{ startsAt, professionalId? }`; start with offset, optional professional UUID | 201 with the new `Appointment` in `booked`, with `rescheduledFromId` equal to the previous ID | 409 `invalid_transition`, `slot_taken`, `patient_overlap`; 422 `invalid_request`, `appointment_started` and booking-rule errors |
| `POST /appointments/:appointmentId/cancel` | `appointment:cancel`: clinic_admin, receptionist | `{ reason }`; trimmed string, 1-256 characters | 200 with `Appointment` in `cancelled` and the reason | 409 `invalid_transition`; 422 `invalid_request` or `appointment_started` |
| `POST /appointments/:appointmentId/outcome` | `appointment:record-outcome`: clinic_admin, receptionist, professional for their own appointments only | `{ outcome: "attended" or "no_show" }` | 200 with `Appointment` in that state | 409 `invalid_transition`; 422 `invalid_request` or `appointment_not_started`; 403 for a professional acting on another professional's visible appointment |

All three return 404 for a malformed UUID or invisible/unknown appointment;
rescheduling can also return 404 for a service not found in the clinic.
Cancellation and rescheduling require `startsAt > now`; recording an outcome
requires `startsAt <= now`.

Only `booked` can transition to `rescheduled`, `cancelled`, `attended` or `no_show`;
all four are final states. There is no generic status PATCH. Rescheduling keeps
the patient and service, may change the professional, and recalculates duration/end
from the catalog. The old appointment becomes `rescheduled` and the new one is
created atomically: failure preserves the original booking. Use the **new ID**
afterwards; cancelled appointments cannot later become attended.

## Patient history (appointments-service, RF16)

`GET /patients/:patientId/appointments`, with no body or query filters.
Permission `appointment:read`: `clinic_admin`, `receptionist`, `professional`,
within their clinic. Professionals may read appointments of other professionals
in that clinic; this response includes neither clinical notes nor contact data.

200 returns an array directly:

```text
[{ appointmentId: UUID, professionalId: UUID, serviceId: UUID,
   startsAt: ISO, endsAt: ISO, status: string, rescheduledFromId: UUID|null }]
```

Includes all five current states and future appointments, ordered by `startsAt`,
then `appointmentId`, descending. Replaced appointments remain separate entries.
No visible appointments returns **200 `[]`**, including for an unknown patient
or one with appointments only in another clinic.

404 `not_found` for a malformed route UUID. Bearer/context errors follow the shared
rules. There are no date filters, pagination or history of status changes.

## Counts by status (appointments-service, RF21)

`GET /appointments/counts?from=<instant>&to=<instant>`, with no body.
Permission `appointment:count`: `clinic_admin` and `receptionist`. Both bounds are
required, with offsets and at most millisecond precision; `from < to` is compared
as absolute instants. The strict query rejects `clinicId`, `patientId`, etc.

200 returns this shape; zeroes illustrate a range with no appointments:

```json
{
  "counts": { "booked": 0, "attended": 0, "no_show": 0, "cancelled": 0, "rescheduled": 0 },
  "total": 0
}
```

Counts **current** states by `startsAt` in `[from, to)` within the clinic, not
transitions or creation/end time. All five counters and their sum are included.
A rescheduled appointment and its replacement count separately if both starts
fall within the range.

403 `forbidden` for professional/platform roles; 422 `invalid_request` for an
invalid range or extra fields.

## Audit log query (audit-service, RF19)

`GET /audit/logs`, with no body. Permission `audit:read`: `clinic_admin` only.
Optional strict query: `userId` UUID, `patientId` UUID, `from` and/or `to`
instants with offsets and at most millisecond precision. If both are supplied,
`from < to`; filters combine with AND. Without filters it returns all visible
clinic events; no pagination or result limit is implemented.

200 returns an array directly, ordered by `occurredAt`, then ID, ascending:

```text
[{ auditLogId: UUID, clinicId: UUID, userId: UUID, patientId: UUID,
   action: string, resource: string, resourceId: UUID, occurredAt: ISO }]
```

`userId` corresponds to the log's `app_user_id`, not Keycloak's `sub`.
The range filters `occurredAt`, including the lower bound and excluding the upper;
a single bound is allowed. No matches returns 200 `[]`.

403 `forbidden` for receptionist, professional or platform roles;
422 `invalid_request` for invalid or extra filters. User/patient existence is not
checked in other services. There is no audit POST, PUT or DELETE route; reading
events does not demonstrate RF18 production.

## Shared errors

These responses supplement each operation's specific codes. The first middleware,
validation or domain failure determines the response. Runtime strings are kept
verbatim below, including the two Spanish messages currently emitted by authentication.

| HTTP | Response / cause |
| --- | --- |
| 400 | `{"error":"Bad request."}` for malformed JSON |
| 401 | Missing context: `{"error":"Authentication required."}`. With `requiereToken`: `{"error":"falta el token de acceso"}` or `{"error":"token inválido o expirado"}` |
| 403 | Domain/permissions/RLS: `{"error":"Request rejected.","code":"forbidden"}` |
| 404 | Resource: `{"error":"Request rejected.","code":"not_found"}`. Missing or unmounted route: `{"error":"Route not found."}` |
| 409 | Route conflicts; the database adapter also maps `duplicate`, `overlap` and `concurrency_conflict` (transaction retries exhausted), with `error: "Request rejected."` |
| 413 | JSON body exceeds the parser limit: `{"error":"Request rejected."}` |
| 422 | `{"error":"Request rejected.","code":"<rule>"}`; in addition to listed rules, database mappings include `invalid_reference`, `missing_field`, `invalid_value`, `invalid_input` |
| 503 | Dependency failure: `{"error":"Service unavailable.","code":"timeout"}` or `database_unavailable`, with `Retry-After: 1` |
| 500 | Unexpected error: `{"error":"Internal server error."}`; invalid JWT configuration: `{"error":"Authentication unavailable."}` |

Errors do not expose internal messages, submitted values or SQLSTATE.
A 503 does not promise safe POST retries without idempotency.

## Demo collection

Stage 2 will provide the versioned request collection with environment setup,
service URLs and local token variables. It has not been created yet. Seed users
by role/clinic and the complete gateway/Compose path remain pending validation;
no real tokens or secrets belong in Git.

## Reviewed evidence and pending work

Cross-checked against code and existing tests; **no requests or tests were executed
during J5 stage 1**. Existing tests have partial scopes, including PostgreSQL and
mocked dependencies, without full-stack Keycloak/gateway validation. Coverage
details belong to J7. No operational HTTP contract exists yet for RF1-RF4,
**RF14** (patient registration/update), RF15 (clinical notes), RF18 (cross-service
audit production) or **RF20** (daily agenda).
