// Writes the demo seed: database/{clinics,users,appointments,logs}/seed.sql and
// keycloak/seed-users.json, all from data.mjs.
//
//   node database/seed/generate.mjs           write the files
//   node database/seed/generate.mjs --check   fail if the files are out of date
//
// The output is deterministic: the same data and RANDOM_SEED give the same files.
// Before writing, it checks the invariants the schema enforces (and a few the
// services enforce), so a bad seed fails here and not in docker compose.
import { readFileSync, writeFileSync } from 'node:fs';
import * as data from './data.mjs';

const { id } = data;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const root = new URL('../../', import.meta.url);

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(data.RANDOM_SEED);
const between = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (items) => items[Math.floor(random() * items.length)];
const chance = (p) => random() < p;

// ---------------------------------------------------------------------------
// Time: local wall-clock time in a clinic's zone <-> UTC instants
// ---------------------------------------------------------------------------
function offsetMinutes(timeZone, instant) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(instant).find((p) => p.type === 'timeZoneName').value;
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** "2026-11-10" + "08:00" in timeZone -> Date */
function zoned(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const first = naive - offsetMinutes(timeZone, new Date(naive)) * MINUTE;
  return new Date(naive - offsetMinutes(timeZone, new Date(first)) * MINUTE);
}

function localParts(instant, timeZone) {
  const local = new Date(instant.getTime() + offsetMinutes(timeZone, instant) * MINUTE);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    weekday: local.getUTCDay(),
  };
}

const toMinutes = (time) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const plus = (instant, minutes) => new Date(instant.getTime() + minutes * MINUTE);
const minDate = (...dates) => new Date(Math.min(...dates.map((d) => d.getTime())));
const NOW = new Date(data.SEED_NOW);

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------
const clinicById = new Map(data.clinics.map((c) => [c.id, c]));
const serviceById = new Map(data.services.map((s) => [s.id, s]));
// Sorted by id, so the working hours of the first professionals keep ids 701-718.
const professionals = data.users.filter((u) => u.professional)
  .map((u) => ({ ...u.professional, clinic: u.clinic, user: u }))
  .sort((a, b) => a.id.localeCompare(b.id));
const professionalById = new Map(professionals.map((p) => [p.id, p]));
const staff = (clinic, role) => data.users.filter((u) => u.clinic === clinic && u.role === role && u.active);

