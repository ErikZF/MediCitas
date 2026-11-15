# MediCitas demo in Postman

**English** · [Español](README.es.md)

## Local environment

1. Start Compose as in the [README](../README.md#local-startup). The gateway on port 3000
   forwards domain routes. This collection uses direct service URLs on ports
   3001-3004, so apply the README port override before using it unchanged.
   Alternatively, set `clinicsUrl`, `usersUrl`, `appointmentsUrl` and `auditUrl`
   to the gateway URL locally for domain calls, and skip the four service-health
   requests: `/health` on the gateway only reports gateway health.
2. Import [the safe environment example](environments/medicitas.local.example.postman_environment.json)
   into Postman, duplicate it as **MediCitas Local**, and select the duplicate.
   Host URLs assume ports 3000-3004 and Keycloak 8080; adjust to your local mappings.
3. Fill tokens and `initialPassword` only in local values. Do not share/sync secrets
   or export a populated environment into Git. If a disk copy is needed, use
   `postman/environments/medicitas.local.postman_environment.json` (ignored).
   Keep the versioned example unchanged, with empty secret values.

## Tokens

MediCitas has no login route. After `keycloak-seed` exits successfully, use a local,
unsaved Postman request to Keycloak:

```text
POST {{keycloakUrl}}/realms/{{realmName}}/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
client_id={{testClientId}}
username=<seed user below>
password=<your local KEYCLOAK_TEST_PASSWORD>
```

Use the actual local `.env` values if realm/client/port differ. The test client is
public and enables direct grants; it needs no client secret. Copy only the returned
`access_token` into the matching local variable, **without `Bearer `**:

| Seed user | Local token variable | Scope |
| --- | --- | --- |
| `platform.admin` | `platformAdminToken` | Clinic onboarding only |
| `admin.sj` | `clinicAdminToken` | Clinic 1 administration and audit |
| `reception.sj` | `receptionistToken` | Clinic 1 patients and appointments |
| `dr.mora` | `professionalToken` | Clinic 1 professional `professionalId` |

The example UUIDs come from Clinic 1 SQL seeds. `clinicId` documents their scope;
requests derive the clinic from the token, not from that variable. Tokens need the
configured issuer/audience and domain claims (see [API](../docs/api.md)). Reissue
expired tokens and tokens affected by role/profile changes. Never use the Keycloak
administration-console token for domain calls.

## Demo data

Import [MediCitas Demo](collections/medicitas-demo.postman_collection.json) as a
collection. Send requests individually, in folder order; optional onboarding and
administration folders create extra data and are not prerequisites for seeded
appointment calls. Run folder 90 cleanup last. Do not run the whole collection
unattended. Stop on an unexpected response or unresolved/empty variable.
Response scripts check the expected status and capture created UUIDs only after
success; a failed creation clears its output variables. Set them manually only
from a confirmed response. Never resend a booking to recover a lost ID.

Use disposable local data. Choose unique clinic identifiers, usernames, service
names and patient identifications before creating resources. Set `initialPassword`
locally (12-256 characters); it is used for provisioning, never stored in the template.
The empty `demo*`/`managedUserId` variables are reserved for resources created during
the demo, separate from seeded IDs. `appointmentAId` and `replacementAId` start empty.
Dates and instants are deliberate placeholders: select future dates in the clinic's
zone and free slots from availability; use ISO instants with `Z` or an offset.
Use `Z` or negative offsets for range variables in query strings; encode a positive
`+` as `%2B`. RF8 accepts at most 31 calendar dates, including both bounds.

The [REST Client walkthrough](../requests/demo.http) is an alternative client,
not a prerequisite. Expected responses are documented in the [contract](../docs/api.md).

## Appointment and audit walkthrough

After health and seeded catalog/patient reads, use folders 05-09:

1. Read working hours/blocks and availability. Set `startsA` to a future slot on
   `dayFrom`, and `replacementStartsA` to a different free, non-overlapping slot.
   Both patients must belong to Clinic 1; `conflictPatientId` must be free then.
2. Reserve A once: **201** captures `appointmentAId`. Check availability again.
   Before releasing A, request the same professional/start for the other patient:
   **409 `slot_taken`**. The request with extra `durationMinutes` demonstrates
   **422 `invalid_request`**. Keep `startsA` unchanged and future throughout.
3. Reschedule A: **201** captures `replacementAId`. Cancel the replacement:
   **200 cancelled**; repeat cancellation: **409 `invalid_transition`**.
   Verify the original slot is available again while it is still future.
4. Separately inspect `startedAppointmentId`: it must be booked, already started
   and owned by `dr.mora`. Only then mark it attended and create/read its note.
   Seed 804 starts on 2026-11-12; existing volumes may already have changed its state.
   This sequence needs a prepared appointment for each rerun. Never use cancelled A.
5. Query history, agendas and counts. Audit demonstrates missing token **401**,
   reception **403**, and clinic administrator **200**, with optional AND filters.
   A range containing seed event times can return rows; `[]` is also valid.

New contact/note events queue in their owner's outbox. At normal Compose startup,
audit-service relays them to `logs_db`, polling every second. Query again after
delivery, with a range that includes the new event time. Polling is asynchronous;
one second is not a delivery deadline. Collection descriptions that still say N10
is pending are outdated. The REST Client header also predates the proxy and relay.
The sequential 409 example does not replace the automated concurrent race proof.

The booking/cancellation sequence and the outcome/note sequence use different
appointments. Run them against a disposable prepared stack.
