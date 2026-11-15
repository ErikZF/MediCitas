# Demo seed data

**English** · [Español](seed-data.es.md)

`docker compose up` leaves the system populated: three working clinics (plus a
suspended one), several professionals per clinic, their Keycloak users, and about a
thousand appointments spread from August 2026 to February 2027 in every status. All
names, ids and e-mail addresses are made up.

## How it is loaded

| What | File | Loaded by |
| --- | --- | --- |
| Clinics, specialties, services | [`database/clinics/seed.sql`](../database/clinics/seed.sql) | `db_clinics` on an empty volume |
| Users, professionals, patients | [`database/users/seed.sql`](../database/users/seed.sql) | `db_users` on an empty volume |
| Working hours, blocks, appointments, notes | [`database/appointments/seed.sql`](../database/appointments/seed.sql) | `db_appointments` on an empty volume |
| Audit log | [`database/logs/seed.sql`](../database/logs/seed.sql) | `db_logs` on an empty volume |
| Keycloak users | [`keycloak/seed-users.json`](../keycloak/seed-users.json) | the `keycloak-seed` job |

PostgreSQL runs the SQL files only when the volume is empty. To load a new version:

```bash
docker compose down -v
docker compose up -d --build
```

## Where it comes from

The five files are generated; do not edit them by hand. The data lives in
[`database/seed/data.mjs`](../database/seed/data.mjs) and
[`database/seed/generate.mjs`](../database/seed/generate.mjs) writes it:

```bash
npm run seed:generate   # rewrite the five files
npm run seed:check      # fail if they are out of date (runs in CI)
```

- **One source for every database.** An id appears in up to four databases and in
  Keycloak (a professional is in `users_db`, `appointments_db` and the token). Writing
  them from one list keeps them aligned.
- **Curated and generated appointments.** About fifteen appointments have fixed ids
  because the docs, the Postman collection and the demo use them. The rest is
  generated from the working hours with a fixed random seed, so the output is the
  same on every run and on every machine.
- **Checked before it is written.** The generator rejects a seed that breaks the
  schema or a service rule: overlapping bookings for a professional or a patient
  (I1, I2), an appointment outside working hours or inside a block (I3), a duration
  different from the service (I4), a service or a patient from another clinic, an
  adult in a pediatric service, a note on an appointment that was not attended, a
  rescheduled appointment without its replacement, or a date after the seed date.
- **CI loads it.** The integration job loads the four schemas and the seed into
  PostgreSQL 18, as Compose does, so a seed that breaks a constraint fails the build.
- **Compact rows.** Generated rows write each id as a number; `pg_temp.seed_id(n)`
  turns it into the same UUID that `id(n)` builds in `data.mjs`.

The data is written as seen on **2026-11-14** (`SEED_NOW`): earlier appointments
already have an outcome, later ones are mostly booked.

## Clinics

| Clinic | Identifier | Status | Professionals |
| --- | --- | --- | --- |
| Central San Jose Clinic | `clinic-sj-01` | active | Mora, Solis, Arias (and Campos, inactive) |
| East Curridabat Clinic | `clinic-curri-02` | active | Vega, Quesada |
| North Heredia Clinic | `clinic-her-03` | active | Chaves, Alfaro |
| Liberia Clinic | `clinic-lib-04` | suspended | none: registered, no users yet |

All of them are in `America/Costa_Rica` (UTC-6, no daylight saving time).

## Users

Every user signs in with the password in `KEYCLOAK_TEST_PASSWORD` through the
`integration-tests` client.

| Username | Role | Clinic | Notes |
| --- | --- | --- | --- |
| `platform.admin` | platform_admin | none | Registers clinics; no clinical data |
| `admin.sj` | clinic_admin | San Jose | First administrator of the clinic |
| `reception.sj` | receptionist | San Jose | |
| `reception2.sj` | receptionist | San Jose | A second receptionist for the "last slot" demo |
| `dr.mora` | professional | San Jose | General medicine, cardiology |
| `dr.solis` | professional | San Jose | Pediatrics; offered the retired home visit |
| `dr.arias` | professional | San Jose | General medicine, follow-up visits |
| `dr.campos` | professional | San Jose | **Inactive**: left in September, Keycloak account disabled |
| `admin.curri` | clinic_admin | Curridabat | First administrator of the clinic |
| `reception.curri` | receptionist | Curridabat | |
| `dr.vega` | professional | Curridabat | General medicine, dermatology |
| `dr.quesada` | professional | Curridabat | Pediatrics, general medicine |
| `admin.heredia` | clinic_admin | Heredia | First administrator of the clinic |
| `reception.heredia` | receptionist | Heredia | |
| `dr.chaves` | professional | Heredia | General medicine, cardiology |
| `dr.alfaro` | professional | Heredia | Nutrition, general medicine; also works Saturdays |

## Services and agendas

