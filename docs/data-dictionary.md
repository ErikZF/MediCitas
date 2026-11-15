# Data dictionary

**English** · [Español](data-dictionary.es.md)

Physical columns of the four PostgreSQL 18 databases. `Null` means SQL NULL is allowed;
PK columns are required. PK = primary key, UNIQUE = uniqueness constraint, FK = a
foreign key enforced inside one database. A logical reference has no cross-database FK.
`TIME` is local time without a zone; `TIMESTAMPTZ` stores an instant.

## New and existing databases

Compose runs each database's `init.sql` and `seed.sql` only on an empty volume.
The dictionary includes the ALTER statements at the end of `init.sql`, so new
databases already have the onboarding fields. Existing volumes keep their schema.

| Existing database change | SQL file |
| --- | --- |
| Clinic pending administrator fields | [upgrade-registration.sql](../database/updates/clinics/upgrade-registration.sql) |
| Service `is_active` and DELETE revoked from `medicitas_app` | [upgrade-service-soft-delete.sql](../database/updates/clinics/upgrade-service-soft-delete.sql) |
| User `is_first_admin` and partial unique index | [upgrade-first-admin.sql](../database/updates/users/upgrade-first-admin.sql) |
| Patient audit outbox, then relay access | [upgrade-patient-audit-outbox.sql](../database/updates/users/upgrade-patient-audit-outbox.sql), then [upgrade-audit-relay.sql](../database/updates/users/upgrade-audit-relay.sql) |
| Appointment duration limit and indexes | [appointments/upgrade-e10-indexes.sql](../database/updates/appointments/upgrade-e10-indexes.sql) |
| Audit query indexes | [logs/upgrade-e10-indexes.sql](../database/updates/logs/upgrade-e10-indexes.sql) |

These are targeted updates, with no automatic migration runner. Adding
`is_first_admin` sets existing rows to `false`; it does not identify the original
administrator automatically.
The users outbox upgrade, when it creates the table, uses PK `event_id` and default
`gen_random_uuid()`. A new database uses PK (`clinic_id`, `event_id`) and `uuidv7()`.
`CREATE TABLE IF NOT EXISTS` preserves whichever table already exists; neither
upgrade converts that key/default to the new form. The other required tables and
columns must already exist before applying these targeted updates.