// Working hours rows: weekday-major, then by start, numbered from 701.
const workingHours = [];
for (const p of professionals) {
  for (let weekday = 0; weekday <= 6; weekday += 1) {
    for (const s of [...p.hours].sort((a, b) => a.start.localeCompare(b.start))) {
      if (s.days.includes(weekday)) workingHours.push({ id: id(701 + workingHours.length), clinic: p.clinic, professional: p.id, weekday, start: s.start, end: s.end });
    }
  }
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------
const patients = data.namedPatients.map((p) => ({ ...p, named: true }));
{
  const usedIds = new Set(patients.map((p) => `${p.clinic}|${p.identification}`));
  const usedNames = new Set(patients.map((p) => `${p.clinic}|${p.fullName}`));
  let n = 0;
  for (const clinic of data.clinics) {
    for (let i = 0; i < (data.generatedPatients[clinic.id] ?? 0); i += 1) {
      let fullName;
      do fullName = `${pick(data.firstNames)} ${pick(data.lastNames)} ${pick(data.lastNames)}`;
      while (usedNames.has(`${clinic.id}|${fullName}`));
      usedNames.add(`${clinic.id}|${fullName}`);
      let identification;
      do identification = `${clinic.province}-${String(between(100, 1999)).padStart(4, '0')}-${String(between(1, 9999)).padStart(4, '0')}`;
      while (usedIds.has(`${clinic.id}|${identification}`));
      usedIds.add(`${clinic.id}|${identification}`);
      // About one in four is a child, so pediatric services have patients.
      const minor = i % 4 === 3;
      const birthDate = minor
        ? `${between(2010, 2024)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`
        : `${between(1945, 2004)}-${String(between(1, 12)).padStart(2, '0')}-${String(between(1, 28)).padStart(2, '0')}`;
      const [first, last] = fullName.toLowerCase().split(' ');
      n += 1;
      patients.push({
        clinic: clinic.id, id: id(610_000 + n), identification, fullName, birthDate,
        phone: chance(0.9) ? `+506-${pick(['6', '7', '8'])}${between(100, 999)}-${String(between(0, 9999)).padStart(4, '0')}` : null,
        email: chance(0.85) ? `${first}.${last}${between(1, 99)}@example.com` : null,
      });
    }
  }
}
const patientById = new Map(patients.map((p) => [p.id, p]));
const isMinorOn = (patient, instant) => {
  const birth = new Date(`${patient.birthDate}T00:00:00Z`);
  return instant.getTime() < Date.UTC(birth.getUTCFullYear() + 18, birth.getUTCMonth(), birth.getUTCDate());
};

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------
const appointments = [];
const notes = [];
// Time taken on each agenda, by any appointment that still holds it (not cancelled
// or rescheduled): no professional or patient is ever in two places at once.
const busy = new Map();
const holds = (a) => a.status !== 'cancelled' && a.status !== 'rescheduled';
const overlaps = (list, start, end) => (list ?? []).some((r) => r.start < end && start < r.end);
function isFree(clinic, professional, patient, start, end) {
  return !overlaps(busy.get(`p|${clinic}|${professional}`), start, end)
    && !overlaps(busy.get(`c|${clinic}|${patient}`), start, end);
}
function occupy(a) {
  if (!holds(a)) return;
  for (const key of [`p|${a.clinic}|${a.professional}`, `c|${a.clinic}|${a.patient}`]) {
    if (!busy.has(key)) busy.set(key, []);
    busy.get(key).push({ start: a.startsAt.getTime(), end: a.endsAt.getTime() });
  }
}
const blocked = (professional, start, end) =>
  data.blocks.some((b) => b.professional === professional && Date.parse(b.startsAt) < end && start < Date.parse(b.endsAt));

function finishCurated(c) {
  const service = serviceById.get(c.service);
  const startsAt = new Date(c.startsAt);
  const a = {
    ...c, startsAt, endsAt: plus(startsAt, service.minutes), minutes: service.minutes,
    createdAt: new Date(c.createdAt),
    statusChangedAt: new Date(c.statusChangedAt ?? c.createdAt),
    statusChangedBy: c.statusChangedBy ?? c.createdBy,
    cancelledBy: c.status === 'cancelled' ? (c.cancelledBy ?? c.statusChangedBy) : null,
  };
  a.updatedAt = a.statusChangedAt;
  return a;
}

for (const c of data.curatedAppointments) {
  const a = finishCurated(c);
  appointments.push(a);
  occupy(a);
  if (c.note) {
    notes.push({
      id: c.note.id, clinic: a.clinic, appointment: a.id, professional: a.professional, patient: a.patient,
      content: c.note.content, createdAt: new Date(c.note.createdAt), updatedAt: new Date(c.note.updatedAt ?? c.note.createdAt),
    });
  }
}

let nextAppointment = 0;
let nextNote = 0;
const newAppointmentId = () => id(2_000_000 + (nextAppointment += 1));
const newNoteId = () => id(3_000_000 + (nextNote += 1));

function noteContent(service) {
  const text = pick(data.noteTemplates[service.specialty]);
  return text
    .replace('{n}', String(between(2, 6)))
    .replace('{bp}', `${between(112, 158)}/${between(70, 98)}`)
    .replace('{bmi}', `${between(24, 36)}.${between(0, 9)}`);
}

// A moment between two instants, during office hours of the clinic when possible:
// people cancel, reschedule and edit notes at work, not at 3 a.m.
function officeTime(clinic, from, to) {
  const timeZone = clinicById.get(clinic).timeZone;
  const span = Math.max(MINUTE, to.getTime() - from.getTime());
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const { date } = localParts(new Date(from.getTime() + Math.floor(random() * span)), timeZone);
    const at = zoned(date, hhmm(between(7 * 60 + 30, 18 * 60 + 30)), timeZone);
    if (at > from && at < to) return at;
  }
  return new Date(from.getTime() + Math.floor(random() * span));
}

// When the outcome of an appointment that already happened is recorded.
function settle(a, professionalUser) {
  const roll = random();
  const recent = a.startsAt.getTime() > NOW.getTime() - 10 * DAY;
  if (recent && roll < 0.04) return; // outcome still pending, like 804
  if (roll < 0.86) {
    a.status = 'attended';
  } else {
    a.status = 'no_show';
  }
  a.statusChangedAt = plus(a.endsAt, between(3, 40));
  a.statusChangedBy = professionalUser.appUserId;
  if (a.status === 'attended' && chance(0.85)) {
    const createdAt = plus(a.statusChangedAt, between(1, 12));
    const edited = chance(0.12);
    notes.push({
      id: newNoteId(), clinic: a.clinic, appointment: a.id, professional: a.professional, patient: a.patient,
      content: noteContent(serviceById.get(a.service)), createdAt,
      updatedAt: edited ? officeTime(a.clinic, plus(createdAt, 30), minDate(plus(createdAt, 3 * 24 * 60), NOW)) : createdAt,
    });
  }
}

