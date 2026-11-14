# Database Architecture (Microservices)

**English** · [Español](database.es.md)

In MediCitas, persistence is partitioned across 4 independent relational databases (PostgreSQL 17), designed for a microservices architecture implementing the **Database-per-Service** pattern.

---

## 1. Domain and Table Distribution

```mermaid
flowchart TD
    subgraph ClinicsService["Clinics DB (Port 5436)"]
        clinic[clinic]
        specialty[specialty]
        service[service]
        clinic --> service
        specialty --> service
    end

    subgraph UsersService["Users DB (Port 5434)"]
        role[role]
        app_user[app_user]
        professional[professional]
        prof_spec[professional_specialty]
        patient[patient]
        role --> app_user
        app_user --> professional
        professional --> prof_spec
    end

    subgraph AppointmentsService["Appointments DB (Port 5433)"]
        working_hours[working_hours]
        schedule_block[schedule_block]
        prof_serv[professional_service]
        appointment[appointment]
        clinical_note[clinical_note]
        appointment --> clinical_note
    end

    subgraph LogsService["Logs DB (Port 5435)"]
        audit_log[audit_log]
    end

    %% Logical References
    app_user -.->|logical clinic_id| clinic
    professional -.->|logical clinic_id| clinic
    prof_spec -.->|logical specialty_id| specialty
    patient -.->|logical clinic_id| clinic

    working_hours -.->|logical professional_id| professional
    schedule_block -.->|logical professional_id| professional
    prof_serv -.->|logical professional_id| professional
    prof_serv -.->|logical service_id| service
    appointment -.->|logical clinic_id| clinic
    appointment -.->|logical professional_id| professional
    appointment -.->|logical patient_id| patient
    appointment -.->|logical service_id| service

    audit_log -.->|logical clinic_id| clinic
    audit_log -.->|logical app_user_id| app_user
    audit_log -.->|logical patient_id| patient
```

---

## 2. Database Breakdown

### 1. Clinics Database (`clinics_db`)
- **Container:** `postgre_clinics_MediCitas`
- **Default External Port:** `5436` (internal `5432`)
- **Init Script:** `database/clinics/init.sql`
- **Responsibility:** Clinic branches, medical specialties catalog, and healthcare services catalog offered by each clinic.
- **Tables:**
  - `clinic`: Branch or clinic metadata (identifier, name, time zone, active status).
  - `specialty`: Global catalog of medical specialties (Cardiology, Pediatrics, etc.).
  - `service`: Healthcare service catalog per clinic with duration in minutes, associated with a specialty.

### 2. Users Database (`users_db`)
- **Container:** `postgre_users_MediCitas`
- **Default External Port:** `5434` (internal `5432`)
- **Init Script:** `database/users/init.sql`
- **Responsibility:** Identity mapping, domain roles, healthcare professional profiles, and patient registry.
- **Tables:**
  - `role`: System roles (`platform_admin`, `clinic_admin`, `receptionist`, `professional`).
  - `app_user`: Link between Keycloak identity (`keycloak_sub`) and the domain role/clinic.
  - `professional`: Healthcare professional profile (physicians, therapists) linked 1:1 with an application user.
  - `professional_specialty`: Many-to-many (N:M) relationship between professionals and specialties.
  - `patient`: Patient registry per clinic (identification, full name, birth date, contact details).

### 3. Appointments Database (`appointments_db`)
- **Container:** `postgre_appointments_MediCitas`
- **Default External Port:** `5433` (internal `5432`)
- **Init Script:** `database/appointments/init.sql`
- **Responsibility:** Appointment scheduling, availability management (weekly working hours and schedule leaves/blocks), and clinical notes.
- **Tables:**
  - `working_hours`: Weekly recurring schedules per professional (prevents internal overlapping via the `btree_gist` extension).
  - `schedule_block`: Vacation or leave intervals per professional.
  - `professional_service`: Mapping of which services each professional is eligible to perform.
  - `appointment`: Booked medical appointments. Features `EXCLUDE USING gist` constraints to prevent concurrent double-booking for both professionals and patients, as well as status transition triggers.
  - `clinical_note`: Highly sensitive medical consultation records (1:1 with attended appointments).
  - `outbox`: Transactional outbox for domain events (`AgendaChanged`, `AppointmentBooked`, etc.) with a partial index on pending rows (`published_at IS NULL`). App roles can only `INSERT` per clinic; `medicitas_relay` has `SELECT` and `UPDATE` across all clinics.
  - `idempotency_keys`: Stores `Idempotency-Key` responses per clinic for booking requests (E5).

### 4. Logs Database (`logs_db`)
- **Container:** `postgre_logs_MediCitas`
- **Default External Port:** `5435` (internal `5432`)
- **Init Script:** `database/logs/init.sql`
- **Responsibility:** Traceability and auditing of access and changes to sensitive records (clinical notes and patient contact information).
- **Tables:**
  - `audit_log`: Immutable append-only audit trail (protected at the database engine level against `UPDATE`, `DELETE`, and `TRUNCATE`).

---

## 3. Referential Integrity in Microservices

