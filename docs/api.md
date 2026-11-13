# MediCitas API contract (J5)

**English** · [Español](api.es.md)

## API architecture

Domain routes use HTTP/JSON and are grouped by responsibility: appointments
contains scheduling, booking and appointment queries; audit reads the separate
log database. Booking obtains catalog and patient information through injected
dependencies before its database transaction, keeping external lookups outside
that transaction. Some of the endpoints those adapters call are still pending (see below).

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
| clinics: service catalog (RF3) | Yes | `serviceCatalog: { db }` | Yes: clinics DB and verified Bearer | No end-to-end path |
| clinics: specialties (RF4 reference data) | Yes | `serviceCatalog: { db }` | Yes: same clinics DB and Bearer verification | No end-to-end path |
| users: professional registration (RF4 partial) | Yes | `professionals: { db, specialties }` | Yes: users DB, `CLINICS_SERVICE_URL` and verified Bearer | No end-to-end path |
| appointments: working hours and blocks (RF5-RF6) | Yes | `schedule: { db, directory }` | Yes: appointments DB, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` and verified Bearer | No end-to-end path |
| appointments: availability (RF7-RF8) | Yes | `availability: { db, catalog, directory }` | Yes: appointments DB, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` and verified Bearer; Redis cache when `REDIS_URL` is set | No end-to-end path |
| appointments: booking, retrieval and lifecycle (RF9-RF13) | Yes | `booking: { db, catalog, patients }` | Yes: appointments DB, `CLINICS_SERVICE_URL`, `USERS_SERVICE_URL` and verified Bearer | No end-to-end path |
| appointments: patient history (RF16) | Yes | `patientHistory: { db }` | Yes: appointments DB and verified Bearer | No end-to-end path |
| appointments: clinical note (RF15) and its audit events (RF18 producer) | Yes | `clinicalNotes: { db }` | Yes: appointments DB and verified Bearer | No end-to-end path |
| appointments: daily agenda (RF20) | Yes | `dailyAgenda: { db, clinics }` | Yes: appointments DB, `CLINICS_SERVICE_URL` and verified Bearer | No end-to-end path |
| appointments: counts (RF21) | Yes | `appointmentCounts: { db }` | Yes: same appointments startup and verified Bearer | No end-to-end path |
| audit: log query (RF19) | Yes | `auditQuery: { db }` | Yes: creates a logs database connection and requires Bearer | No end-to-end path |

RF4 service associations remain pending. Compose currently starts
PostgreSQL, Keycloak and Redis, without HTTP services.

**appointments-service dependencies.** Booking, availability and schedules call
other services with the caller's Bearer token, before any transaction opens:

| Call | Used for | Status today |
| --- | --- | --- |
| clinics `GET /services/:serviceId` | Duration, clinic time zone and `isActive` | Exists, but returns 403 to receptionist and professional tokens |
| users `GET /professionals/:professionalId` | The professional belongs to the clinic | Not implemented yet |
| users `GET /patients/:patientId` | The patient belongs to the clinic; only `patientId` is read | Not implemented yet (RF14) |

A 404 from those services is answered as 404. Any other failure (403, 5xx,
timeout, unusable body) is answered as 503 `dependency_unavailable`.

## Identity, permissions and shared formats

- RF3 and the RF4 routes below verify Bearer and derive tenant context from it.
- Every appointments-service route and RF19 verify `Authorization: Bearer <access_token>`
  when mounted without a `resolveContext` override, which only tests pass.
  MediCitas has no login endpoint. `x-test-context` is test-only.
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
- RF3, professional registration, booking, rescheduling, cancellation, outcome, RF19 and RF21 use strict objects:
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

Health does not check PostgreSQL, Keycloak or Redis readiness. Clinics, users and audit
need valid database configuration to start normally, even to serve health.
Users also requires `CLINICS_SERVICE_URL`.

## Service catalog (clinics-service, RF3)

Access: `clinic_admin` only. POST/GET/PUT/DELETE use `service:create`,
`service:read`, `service:update` and `service:delete`, respectively.
Clinic and identity come only from the verified Bearer.