/** Every slot start of a professional on a local date, in that clinic's time. */
function slotsOn(p, date, step = 60) {
  const timeZone = clinicById.get(p.clinic).timeZone;
  const out = [];
  for (const wh of workingHours.filter((w) => w.professional === p.id && w.weekday === weekdayOf(date))) {
    for (let t = toMinutes(wh.start); t + step <= toMinutes(wh.end); t += step) out.push(zoned(date, hhmm(t), timeZone));
  }
  return out;
}

function choosePatient(p, service, start, end) {
  const pool = patients.filter((pt) => pt.clinic === p.clinic
    && (start > NOW ? !pt.named : true)
    && (service.pediatric ? isMinorOn(pt, start) : (isMinorOn(pt, start) ? chance(0.15) : true)));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate = pick(pool);
    if (candidate && isFree(p.clinic, p.id, candidate.id, start.getTime(), end.getTime())) return candidate;
  }
  return null;
}

// Booking time: 1 to 21 days before, during office hours, never after SEED_NOW.
function bookingTime(clinic, start) {
  const timeZone = clinicById.get(clinic).timeZone;
  const { date } = localParts(start, timeZone);
  const at = zoned(addDays(date, -between(1, 21)), hhmm(between(7 * 60 + 30, 17 * 60 + 30)), timeZone);
  const latest = new Date(Math.min(start.getTime() - 30 * MINUTE, NOW.getTime()));
  return at < latest ? at : officeTime(clinic, plus(latest, -6 * 24 * 60), latest);
}


function bookable(p, service, start) {
  if (service.retiredOn && start >= zoned(service.retiredOn, '00:00', clinicById.get(p.clinic).timeZone)) return false;
  return true;
}

for (const p of professionals) {
  if (!p.user.active || p.hours.length === 0) continue;
  const offered = p.services.map((s) => serviceById.get(s));
  for (let date = data.HISTORY_FROM; date <= data.HISTORY_TO; date = addDays(date, 1)) {
    if (data.HOLIDAYS.includes(date)) continue;
    for (const start of slotsOn(p, date)) {
      const ahead = (start.getTime() - NOW.getTime()) / DAY;
      // Agendas fill up as the date gets closer; the past is as full as it got.
      const fill = ahead <= 0 ? 0.25 : 0.25 * Math.max(0.2, 1 - ahead / 70);
      if (!chance(fill)) continue;
      const services = offered.filter((s) => bookable(p, s, start));
      if (services.length === 0) continue;
      const service = pick(services);
      const end = plus(start, service.minutes);
      if (blocked(p.id, start.getTime(), end.getTime())) continue;
      const patient = choosePatient(p, service, start, end);
      if (!patient) continue;

      const receptionists = staff(p.clinic, 'receptionist');
      const admins = staff(p.clinic, 'clinic_admin');
      const desk = () => (chance(0.85) ? pick(receptionists) : pick(admins)).appUserId;
      const createdBy = desk();
      const createdAt = bookingTime(p.clinic, start);
      const a = {
        clinic: p.clinic, id: newAppointmentId(), professional: p.id, patient: patient.id, service: service.id,
        startsAt: start, endsAt: end, minutes: service.minutes, status: 'booked', createdBy, createdAt,
        statusChangedAt: createdAt, statusChangedBy: createdBy, cancelledBy: null, cancelReason: null, rescheduledFrom: null,
      };

      const roll = random();
      const lastChance = minDate(plus(start, -60), NOW);
      if (roll < 0.1 && lastChance > createdAt) {
        a.status = 'cancelled';
        a.statusChangedAt = officeTime(p.clinic, createdAt, lastChance);
        a.statusChangedBy = a.cancelledBy = desk();
        a.cancelReason = pick(data.cancelReasons);
      } else if (roll < 0.15 && lastChance > createdAt) {
        // Rescheduled: the same patient, the same professional, 1 to 14 days later.
        const changedAt = officeTime(p.clinic, createdAt, lastChance);
        let replacement = null;
        for (let shift = 1; shift <= 14 && !replacement; shift += 1) {
          const later = addDays(date, shift);
          if (data.HOLIDAYS.includes(later) || later > data.HISTORY_TO) continue;
          for (const s of slotsOn(p, later)) {
            const e = plus(s, service.minutes);
            if (!bookable(p, service, s) || blocked(p.id, s.getTime(), e.getTime())) continue;
            if (patient.named && s > NOW) continue;
            if (!isFree(p.clinic, p.id, patient.id, s.getTime(), e.getTime())) continue;
            if (chance(0.5)) { replacement = s; break; }
          }
        }
        if (replacement) {
          const by = desk();
          a.status = 'rescheduled';
          a.statusChangedAt = changedAt;
          a.statusChangedBy = by;
          const r = {
            ...a, id: newAppointmentId(), startsAt: replacement, endsAt: plus(replacement, service.minutes),
            status: 'booked', createdBy: by, createdAt: changedAt, statusChangedAt: changedAt, statusChangedBy: by,
            rescheduledFrom: a.id,
          };
          if (r.endsAt <= NOW) settle(r, p.user);
          r.updatedAt = r.statusChangedAt;
          appointments.push(r);
          occupy(r);
        }
      }
      if (a.status === 'booked' && a.endsAt <= NOW) settle(a, p.user);
      a.updatedAt = a.statusChangedAt;
      appointments.push(a);
      occupy(a);
    }
  }
}
appointments.sort((x, y) => x.startsAt - y.startsAt || x.id.localeCompare(y.id));