In a microservices architecture with isolated databases:
1. **No Cross-Database Foreign Keys:** Foreign key constraints across different service databases are replaced with logical references (`UUID`). Entity identifiers default to RFC 9562 **UUID v7** via `gen_uuid_v7()` for time-ordered B-tree locality.
2. **Logical Foreign Key Indexes:** Each cross-reference column (e.g., `clinic_id`, `professional_id`, `patient_id`) has a dedicated B-tree index to optimize query execution plans and tenant filtering.
3. **Shard-Ready Composite Keys:** Tenant-scoped tables include `clinic_id` in their primary keys, composite intra-database foreign keys, unique constraints, and `EXCLUDE USING gist` constraints so PostgreSQL can partition or horizontally shard by `clinic_id`.
4. **Integrity Validation:** Cross-service business consistency is enforced in the application layer and through transactional checks or asynchronous messaging.

---

## 4. Row-Level Security (RLS) & Multi-Tenancy

To enforce strict clinic isolation (**Invariant I5**) and least-privilege role-based access control (**RF15**, **RF17**, **RF18**, **RF19**), MediCitas implements **Row-Level Security (RLS)** natively within PostgreSQL 17.

### Multi-Tenancy Strategy Comparison

| Strategy | Advantages | Disadvantages | Decision in MediCitas |
| :--- | :--- | :--- | :--- |
| **Schema-per-Tenant (`CREATE SCHEMA`)** | Physical table isolation per schema; clean logical separation. | Multiplies DDL migrations per clinic; connection routing complexity; expensive schema maintenance at scale. | Discarded due to operational overhead and scaling complexity across multiple branches. |
| **Discriminator Column (`clinic_id`) at Application Level** | Simple relational model; straightforward queries. | If a query or ORM neglects `WHERE clinic_id = ...`, silent data leakage occurs (security defect in application layer). | Relational foundation adopted, but insufficient on its own without engine-level enforcement. |
| **Row-Level Security (RLS) + Discriminator Column** | **Engine-enforced isolation:** PostgreSQL intercepts and filters every `SELECT`, `INSERT`, `UPDATE`, `DELETE`; completely prevents leakage even if parameters are tampered with or filters are omitted in the application layer. | Requires initializing session context variables (`SET LOCAL`) on each transaction. | **Selected as MediCitas's core multi-tenancy standard.** |

---

### Session Context Protocol (GUCs)

The application layer or authentication middleware injects the verified identity claims from the JWT token into PostgreSQL transaction-local configuration parameters:

```sql
-- Executed inside a transaction block (SET LOCAL or via the helper function):
SELECT app_set_session_context(
    p_clinic_id        := 'clinic-uuid',
    p_user_id          := 'user-uuid',
    p_role             := 'receptionist',         -- platform_admin | clinic_admin | receptionist | professional
    p_professional_id  := NULL,                   -- professional uuid (only when role = professional)
    p_is_local         := true                    -- applies only to the current transaction
);
```

#### Helper Functions Available in All Databases:
- `app_current_clinic_id()`: Returns the UUID of the active clinic (or `NULL` for `platform_admin`).
- `app_current_user_id()`: Returns the UUID of the authenticated application user.
- `app_current_role()`: Returns the active domain role code (`platform_admin`, `clinic_admin`, `receptionist`, `professional`).
- `app_current_professional_id()`: Returns the healthcare professional UUID if applicable.
- `app_is_platform_admin()`: Returns `true` if the current role is `platform_admin`.

> [!IMPORTANT]
> **Deny by Default:** When a query runs without an initialized session context, these helper functions safely evaluate to `NULL`. As a result, RLS predicate checks evaluate to `FALSE`, returning zero rows and preventing unauthorized access.

---

### RLS Policy Matrix by Entity and Role

Each table has `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` activated (forcing policies to apply even to the database owner user):

| Database | Table | platform_admin | clinic_admin | receptionist | professional |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Clinics DB** | `clinic` | Full CRUD | Read own clinic | Read own clinic | Read own clinic |
| | `specialty` | Full CRUD | Read-only | Read-only | Read-only |
| | `service` | Full CRUD | CRUD for own clinic | Read-only for own clinic | Read-only for own clinic |
| **Users DB** | `role` | Read-only | Read-only | Read-only | Read-only |
| | `app_user` | Full CRUD | CRUD for own clinic (non-platform admins) | Read-only for own clinic | Read own profile |
| | `professional`| Global Read | CRUD for own clinic | Read-only for own clinic | Read clinic / Update own profile |
| | `patient` | **No access** | CRUD for own clinic | CRUD for own clinic | Read-only for own clinic |
| **Appointments DB** | `working_hours` | **No access** | CRUD for own clinic | Read-only for own clinic | CRUD for own schedule |
| | `schedule_block`| **No access** | CRUD for own clinic | Read-only for own clinic | CRUD for own leaves/blocks |
| | `appointment` | **No access** | CRUD for own clinic | CRUD for own clinic | Read clinic / Update own appointments outcome |
| | `clinical_note` | **No access** | **No access** | **No access** | **Own attended appointments only (RF15)** |
| **Logs DB** | `audit_log` | **No access** | **Read own clinic (RF19)** | **No access** | **No access** |

---

### Least Privilege Database Role (`medicitas_app`)

Each database defines an application role `medicitas_app`:
- It is neither a superuser nor an owner of the schema.
- In `logs_db`, it only has `SELECT` and `INSERT` permissions (strictly append-only, denying `UPDATE` and `DELETE` at the engine permission level).

---

## 5. Deployment with Docker Compose

To start all databases and services:

```bash
# Start all databases and required services
docker compose --env-file .env.example up -d db_clinics db_users db_appointments db_logs

# Verify container health status
docker compose ps
```