| Method and route | Successful output |
| --- | --- |
| `POST /services` | 201 `Service`, active; `Location: /services/:serviceId` |
| `GET /services` | 200 `Service[]`, active only, ordered by name then ID |
| `GET /services/:serviceId` | 200 `Service`, including retired services of the clinic |
| `PUT /services/:serviceId` | 200 updated `Service`; inactive services return 404 |
| `DELETE /services/:serviceId` | 204; sets `isActive: false`, preserving the row; repeats also return 204 |

POST/PUT require exactly `{ name, durationMinutes, specialtyId }`: trimmed name
of 1-128 characters, integer duration 1-2147483647 and an existing specialty UUID.
`Service = { serviceId, name, durationMinutes, specialtyId, isActive, timeZone }`;
`isActive` is output-only and `timeZone` comes from the clinic. PUT cannot reactivate.
Extra fields or any query return 422 `invalid_request`; missing specialties return
422 `invalid_reference`. Names remain unique within the clinic after retirement
(409 `duplicate`). Malformed, unknown or other-clinic IDs return 404 `not_found`.

Retirement does not change appointments or `professional_service` associations.
RF4 service associations remain pending. appointments-service rejects new
bookings and availability of an inactive service with 422 `service_inactive`, and
still reschedules existing appointments of it. Internal catalog authorization is
pending: this read returns 403 for receptionist/professional tokens, which
appointments-service answers as 503 `dependency_unavailable`.

## Professional registration (RF4 partial)

Both routes require `clinic_admin` with `professional:create`. The specialties
catalog supports registration without granting service-management permissions.

| Owner | Method and route | Input | Successful output |
| --- | --- | --- | --- |
| clinics | `GET /specialties` | No query | 200 `[{ specialtyId, name }]`, global, ordered by name then ID |
| users | `POST /professionals` | `{ appUserId, fullName, specialtyIds }` | 201 `{ professionalId, appUserId, fullName, isActive: true, specialtyIds }` |

The body is strict: UUID appUserId, trimmed fullName of 1-128 characters, and a
nonempty array of distinct specialty UUIDs. No query parameters are accepted.
The existing app_user must be active, have role `professional` and belong to the
verified context's clinic. Users validates specialties through clinics before
its local transaction; the existing app_user and Keycloak account are unchanged.
Output specialtyIds are sorted canonical UUIDs. There is no profile-edit route.

Unknown/other-clinic users return 404 `not_found`; inactive/wrong-role users return
422 `invalid_professional_user`; unknown specialties return 422 `invalid_reference`;
invalid input returns 422 `invalid_request`; an existing profile returns 409
`duplicate`. Catalog failure, invalid response or its 5-second timeout returns
503 `catalog_unavailable` without local writes. Shared 401/403/errors also apply.

`CLINICS_SERVICE_URL` is the reachable clinics base URL. The client forwards the
original Bearer; both services verify it independently, so issuer/audience must
be valid for both. RF4 service assignment and specialty coverage checks remain
pending; registration does not provision identities or update Keycloak claims.

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
| `GET /availability/professionals/:professionalId` | `serviceId` UUID and local `date`; professional UUID in route | 200 `{ professionalId, serviceId, durationMinutes, timeZone, date, slots: Slot[] }` | 404 malformed route UUID or resource not in clinic according to dependencies; 422 `invalid_request`, `service_not_offered`, `service_inactive` or `invalid_availability_input` |
| `GET /availability` | `serviceId` UUID, local `from` and `to` dates | 200 `{ serviceId, durationMinutes, timeZone, from, to, professionals: [{ professionalId, days: [{ date, slots: Slot[] }] }] }` | 404 service not in clinic according to `catalog`; 422 `invalid_request` or `invalid_availability_input` |

`Slot = { startsAt: ISO, endsAt: ISO }`.
RF8 includes both dates, accepts at most 31 days and rejects reversed ranges.
Only professionals and days with available slots appear. When no slots exist,
RF7 returns `slots: []` and RF8 returns `professionals: []`, both with 200.