// ---------------------------------------------------------------------------
// Audit log (RF18): what the services would have written while all this happened
// ---------------------------------------------------------------------------
const audit = data.curatedAudit.map((e) => ({ ...e, occurredAt: new Date(e.occurredAt) }));
{
  let next = 0;
  const newAuditId = () => id(4_000_000 + (next += 1));
  const professionalUser = (professional) => professionalById.get(professional).user.appUserId;
  const byAppointment = new Map(appointments.map((a) => [a.id, a]));
  for (const n of notes) {
    audit.push({ clinic: n.clinic, id: data.fixedNoteAuditIds[n.id] ?? newAuditId(), appUser: professionalUser(n.professional), patient: n.patient, action: 'create', resource: 'clinical_note', resourceId: n.id, occurredAt: n.createdAt });
    if (n.updatedAt > n.createdAt) {
      audit.push({ clinic: n.clinic, id: newAuditId(), appUser: professionalUser(n.professional), patient: n.patient, action: 'update', resource: 'clinical_note', resourceId: n.id, occurredAt: n.updatedAt });
    }
  }
  // A professional reads the patient's previous note at the start of the next visit.
  for (const a of appointments) {
    if (a.status !== 'attended' || data.curatedAppointments.some((c) => c.id === a.id)) continue;
    const previous = notes
      .filter((n) => n.clinic === a.clinic && n.patient === a.patient && n.professional === a.professional && byAppointment.get(n.appointment).startsAt < a.startsAt)
      .sort((x, y) => y.createdAt - x.createdAt)[0];
    if (previous) {
      audit.push({ clinic: a.clinic, id: newAuditId(), appUser: professionalUser(a.professional), patient: a.patient, action: 'read', resource: 'clinical_note', resourceId: previous.id, occurredAt: plus(a.startsAt, between(0, 4)) });
    }
  }
  // Reception looks up the contact data when booking, and sometimes corrects it.
  for (const a of appointments) {
    if (a.rescheduledFrom || !chance(0.2)) continue;
    const action = chance(0.08) ? 'update' : 'read';
    audit.push({ clinic: a.clinic, id: newAuditId(), appUser: a.createdBy, patient: a.patient, action, resource: 'patient_contact', resourceId: a.patient, occurredAt: plus(a.createdAt, -between(1, 3)) });
  }
  audit.sort((x, y) => x.occurredAt - y.occurredAt || x.id.localeCompare(y.id));
}

