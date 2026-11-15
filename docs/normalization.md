# Normalization to third normal form

**English** · [Español](normalization.es.md)

MediCitas separates entity data to avoid repeating names, descriptions and contact
details in every booking. The [data dictionary](data-dictionary.md) lists columns
and SQL sources. The hypothetical examples explain the steps to 3NF; physical
redundancies are treated separately.

## 1. First normal form: one value per attribute

A professional can have several specialties. Storing `specialty_1`, `specialty_2`
or a comma-separated list in `professional` would make searches and updates harder.
Instead, `professional_specialty` stores one assignment per row, identified by
(`clinic_id`, `professional_id`, `specialty_id`).

The same approach applies to schedules: `working_hours` stores one weekday and time
interval per row. Two shifts on Monday are two rows, rather than repeating groups
of start/end columns. Patient name, birth date, phone and email are individual
attributes; the application treats `full_name` as one value.

These domain tables use scalar columns and primary keys to identify rows. Event
and response JSON documents have a separate purpose, described under exceptions.

## 2. Second normal form: depend on the whole key

In a table with a composite key, a non-key attribute must not depend on only part
of a candidate key. A candidate key is a minimal set that uniquely identifies a row;
adding a UUID alone does not prove normalization.

Consider a hypothetical service-assignment table keyed by
(`clinic_id`, `professional_id`, `service_id`) that also stores the professional's
name and the service's name and duration:

- (`clinic_id`, `professional_id`) → professional name.
- (`clinic_id`, `service_id`) → service name and current duration.

Those are partial dependencies. MediCitas puts the professional's name in
`professional` and the service name/duration in `service`. The assignment is kept
in `professional_service`; its copied `specialty_id` is an exception below.
`professional_specialty` contains only its three key attributes.

Patients have keys (`clinic_id`, `patient_id`) and (`clinic_id`, `identification`).
The name, birth date and contact details describe that clinic's patient record.
`identification` alone is not a key: two clinics can register the same document.

## 3. Third normal form: separate facts about other entities

After 2NF, non-key attributes should not determine other non-key attributes.
More precisely, for each nontrivial dependency X → A, X must be a superkey or A
must belong to a candidate key. MediCitas removes these transitive
dependencies from the core records:

- User → role code → role description. `app_user` keeps `role_code`; `role` keeps
  the description, so changing it does not require updating every user.
- User/service → clinic → clinic name and time zone. These clinic details stay
  in `clinic`, rather than being copied into users, services or appointments.
- Service → specialty → specialty name. `service` keeps `specialty_id` and
  `specialty` keeps the shared name.
- Appointment → patient → name and contact details; appointment → professional →
  name. Appointments keep references to the patient record and professional profile.

| Table | Determinant → attributes it determines |
| --- | --- |
| `clinic` | `clinic_id` or `identifier` → name, time zone, active state and pending onboarding fields. |
| `role` | `role_code` → `description`. |
| `specialty` | `specialty_id` or `name` → the other catalog attribute. |
| `app_user` | `app_user_id` or `keycloak_sub` → clinic, role, active state and `is_first_admin`. |
| `service` | (`clinic_id`, `service_id`) or (`clinic_id`, `name`) → specialty, duration, active state and the other service identifier/name. |
| `professional` | (`clinic_id`, `professional_id`) or (`clinic_id`, `app_user_id`) → name, profile active state and the other identifier. |
| `patient` | (`clinic_id`, `patient_id`) or (`clinic_id`, `identification`) → name, birth date, contact details and the other identifier. |
| `appointment` | (`clinic_id`, `appointment_id`) → participants, service, time interval, booked duration, state and change metadata. |

`working_hours` and `schedule_block` keep each shift/block's attributes under its
clinic-scoped key. `clinical_note` separates optional consultation text from the
booking; UNIQUE (`clinic_id`, `appointment_id`) permits at most one note per visit.
Passwords and identity credentials belong to Keycloak, outside these four databases.

For the core clinic, role, specialty, service and patient data, these dependencies
have candidate keys as determinants, supporting 3NF. The following exceptions
limit that conclusion in the physical schema.

## Deliberate redundancy and physical exceptions

| Case | Reason and limit |
| --- | --- |
| `clinic_id` in tenant tables | It scopes keys and lets RLS filter each row directly. Its presence alone does not violate 3NF: the SQL does not declare each raw UUID globally unique. In `professional`, clinic ownership repeats `app_user` ownership; registration checks they match, but the FK covers only `app_user_id`. |
| `professional_service.specialty_id` | It copies the service specialty at assignment time. Relative to the catalog dependency (`clinic_id`, `service_id`) → `specialty_id`, it repeats a fact determined by part of the assignment key, an exception to strict 2NF/3NF. Booking and availability require it to match the current catalog. A catalog change can leave it stale until reassignment; no FK synchronizes it. |
| `appointment.duration_minutes` | A historical snapshot. If a service changes from 30 to 45 minutes, earlier appointments keep their booked duration. The current service ID therefore does not determine every appointment's duration. Rescheduling creates a replacement using the current catalog duration. |
| `appointment.ends_at` | (`starts_at`, `duration_minutes`) → `ends_at`, although those inputs are not a key. Storing this derived value is a 3NF exception: it supplies the interval used by overlap constraints. A CHECK keeps start, duration and end consistent. |
| `clinical_note` | The copied `professional_id` supports direct RLS checks. `appointment_status` is always `attended`, a redundant constant. Its CHECK does not enforce the parent appointment's status or professional; the API checks both when creating the note. The constant prevents a strict 3NF claim for the full table. |
| Onboarding fields | `clinic.bootstrap_admin_id` and `bootstrap_username` retain pending provisioning data and are cleared on activation. `app_user.is_first_admin` marks the bootstrap administrator, with a partial unique index per clinic. |
| `outbox` and `audit_log` | They preserve event data. Outbox JSON carries routing/audit data, including repeated resource identifiers; `AgendaChanged` can include a list of dates. The audit log keeps actor, patient, resource and time as an append-only record. These event representations are outside the strict relational 3NF justification above. |
| `idempotency_keys` | It stores a response snapshot as JSON, outside the core entity model. The table exists, but the API does not use it. |

Cross-database references are logical: they have no physical FK. This affects
integrity enforcement, while the separation of entity facts remains the same.
See [database architecture](database.md#3-referential-integrity-in-microservices).

## New and existing databases

The delivered `init.sql` schemas include the appended ALTER statements. Existing
volumes need the applicable targeted updates; the users outbox upgrade creates
a different key/default from a new database. The
[data dictionary](data-dictionary.md#new-and-existing-databases) lists those differences.

Implementation details: [service assignment](../services/appointments-service/modules/service-associations/routes.ts),
[booking rules](../services/appointments-service/modules/booking/slot-rules.ts),
[booking](../services/appointments-service/modules/booking/booking.service.ts),
[rescheduling](../services/appointments-service/modules/booking/lifecycle.service.ts) and
[clinical notes](../services/appointments-service/modules/clinical-notes/clinical-note.service.ts).
