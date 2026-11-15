# MediCitas demo in Postman

**English** · [Español](README.es.md)

## Local environment

1. Start Compose using the [README local port override](../README.md#local-startup).
   Default Compose publishes only the gateway, which has no domain proxy.
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
not a prerequisite. Expected responses are documented in the [contract](../docs/api.md);
this environment template alone does not establish a successful full-stack run.