// ---------------------------------------------------------------------------
// Checks: the constraints of init.sql and the rules of the services
// ---------------------------------------------------------------------------
const problems = [];
const fail = (message) => problems.push(message);
{
  const ids = new Set();
  for (const a of appointments) {
    const label = `appointment ${a.id}`;
    if (ids.has(a.id)) fail(`${label}: duplicate id`);
    ids.add(a.id);
    const service = serviceById.get(a.service);
    const p = professionalById.get(a.professional);
    const patient = patientById.get(a.patient);
    const timeZone = clinicById.get(a.clinic).timeZone;
    if (!service || service.clinic !== a.clinic) fail(`${label}: service of another clinic`);
    if (!p || p.clinic !== a.clinic) fail(`${label}: professional of another clinic`);
    if (!patient || patient.clinic !== a.clinic) fail(`${label}: patient of another clinic`);
    if (!p.services.includes(a.service)) fail(`${label}: service not offered by the professional`);
    if (a.endsAt - a.startsAt !== service.minutes * MINUTE) fail(`${label}: duration differs from the service (I4)`);
    if (service.pediatric && !isMinorOn(patient, a.startsAt)) fail(`${label}: adult in a pediatric service`);
    if (!(a.createdAt < a.startsAt) || a.createdAt > NOW) fail(`${label}: created at ${a.createdAt.toISOString()}`);
    if (a.statusChangedAt < a.createdAt || a.statusChangedAt > NOW) fail(`${label}: status changed at ${a.statusChangedAt.toISOString()}`);
    if (['attended', 'no_show'].includes(a.status) && a.statusChangedAt < a.startsAt) fail(`${label}: outcome before the start`);
    if (a.status === 'cancelled' && (!a.cancelReason || !a.cancelledBy)) fail(`${label}: cancelled without reason`);
    if (p.hours.length > 0) {
      const { weekday, minutes } = localParts(a.startsAt, timeZone);
      const inside = workingHours.some((w) => w.professional === p.id && w.weekday === weekday
        && toMinutes(w.start) <= minutes && minutes + service.minutes <= toMinutes(w.end));
      if (!inside) fail(`${label}: outside working hours (I3)`);
    }
    if (a.rescheduledFrom) {
      const from = appointments.find((x) => x.id === a.rescheduledFrom);
      if (!from || from.status !== 'rescheduled' || from.clinic !== a.clinic) fail(`${label}: bad rescheduled_from`);
      if (appointments.filter((x) => x.rescheduledFrom === a.rescheduledFrom).length !== 1) fail(`${label}: replaced twice`);
    }
    if (a.status === 'rescheduled' && !appointments.some((x) => x.rescheduledFrom === a.id)) fail(`${label}: rescheduled without replacement`);
  }
  // I1 / I2 on booked appointments, and the stricter rule the generator follows.
  const check = (keyOf, name, filter) => {
    const groups = new Map();
    for (const a of appointments.filter(filter)) {
      const key = keyOf(a);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    for (const list of groups.values()) {
      list.sort((x, y) => x.startsAt - y.startsAt);
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].startsAt < list[i - 1].endsAt) fail(`${name}: ${list[i - 1].id} and ${list[i].id} overlap`);
      }
    }
  };
  check((a) => `${a.clinic}|${a.professional}`, 'professional overlap', holds);
  check((a) => `${a.clinic}|${a.patient}`, 'patient overlap', holds);
  for (const n of notes) {
    const a = appointments.find((x) => x.id === n.appointment);
    if (!a || a.status !== 'attended' || a.professional !== n.professional) fail(`note ${n.id}: appointment is not an attended visit of that professional`);
    if (n.createdAt < a.startsAt || n.updatedAt < n.createdAt || n.updatedAt > NOW) fail(`note ${n.id}: bad timestamps`);
  }
  if (new Set(notes.map((n) => n.appointment)).size !== notes.length) fail('two notes for one appointment');
  if (new Set(audit.map((e) => e.id)).size !== audit.length) fail('duplicate audit id');
  for (const e of audit) if (e.occurredAt > NOW) fail(`audit ${e.id}: in the future`);
  const statuses = new Set(appointments.map((a) => a.status));
  for (const s of ['booked', 'attended', 'no_show', 'cancelled', 'rescheduled']) if (!statuses.has(s)) fail(`no ${s} appointment`);
  for (const c of data.clinics.filter((x) => x.active)) {
    if (professionals.filter((p) => p.clinic === c.id && p.user.active).length < 2) fail(`${c.identifier}: fewer than two professionals`);
  }
}
if (problems.length > 0) {
  console.error(`The seed breaks ${problems.length} rule(s):\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------
const q = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return `'${value.toISOString().replace('.000Z', 'Z')}'`;
  return `'${String(value).replaceAll("'", "''")}'`;
};
const header = (title, extra = []) => [
  '-- =====================================================================',
  `-- MediCitas - ${title}`,
  '-- Generated by database/seed/generate.mjs from database/seed/data.mjs.',
  '-- Do not edit by hand: change data.mjs and run `npm run seed:generate`.',
  '-- Runs automatically after init.sql in /docker-entrypoint-initdb.d',
  ...extra.map((line) => `-- ${line}`),
  '-- =====================================================================',
  '',
];
function insert(table, columns, rows, conflict, comment) {
  if (rows.length === 0) return [];
  const lines = rows.map((r, i) => {
    const values = `    (${r.values.map(q).join(', ')})${i === rows.length - 1 ? '' : ','}`;
    return r.comment ? `    -- ${r.comment}\n${values}` : values;
  });
  return [
    ...(comment ? [`-- ${comment}`] : []),
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES`,
    ...lines,
    `ON CONFLICT (${conflict}) DO NOTHING;`,
    '',
  ];
}

const clinicsSql = [
  ...header('Clinics Database Seed Data'),
  ...insert('clinic', ['clinic_id', 'identifier', 'name', 'time_zone', 'is_active'],
    data.clinics.map((c) => ({ values: [c.id, c.identifier, c.name, c.timeZone, c.active] })), 'clinic_id'),
  ...insert('specialty', ['specialty_id', 'name'], data.specialties.map((s) => ({ values: [s.id, s.name] })), 'specialty_id'),
  ...insert('service', ['clinic_id', 'service_id', 'specialty_id', 'name', 'duration_minutes', 'is_active'],
    data.services.map((s) => ({ values: [s.clinic, s.id, s.specialty, s.name, s.minutes, s.active] })), 'clinic_id, service_id'),
];

const usersSql = [
  ...header('Users Database Seed Data', ['clinic_id, app_user_id and professional_id match keycloak/seed-users.json.']),
  ...insert('app_user', ['app_user_id', 'keycloak_sub', 'clinic_id', 'role_code', 'is_active', 'is_first_admin'],
    data.users.map((u) => ({ values: [u.appUserId, u.sub, u.clinic, u.role, u.active, Boolean(u.firstAdmin)], comment: u.username })), 'app_user_id'),
  ...insert('professional', ['clinic_id', 'professional_id', 'app_user_id', 'full_name', 'is_active'],
    professionals.map((p) => ({ values: [p.clinic, p.id, p.user.appUserId, p.fullName, p.user.active] })), 'clinic_id, professional_id'),
  ...insert('professional_specialty', ['clinic_id', 'professional_id', 'specialty_id'],
    professionals.flatMap((p) => p.specialties.map((s) => ({ values: [p.clinic, p.id, s] }))), 'clinic_id, professional_id, specialty_id'),
  ...insert('patient', ['clinic_id', 'patient_id', 'identification', 'full_name', 'birth_date', 'phone', 'email'],
    patients.map((p) => ({ values: [p.clinic, p.id, p.identification, p.fullName, p.birthDate, p.phone, p.email] })), 'clinic_id, patient_id'),
];

// Generated rows are many, so they are written compactly: every id is a number
// that pg_temp.seed_id() turns into the same UUID that id() builds in data.mjs.
const PREFIX = id(0).slice(0, 24);
const num = (uuid) => {
  if (uuid === null || uuid === undefined) return null;
  if (!uuid.startsWith(PREFIX) || !/^\d{12}$/.test(uuid.slice(24))) throw new Error(`${uuid} is not an id() value`);
  return Number(uuid.slice(24));
};
const seedIdFunction = [
  `CREATE FUNCTION pg_temp.seed_id(n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$`,
  `    SELECT ('${PREFIX}' || lpad(n::text, 12, '0'))::uuid`,
  '$$;',
  '',
];
function compactInsert(table, columns, alias, select, rows, conflict, comment) {
  if (rows.length === 0) return [];
  return [
    `-- ${comment}`,
    `INSERT INTO ${table} (${columns.join(', ')})`,
    `SELECT ${select.join(', ')}`,
    'FROM (VALUES',
    ...rows.map((r, i) => `    (${r.map(q).join(', ')})${i === rows.length - 1 ? '' : ','}`),
    `) AS h (${alias.join(', ')})`,
    `ON CONFLICT (${conflict}) DO NOTHING;`,
    '',
  ];
}
const sid = (column) => `pg_temp.seed_id(${column})`;

const appointmentColumns = ['clinic_id', 'appointment_id', 'professional_id', 'patient_id', 'service_id', 'starts_at', 'ends_at',
  'duration_minutes', 'status', 'cancel_reason', 'cancelled_by', 'rescheduled_from_id', 'created_by', 'created_at',
  'status_changed_at', 'status_changed_by', 'updated_at'];
const curatedIds = new Set(data.curatedAppointments.map((c) => c.id));
const curatedNoteIds = new Set(data.curatedAppointments.filter((c) => c.note).map((c) => c.note.id));
const history = appointments.filter((a) => !curatedIds.has(a.id));
const appointmentsSql = [
  ...header('Appointments Database Seed Data', ['IDs are aligned with clinics_db, users_db, and keycloak/seed-users.json.']),
  ...seedIdFunction,
  ...insert('working_hours', ['clinic_id', 'working_hours_id', 'professional_id', 'weekday', 'start_time', 'end_time'],
    workingHours.map((w) => ({ values: [w.clinic, w.id, w.professional, w.weekday, `${w.start}:00`, `${w.end}:00`] })),
    'clinic_id, working_hours_id', 'Weekly working hours (local wall-clock time of the clinic, weekday 0 = Sunday)'),
  ...insert('schedule_block', ['clinic_id', 'schedule_block_id', 'professional_id', 'starts_at', 'ends_at', 'reason'],
    data.blocks.map((b) => ({ values: [b.clinic, b.id, b.professional, new Date(b.startsAt), new Date(b.endsAt), b.reason] })), 'clinic_id, schedule_block_id'),
  ...insert('professional_service', ['clinic_id', 'professional_id', 'service_id', 'specialty_id'],
    professionals.flatMap((p) => p.services.map((s) => ({ values: [p.clinic, p.id, s, serviceById.get(s).specialty] }))), 'clinic_id, professional_id, service_id'),
  ...insert('appointment', appointmentColumns,
    appointments.filter((a) => curatedIds.has(a.id)).map((a) => ({
      values: [a.clinic, a.id, a.professional, a.patient, a.service, a.startsAt, a.endsAt, a.minutes, a.status,
        a.cancelReason ?? null, a.cancelledBy ?? null, a.rescheduledFrom ?? null, a.createdBy, a.createdAt,
        a.statusChangedAt, a.statusChangedBy, a.updatedAt],
      comment: a.label,
    })),
    'clinic_id, appointment_id', 'Curated appointments: fixed ids used by the docs and the Postman collection'),
  ...insert('clinical_note', ['clinic_id', 'clinical_note_id', 'appointment_id', 'professional_id', 'appointment_status', 'content', 'created_at', 'updated_at'],
    notes.filter((n) => curatedNoteIds.has(n.id)).map((n) => ({ values: [n.clinic, n.id, n.appointment, n.professional, 'attended', n.content, n.createdAt, n.updatedAt] })),
    'clinic_id, clinical_note_id'),
  ...compactInsert('appointment', appointmentColumns,
    ['clinic', 'appointment', 'professional', 'patient', 'service', 'starts_at', 'minutes', 'status', 'cancel_reason',
      'cancelled_by', 'rescheduled_from', 'created_by', 'created_at', 'status_changed_at', 'status_changed_by'],
    [sid('clinic'), sid('appointment'), sid('professional'), sid('patient'), sid('service'), 'starts_at::timestamptz',
      'starts_at::timestamptz + make_interval(mins => minutes)', 'minutes', 'status', 'cancel_reason', sid('cancelled_by'),
      sid('rescheduled_from'), sid('created_by'), 'created_at::timestamptz', 'status_changed_at::timestamptz',
      sid('status_changed_by'), 'status_changed_at::timestamptz'],
    history.map((a) => [num(a.clinic), num(a.id), num(a.professional), num(a.patient), num(a.service), a.startsAt, a.minutes,
      a.status, a.cancelReason ?? null, num(a.cancelledBy), num(a.rescheduledFrom), num(a.createdBy), a.createdAt,
      a.statusChangedAt, num(a.statusChangedBy)]),
    'clinic_id, appointment_id',
    `Generated history, ${data.HISTORY_FROM} to ${data.HISTORY_TO}. Ordered by start, so a replacement comes after the appointment it replaces.`),
  ...compactInsert('clinical_note', ['clinic_id', 'clinical_note_id', 'appointment_id', 'professional_id', 'appointment_status', 'content', 'created_at', 'updated_at'],
    ['clinic', 'note', 'appointment', 'professional', 'content', 'created_at', 'updated_at'],
    [sid('clinic'), sid('note'), sid('appointment'), sid('professional'), "'attended'", 'content', 'created_at::timestamptz', 'updated_at::timestamptz'],
    notes.filter((n) => !curatedNoteIds.has(n.id)).map((n) => [num(n.clinic), num(n.id), num(n.appointment), num(n.professional), n.content, n.createdAt, n.updatedAt]),
    'clinic_id, clinical_note_id', 'Notes of the generated attended appointments'),
];

const auditColumns = ['clinic_id', 'audit_log_id', 'app_user_id', 'patient_id', 'action', 'resource', 'resource_id', 'occurred_at'];
const isCuratedAudit = (e) => !/^\d{12}$/.test(e.id.slice(24)) || data.curatedAudit.some((c) => c.id === e.id)
  || (e.resource === 'clinical_note' && e.action !== 'read' && curatedNoteIds.has(e.resourceId));
const logsSql = [
  ...header('Logs Database Seed Data', ['IDs are aligned with users_db and appointments_db.']),
  ...seedIdFunction,
  ...insert('audit_log', auditColumns,
    audit.filter(isCuratedAudit).map((e) => ({ values: [e.clinic, e.id, e.appUser, e.patient, e.action, e.resource, e.resourceId, e.occurredAt] })),
    'clinic_id, audit_log_id', 'Entries of the curated appointments'),
  ...compactInsert('audit_log', auditColumns,
    ['clinic', 'audit', 'app_user', 'patient', 'action', 'resource', 'resource_id', 'occurred_at'],
    [sid('clinic'), sid('audit'), sid('app_user'), sid('patient'), 'action', 'resource', sid('resource_id'), 'occurred_at::timestamptz'],
    audit.filter((e) => !isCuratedAudit(e)).map((e) => [num(e.clinic), num(e.id), num(e.appUser), num(e.patient), e.action, e.resource, num(e.resourceId), e.occurredAt]),
    'clinic_id, audit_log_id', 'What the services recorded while the generated history happened (RF18)'),
];

// ---------------------------------------------------------------------------
// Keycloak users
// ---------------------------------------------------------------------------
const keycloakUsers = {
  users: data.users.map((u) => ({
    id: u.sub,
    username: u.username,
    email: u.email,
    emailVerified: true,
    firstName: u.firstName,
    lastName: u.lastName,
    enabled: u.active,
    groups: ['/users-MediCitas'],
    realmRoles: [u.role],
    attributes: {
      ...(u.clinic ? { clinic_id: [u.clinic] } : {}),
      app_user_id: [u.appUserId],
      ...(u.professional ? { professional_id: [u.professional.id] } : {}),
      role: [u.role],
    },
    credentials: [{ type: 'password', value: '${KEYCLOAK_TEST_PASSWORD}', temporary: false }],
  })),
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const outputs = {
  'database/clinics/seed.sql': clinicsSql.join('\n'),
  'database/users/seed.sql': usersSql.join('\n'),
  'database/appointments/seed.sql': appointmentsSql.join('\n'),
  'database/logs/seed.sql': logsSql.join('\n'),
  'keycloak/seed-users.json': `${JSON.stringify(keycloakUsers, null, 2)}\n`,
};

const count = (list, keyOf) => list.reduce((acc, x) => ({ ...acc, [keyOf(x)]: (acc[keyOf(x)] ?? 0) + 1 }), {});
const summary = {
  clinics: data.clinics.length,
  users: data.users.length,
  professionals: professionals.length,
  patients: patients.length,
  appointments: appointments.length,
  byStatus: count(appointments, (a) => a.status),
  byClinic: count(appointments, (a) => clinicById.get(a.clinic).identifier),
  clinicalNotes: notes.length,
  auditLog: audit.length,
};

if (process.argv.includes('--check')) {
  const stale = Object.entries(outputs).filter(([path, text]) => {
    const current = readFileSync(new URL(path, root), 'utf8').replaceAll('\r\n', '\n');
    return current !== text;
  }).map(([path]) => path);
  if (stale.length > 0) {
    console.error(`Out of date, run npm run seed:generate: ${stale.join(', ')}`);
    process.exit(1);
  }
  console.log('Seed files are up to date.');
} else {
  for (const [path, text] of Object.entries(outputs)) writeFileSync(new URL(path, root), text);
  console.log(JSON.stringify(summary, null, 2));
}