Availability subtracts blocks and `booked` appointments, uses service duration
and omits past starts. With `REDIS_URL` set, reads go through the Redis cache
([cache.md](cache.md)). A listed slot is not reserved.

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
| **422 invalid request** | `{"error":"Request rejected.","code":"invalid_request"}` for an invalid body or extra fields; other rule codes: `starts_in_past`, `service_inactive`, `service_not_offered`, `professional_unavailable`, `outside_working_hours` |

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

## Clinical note (appointments-service, RF15)

A route `appointmentId` UUID is required. Only the professional of the appointment
may use these routes. Bodies are strict.

| Method and route | Permission | Body | Successful output | Specific rejections |
| --- | --- | --- | --- | --- |
| `POST /appointments/:appointmentId/note` | `clinical-note:create`: professional | `{ content }`; trimmed string, 1-20000 characters | 201 with `ClinicalNote` | 409 `note_exists`; 422 `invalid_request` or `appointment_not_attended` |
| `GET /appointments/:appointmentId/note` | `clinical-note:read`: professional | None | 200 with `ClinicalNote` | 404 `not_found` when the appointment has no note yet |
| `PUT /appointments/:appointmentId/note` | `clinical-note:update`: professional | `{ content }`, same rules | 200 with `ClinicalNote` and a new `updatedAt` | 404 `not_found` when the appointment has no note yet; 422 `invalid_request` |

```text
ClinicalNote = {
  clinicalNoteId: UUID, appointmentId: UUID, professionalId: UUID,
  content: string, createdAt: ISO, updatedAt: ISO
}
```

- **403 `forbidden`** for reception, clinic administrators and any professional other
  than the one of the appointment. RLS also hides the note from them.
- **404 `not_found`** for a malformed UUID or an appointment of another clinic.
- **One note per appointment.** Two simultaneous POSTs give one 201 and one 409.

**Audit (RF18, producer side).** Every successful POST, GET and PUT inserts an
`AuditRecorded` event in the `outbox` table of `appointments_db`, in the same
transaction. If the event cannot be stored, the request fails and the note is
neither written nor returned. Rejected requests (403, 404, 409, 422) record nothing.
The event payload is
`{ appUserId, patientId, action: "create"|"read"|"update", resource: "clinical_note", resourceId, occurredAt }`;
it never contains the note text. Copying the events into `audit_log` in
`logs_db` is the relay's job (card N10), which is not implemented yet.

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

## Daily agenda (appointments-service, RF20)

| Method and route | Access |
| --- | --- |
| `GET /agenda?date=YYYY-MM-DD` | clinic_admin, receptionist |
| `GET /agenda/professionals/:professionalId?date=YYYY-MM-DD` | clinic_admin, receptionist; professional for own ID only |

Both require verified Bearer and exactly one valid calendar `date`, in the clinic's
stored IANA zone. `CLINICS_SERVICE_URL` supplies `GET /clinic/time-zone` using the
same Bearer; clinic/role/zone cannot be selected through query fields or headers.
200 returns `{ date, timeZone, professionalId: UUID|null, appointments: [...] }`;
each entry has `{ appointmentId, professionalId, patientId, serviceId, startsAt,
endsAt, status }`, with UTC timestamps. All current states and intervals overlapping
the local day are included, ordered by start, professional ID, then appointment ID.
No visible rows returns `appointments: []`, including an unknown/other-clinic
professional. Shared 401/403 apply; malformed authorized route IDs return 404,
invalid/extra query fields return 422, and unavailable/invalid clinic settings
return 503 `clinic_unavailable`.

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
| 503 | Dependency failure: `{"error":"Service unavailable.","code":"timeout"}`, `database_unavailable` or `dependency_unavailable` (another MediCitas service), with `Retry-After: 1` |
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
details belong to J7. RF4 registration is implemented; its service-assignment
contract remains pending. No operational HTTP contract exists yet for RF1-RF2,
**RF14** (patient registration/update), RF18 (the relay that copies audit events
into `logs_db`).