| Professional | Services (minutes) | Working hours (local time) |
| --- | --- | --- |
| Dr. Laura Mora | General Consultation (30), Cardiology Evaluation (45) | Mon-Fri 08-12, Mon-Thu 13-17 |
| Dr. Carlos Solis | Pediatric Checkup (30), Home Visit (60, **inactive** since October) | Mon-Fri 09-13 |
| Dr. Pablo Arias | General Consultation (30), Follow-up Visit (20) | Mon, Wed, Fri 07-11; Tue, Thu 13-19 |
| Dr. Elena Vega | General Consultation (30), Dermatology Screening (30) | Mon-Thu 08-16 |
| Dr. Mariana Quesada | Pediatric Checkup (30), General Consultation (30) | Mon-Fri 13-18 |
| Dr. Ricardo Chaves | General Consultation (30), Cardiology Evaluation (45) | Mon-Fri 08-12, Mon and Wed 14-18 |
| Dr. Paula Alfaro | Nutrition Counseling (40), General Consultation (30) | Tue-Sat 09-15 |

Schedule blocks: Mora on Christmas Eve afternoon, Vega on vacation from December 21
to January 3, Chaves at a congress on November 26, Solis on medical leave in
September, Alfaro at a course on the morning of January 15. Nobody is booked on Costa
Rica's public holidays.

## Appointments

| Clinic | Total | booked | attended | no_show | cancelled | rescheduled |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| San Jose | 430 | 81 | 244 | 43 | 39 | 23 |
| Curridabat | 289 | 68 | 154 | 26 | 25 | 16 |
| Heredia | 316 | 67 | 174 | 23 | 33 | 19 |
| **All** | **1035** | **216** | **572** | **92** | **97** | **58** |

- The agendas fill up as the date gets closer: the past is about a quarter full,
  December less, January less still. February 2027 only has curated appointments,
  so the demo always finds free slots there.
- Every past appointment has an outcome, except a few from the last ten days that
  are still `booked`, like 804: their outcome has not been recorded yet.
- Every `rescheduled` appointment has its replacement (`rescheduled_from_id`), with
  the same patient and professional, 1 to 14 days later.
- Bookings are made by reception (sometimes by the clinic administrator) 1 to 21
  days before, during office hours; the outcome is recorded by the professional
  right after the visit.
- **490 clinical notes**: most attended visits have one, and some were edited later.
- **1138 audit entries** (RF18): every note created or edited; the professional
  reading the previous note at the start of the next visit; reception reading or
  correcting the patient's contact data when booking.

### Curated appointments

All in `America/Costa_Rica`. Ids are `019a0000-0000-7000-8000-000000000NNN`.

| Id | Clinic | What it is |
| --- | --- | --- |
| 801 | San Jose | Attended by Dr. Mora, with note 901 |
| 802 → 803 | San Jose | Rescheduled; its replacement is booked on 2027-02-01 |
| 804 | San Jose | Booked, already started: ready to record its outcome |
| 805 | San Jose | Cancelled by reception, with a reason |
| 806 | Curridabat | Booked on 2027-02-02: a clinic 1 user must not see it |
| 807 | San Jose | No-show |
| 808 | Curridabat | Attended by Dr. Vega, with note 902 |
| 809 | Heredia | Booked on 2027-02-03 |
| 810 | Heredia | Attended by Dr. Alfaro; note 903 was edited the next day |
| 811 | Heredia | Future appointment cancelled by the clinic administrator |
| 812 → 813 | Curridabat | Pediatric appointment moved one week later |
| 814 | San Jose | Home visit before the service was retired, with note 904 |
| 815 | San Jose | Seen by Dr. Campos before he left, with note 905 |

## Patients

69 patients. The seven with fixed ids (601-607) are the ones the docs and Postman
use; they only appear in the past history, never in a future booking, so they can
always be booked in a demo. The other 62 are generated: about one in four is a
child, and only children are booked for pediatric services. Some have no phone or no
e-mail, which both columns allow.

## Id ranges

| Range (last group) | What |
| --- | --- |
| `101`-`104` | clinics |
| `201`-`205`, `301`-`311` | specialties, services |
| `401`-`416`, `1001`-`1016` | `app_user_id` and Keycloak `sub` of the same user |
| `501`-`508` | professionals |
| `601`-`607`, `610001`... | named and generated patients |
| `701`..., `751`-`755` | working hours, schedule blocks |
| `801`-`815`, `901`-`905` | curated appointments and notes |
| `2000001`..., `3000001`..., `4000001`... | generated appointments, notes and audit entries |

## Limits

- **The dates do not move.** The data is seen from 2026-11-14. After that date,
  appointments from November and December stay `booked` until someone records their
  outcome, as in a real clinic. To move the whole seed, change `SEED_NOW` and the
  history dates in `data.mjs` and regenerate.
- **Volume for the demo, not for measurements.** A thousand appointments make the
  agendas realistic. The index measurements generate their own, much larger data
  set ([indexes.md](indexes.md)).