For updated grants on existing `users_db` volumes, see
[database roles](database.md#least-privilege-database-roles).

Drizzle files are query mappings, not complete DDL. For example, `is_first_admin`
is accessed by raw SQL and `appointment_status` uses its SQL default; neither
appears in its table's Drizzle column mapping.

## `clinics_db`

Schema: [database/clinics/init.sql](../database/clinics/init.sql).

### `clinic`

Clinic identity and onboarding state. PK: `clinic_id`. UNIQUE: `identifier`.

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `clinic_id` | `UUID` | No | Clinic ID; default `uuidv7()`. |
| `identifier` | `VARCHAR(32)` | No | Business identifier, unique across clinics. |
| `name` | `VARCHAR(128)` | No | Clinic name. |
| `time_zone` | `TEXT` | No | Clinic time zone; the API validates the IANA name. |
| `is_active` | `BOOLEAN` | No | Active flag; default `true`. Pending onboarding uses `false`. |
| `bootstrap_admin_id` | `UUID` | Yes | Planned first administrator ID; logical reference to `users_db.app_user`. |
| `bootstrap_username` | `VARCHAR(128)` | Yes | Username for pending Keycloak provisioning. |

The last two fields are cleared when onboarding activates the clinic.

### `specialty`

Global specialty catalog. PK: `specialty_id`. UNIQUE: `name`.

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `specialty_id` | `UUID` | No | Specialty ID; default `uuidv7()`. |
| `name` | `VARCHAR(128)` | No | Unique specialty name. |

### `service`

Service offered by one clinic. PK: (`clinic_id`, `service_id`). UNIQUE: (`clinic_id`, `name`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `service_id` | `UUID` | No | Service ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | FK to `clinic.clinic_id`. |
| `specialty_id` | `UUID` | No | FK to `specialty.specialty_id`. |
| `name` | `VARCHAR(128)` | No | Service name within the clinic. |
| `duration_minutes` | `INT` | No | Service duration; CHECK greater than 0. |
| `is_active` | `BOOLEAN` | No | Available for new bookings; default `true`. |

Retirement keeps the row and its name reserved within the clinic.

## `users_db`

Schema: [database/users/init.sql](../database/users/init.sql).

### `role`

Domain role catalog. PK: `role_code`.

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `role_code` | `VARCHAR(32)` | No | Seeded roles: `platform_admin`, `clinic_admin`, `receptionist`, `professional`. |
| `description` | `VARCHAR(128)` | No | Role description. |

### `app_user`

Mapping from a Keycloak identity to its clinic and domain role. PK: `app_user_id`. UNIQUE: `keycloak_sub`.

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `app_user_id` | `UUID` | No | Domain user ID; default `uuidv7()`. |
| `keycloak_sub` | `TEXT` | No | External identity subject. Passwords stay in Keycloak. |
| `clinic_id` | `UUID` | Yes | Logical reference to `clinics_db.clinic`; null exactly for `platform_admin` (CHECK). |
| `role_code` | `VARCHAR(32)` | No | FK to `role.role_code`. One role per user. |
| `is_active` | `BOOLEAN` | No | Logical activation/deactivation; default `true`. |
| `is_first_admin` | `BOOLEAN` | No | Marks the bootstrap administrator; default `false`. |

Partial UNIQUE index on `clinic_id WHERE is_first_admin`: at most one marked user per clinic. It does not itself check that the role is `clinic_admin`.

### `professional`

Professional profile associated with an application user. PK: (`clinic_id`, `professional_id`). UNIQUE: (`clinic_id`, `app_user_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | Professional ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `app_user_id` | `UUID` | No | FK to `app_user.app_user_id`. |
| `full_name` | `VARCHAR(128)` | No | Professional name used by the domain. |
| `is_active` | `BOOLEAN` | No | Profile active flag; default `true`. |

The FK covers only `app_user_id`. Registration checks the user clinic, role and active state in application code.

### `professional_specialty`

Specialties assigned to a professional. PK: (`clinic_id`, `professional_id`, `specialty_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | Professional in the composite FK below. |
| `specialty_id` | `UUID` | No | Logical reference to `clinics_db.specialty`. |
| `clinic_id` | `UUID` | No | Clinic in the composite FK below. |

FK (`clinic_id`, `professional_id`) to `professional`, with `ON DELETE CASCADE`.

### `patient`

Patient record owned by one clinic. PK: (`clinic_id`, `patient_id`). UNIQUE: (`clinic_id`, `identification`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `patient_id` | `UUID` | No | Patient ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `identification` | `VARCHAR(32)` | No | Identification document, unique within the clinic. |
| `full_name` | `VARCHAR(128)` | No | Patient name. |
| `birth_date` | `DATE` | No | Date of birth; the API validates it as nonfuture. |
| `phone` | `VARCHAR(32)` | Yes | Optional contact phone. |
| `email` | `VARCHAR(128)` | Yes | Optional contact email. |

### `outbox`

Events committed with the local operation. PK: (`clinic_id`, `event_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `event_id` | `UUID` | No | Event ID; default `uuidv7()` in a new database. |
| `clinic_id` | `UUID` | No | Clinic owning the event. |
| `aggregate_id` | `UUID` | No | Logical reference to the patient. |
| `event_type` | `VARCHAR(64)` | No | Patient-contact `AuditRecorded` events. |
| `payload` | `JSONB` | No | Event data; audit events omit note text and contact values. |
| `created_at` | `TIMESTAMPTZ` | No | Queue insertion instant; default `now()`. |
| `published_at` | `TIMESTAMPTZ` | Yes | Null while pending; set after relay processing. |

No physical FK. Producers insert; relays read and mark events published.

## `appointments_db`

Schema: [database/appointments/init.sql](../database/appointments/init.sql).

### `working_hours`

One recurring weekly shift; several rows allow split shifts. PK: (`clinic_id`, `working_hours_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `working_hours_id` | `UUID` | No | Shift ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Logical reference to `users_db.professional`. |
| `weekday` | `SMALLINT` | No | CHECK 0 (Sunday) through 6 (Saturday). |
| `start_time` | `TIME` | No | Local shift start. |
| `end_time` | `TIME` | No | Local shift end; CHECK `start_time < end_time`. |

`no_overlap_working_hours` excludes overlapping `[start_time, end_time)` shifts for the same clinic, professional and weekday. Shifts do not cross midnight.

### `schedule_block`

Dated leave or other agenda block. PK: (`clinic_id`, `schedule_block_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `schedule_block_id` | `UUID` | No | Block ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Logical reference to `users_db.professional`. |
| `starts_at` | `TIMESTAMPTZ` | No | Block start. |
| `ends_at` | `TIMESTAMPTZ` | No | Block end; CHECK `starts_at < ends_at`. |
| `reason` | `VARCHAR(256)` | Yes | Optional reason. |

Blocks can overlap each other. The API lists conflicting booked appointments without cancelling them.

### `professional_service`

Service assignment and its recorded specialty. PK: (`clinic_id`, `professional_id`, `service_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `professional_id` | `UUID` | No | Logical reference to `users_db.professional`. |
| `service_id` | `UUID` | No | Logical reference to `clinics_db.service`. |
| `clinic_id` | `UUID` | No | Clinic owning the assignment. |
| `specialty_id` | `UUID` | No | Specialty copied from the service when assigned. |

No physical FK on this table. Booking/availability compare the stored specialty with the current catalog.

### `appointment`

One booking and its current outcome/lifecycle state. PK: (`clinic_id`, `appointment_id`). UNIQUE: (`clinic_id`, `rescheduled_from_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `appointment_id` | `UUID` | No | Appointment ID; default `uuidv7()`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `professional_id` | `UUID` | No | Logical reference to `users_db.professional`. |
| `patient_id` | `UUID` | No | Logical reference to `users_db.patient`. |
| `service_id` | `UUID` | No | Logical reference to `clinics_db.service`. |
| `starts_at` | `TIMESTAMPTZ` | No | Appointment start. |
| `ends_at` | `TIMESTAMPTZ` | No | Stored end derived from start and duration. |
| `duration_minutes` | `INT` | No | Service-duration snapshot; CHECK 1 through 1440. |
| `status` | `VARCHAR(16)` | No | CHECK: `booked`, `attended`, `no_show`, `cancelled`, `rescheduled`; default `booked`. |
| `cancel_reason` | `VARCHAR(256)` | Yes | Cancellation reason. |
| `cancelled_by` | `UUID` | Yes | Logical reference to the cancelling `users_db.app_user`. |
| `rescheduled_from_id` | `UUID` | Yes | Previous appointment; composite FK with `clinic_id` to `appointment`. |
| `created_by` | `UUID` | No | Logical reference to the creating `users_db.app_user`. |
| `created_at` | `TIMESTAMPTZ` | No | Creation instant; default `now()`. |
| `status_changed_at` | `TIMESTAMPTZ` | No | Current status-change instant; default `now()`. |
| `status_changed_by` | `UUID` | Yes | Logical reference to the actor of the status change. |
| `updated_at` | `TIMESTAMPTZ` | No | Last update instant; default `now()`, maintained by trigger. |

CHECK: start before end and end equal to start plus `duration_minutes` minutes. Two EXCLUDE constraints prevent overlaps of `booked` rows by professional or patient within the clinic. Only `booked` can leave its state; the trigger rejects transitions from final states. The nullable replacement reference permits multiple nulls but at most one replacement per original appointment.

### `clinical_note`

Clinical note of an appointment. PK: (`clinic_id`, `clinical_note_id`). UNIQUE: (`clinic_id`, `appointment_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `clinical_note_id` | `UUID` | No | Note ID; default `uuidv7()`. |
| `appointment_id` | `UUID` | No | Appointment in the composite FK with `clinic_id`. |
| `clinic_id` | `UUID` | No | Clinic in the FK to `appointment`. |
| `professional_id` | `UUID` | No | Logical reference to `users_db.professional`; used by RLS. |
| `appointment_status` | `VARCHAR(16)` | No | Default and CHECK: `attended`. |
| `content` | `TEXT` | No | Clinical note text. |
| `created_at` | `TIMESTAMPTZ` | No | Creation instant; default `now()`. |
| `updated_at` | `TIMESTAMPTZ` | No | Last update; default `now()`, maintained by trigger. |

The FK checks appointment membership in the same clinic. The constant `appointment_status` does not check the parent status; the API checks that the appointment is attended and belongs to the professional before creating a note.

### `idempotency_keys`

Reserved response store; the API does not use it. PK: (`clinic_id`, `key`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `clinic_id` | `UUID` | No | Clinic scope; logical reference to `clinics_db.clinic`. |
| `key` | `VARCHAR(128)` | No | Client idempotency key. |
| `request_hash` | `VARCHAR(64)` | No | Request fingerprint. |
| `response_status` | `SMALLINT` | No | Stored HTTP status. |
| `response_body` | `JSONB` | No | Stored response body. |
| `created_at` | `TIMESTAMPTZ` | No | Creation instant; default `now()`. |
| `expires_at` | `TIMESTAMPTZ` | No | Expiry; default `now() + 24 hours`. |

### `outbox`

Events committed with the local operation. PK: (`clinic_id`, `event_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `event_id` | `UUID` | No | Event ID; default `uuidv7()` in a new database. |
| `clinic_id` | `UUID` | No | Clinic owning the event. |
| `aggregate_id` | `UUID` | No | Logical reference to the professional (`AgendaChanged`) or note (`AuditRecorded`). |
| `event_type` | `VARCHAR(64)` | No | `AgendaChanged` or `AuditRecorded`. |
| `payload` | `JSONB` | No | Event data; audit events omit note text and contact values. |
| `created_at` | `TIMESTAMPTZ` | No | Queue insertion instant; default `now()`. |
| `published_at` | `TIMESTAMPTZ` | Yes | Null while pending; set after relay processing. |

No physical FK. Producers insert; relays read and mark events published. A partial index on `created_at` covers pending events.

## `logs_db`

Schema: [database/logs/init.sql](../database/logs/init.sql).

### `audit_log`

Append-only record of sensitive data access. PK: (`clinic_id`, `audit_log_id`).

| Column | SQL type | Null | Meaning / relationship |
| --- | --- | --- | --- |
| `audit_log_id` | `UUID` | No | Default `uuidv7()`; the relay supplies the source `event_id`. |
| `clinic_id` | `UUID` | No | Logical reference to `clinics_db.clinic`. |
| `app_user_id` | `UUID` | No | Actor; logical reference to `users_db.app_user`. |
| `patient_id` | `UUID` | No | Patient concerned; logical reference to `users_db.patient`. |
| `action` | `VARCHAR(16)` | No | CHECK: `read`, `create`, `update`. |
| `resource` | `VARCHAR(32)` | No | CHECK: `clinical_note`, `patient_contact`. |
| `resource_id` | `UUID` | No | Logical note ID or patient ID, according to `resource`. |
| `occurred_at` | `TIMESTAMPTZ` | No | Access instant; default `now()`. |

Triggers reject UPDATE, DELETE and TRUNCATE. No cross-database FK is declared.
