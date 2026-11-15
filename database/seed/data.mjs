// Demo data for `docker compose up`. generate.mjs turns it into the four seed.sql
// files and keycloak/seed-users.json, so every id below is the same in all of them.
//
// Two kinds of appointments:
//   - curated: fixed ids, used by the docs, the Postman collection and the demo;
//   - history: generated from the working hours with a fixed random seed, so the
//     agendas look lived-in (every status, spread over six months).

export const id = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

// The data is written as seen on this date: earlier appointments already have an
// outcome, later ones are mostly booked. Midnight in Costa Rica.
export const SEED_NOW = '2026-11-14T06:00:00Z';

// Generated history covers these local dates (inclusive). Curated appointments in
// February 2027 stay outside it, so the demo always finds free slots there.
export const HISTORY_FROM = '2026-08-03';
export const HISTORY_TO = '2027-01-29';
export const RANDOM_SEED = 20261114;

// Costa Rica public holidays in that range: nobody is booked on them.
export const HOLIDAYS = ['2026-08-15', '2026-08-31', '2026-09-15', '2026-12-01', '2026-12-25', '2027-01-01'];

export const clinics = [
  { id: id(101), identifier: 'clinic-sj-01', name: 'Central San Jose Clinic', timeZone: 'America/Costa_Rica', active: true, province: 1 },
  { id: id(102), identifier: 'clinic-curri-02', name: 'East Curridabat Clinic', timeZone: 'America/Costa_Rica', active: true, province: 1 },
  { id: id(103), identifier: 'clinic-her-03', name: 'North Heredia Clinic', timeZone: 'America/Costa_Rica', active: true, province: 4 },
  // Registered by the platform but suspended: no users and no agenda (RF1).
  { id: id(104), identifier: 'clinic-lib-04', name: 'Liberia Clinic', timeZone: 'America/Costa_Rica', active: false, province: 5 },
];

export const specialties = [
  { id: id(201), name: 'General Medicine' },
  { id: id(202), name: 'Cardiology' },
  { id: id(203), name: 'Pediatrics' },
  { id: id(204), name: 'Dermatology' },
  { id: id(205), name: 'Nutrition' },
];

// pediatric: only patients under 18 are booked for it.
export const services = [
  { clinic: id(101), id: id(301), specialty: id(201), name: 'General Consultation', minutes: 30, active: true },
  { clinic: id(101), id: id(302), specialty: id(202), name: 'Cardiology Evaluation', minutes: 45, active: true },
  { clinic: id(101), id: id(303), specialty: id(203), name: 'Pediatric Checkup', minutes: 30, active: true, pediatric: true },
  { clinic: id(102), id: id(304), specialty: id(201), name: 'General Consultation', minutes: 30, active: true },
  { clinic: id(102), id: id(305), specialty: id(204), name: 'Dermatology Screening', minutes: 30, active: true },
  { clinic: id(101), id: id(306), specialty: id(201), name: 'Follow-up Visit', minutes: 20, active: true },
  // Retired in October: its past appointments stay, new bookings get 422 service_inactive.
  { clinic: id(101), id: id(307), specialty: id(201), name: 'Home Visit', minutes: 60, active: false, retiredOn: '2026-10-01' },
  { clinic: id(102), id: id(308), specialty: id(203), name: 'Pediatric Checkup', minutes: 30, active: true, pediatric: true },
  { clinic: id(103), id: id(309), specialty: id(201), name: 'General Consultation', minutes: 30, active: true },
  { clinic: id(103), id: id(310), specialty: id(202), name: 'Cardiology Evaluation', minutes: 45, active: true },
  { clinic: id(103), id: id(311), specialty: id(205), name: 'Nutrition Counseling', minutes: 40, active: true },
];

// Weekly working hours in the clinic's local time, weekday 0 = Sunday.
const weekdays = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const shift = (days, start, end) => ({ days: days.split(',').map((d) => weekdays[d]), start, end });

// One row per Keycloak user and app_user. A professional also gets a professional
// row, its specialties, the services it offers and its working hours.
export const users = [
  { n: 1, username: 'platform.admin', email: 'platform.admin@medicitas.local', firstName: 'Platform', lastName: 'Admin', role: 'platform_admin', clinic: null },

  // Clinic 1: Central San Jose
  { n: 2, username: 'admin.sj', email: 'admin.sj@medicitas.local', firstName: 'Ana', lastName: 'Brenes', role: 'clinic_admin', clinic: id(101), firstAdmin: true },
  { n: 3, username: 'reception.sj', email: 'reception.sj@medicitas.local', firstName: 'Diego', lastName: 'Castro', role: 'receptionist', clinic: id(101) },
  { n: 16, username: 'reception2.sj', email: 'reception2.sj@medicitas.local', firstName: 'Valeria', lastName: 'Rojas', role: 'receptionist', clinic: id(101) },
  {
    n: 4, username: 'dr.mora', email: 'laura.mora@medicitas.local', firstName: 'Laura', lastName: 'Mora', role: 'professional', clinic: id(101),
    professional: {
      id: id(501), fullName: 'Dr. Laura Mora', specialties: [id(201), id(202)],
      services: [id(301), id(302)],
      hours: [shift('mon,tue,wed,thu,fri', '08:00', '12:00'), shift('mon,tue,wed,thu', '13:00', '17:00')],
    },
  },
  {
    n: 5, username: 'dr.solis', email: 'carlos.solis@medicitas.local', firstName: 'Carlos', lastName: 'Solis', role: 'professional', clinic: id(101),
    professional: {
      id: id(502), fullName: 'Dr. Carlos Solis', specialties: [id(203), id(201)],
      services: [id(303), id(307)],
      hours: [shift('mon,tue,wed,thu,fri', '09:00', '13:00')],
    },
  },
  {
    n: 9, username: 'dr.arias', email: 'pablo.arias@medicitas.local', firstName: 'Pablo', lastName: 'Arias', role: 'professional', clinic: id(101),
    professional: {
      id: id(504), fullName: 'Dr. Pablo Arias', specialties: [id(201)],
      services: [id(301), id(306)],
      hours: [shift('mon,wed,fri', '07:00', '11:00'), shift('tue,thu', '13:00', '19:00')],
    },
  },
  // Left the clinic in September: logical deletion keeps the user, the professional
  // and the appointments; Keycloak keeps the account disabled.
  {
    n: 15, username: 'dr.campos', email: 'jorge.campos@medicitas.local', firstName: 'Jorge', lastName: 'Campos', role: 'professional', clinic: id(101), active: false,
    professional: {
      id: id(508), fullName: 'Dr. Jorge Campos', specialties: [id(201)],
      services: [id(301)],
      hours: [],
    },
  },

  // Clinic 2: East Curridabat
  { n: 6, username: 'admin.curri', email: 'admin.curri@medicitas.local', firstName: 'Gabriel', lastName: 'Nunez', role: 'clinic_admin', clinic: id(102), firstAdmin: true },
  { n: 8, username: 'reception.curri', email: 'reception.curri@medicitas.local', firstName: 'Karla', lastName: 'Jimenez', role: 'receptionist', clinic: id(102) },
  {
    n: 7, username: 'dr.vega', email: 'elena.vega@medicitas.local', firstName: 'Elena', lastName: 'Vega', role: 'professional', clinic: id(102),
    professional: {
      id: id(503), fullName: 'Dr. Elena Vega', specialties: [id(201), id(204)],
      services: [id(304), id(305)],
      hours: [shift('mon,tue,wed,thu', '08:00', '16:00')],
    },
  },
  {
    n: 10, username: 'dr.quesada', email: 'mariana.quesada@medicitas.local', firstName: 'Mariana', lastName: 'Quesada', role: 'professional', clinic: id(102),
    professional: {
      id: id(505), fullName: 'Dr. Mariana Quesada', specialties: [id(203), id(201)],
      services: [id(308), id(304)],
      hours: [shift('mon,tue,wed,thu,fri', '13:00', '18:00')],
    },
  },

  // Clinic 3: North Heredia
  { n: 11, username: 'admin.heredia', email: 'admin.heredia@medicitas.local', firstName: 'Gabriela', lastName: 'Soto', role: 'clinic_admin', clinic: id(103), firstAdmin: true },
  { n: 12, username: 'reception.heredia', email: 'reception.heredia@medicitas.local', firstName: 'Luis', lastName: 'Herrera', role: 'receptionist', clinic: id(103) },
  {
    n: 13, username: 'dr.chaves', email: 'ricardo.chaves@medicitas.local', firstName: 'Ricardo', lastName: 'Chaves', role: 'professional', clinic: id(103),
    professional: {
      id: id(506), fullName: 'Dr. Ricardo Chaves', specialties: [id(201), id(202)],
      services: [id(309), id(310)],
      hours: [shift('mon,tue,wed,thu,fri', '08:00', '12:00'), shift('mon,wed', '14:00', '18:00')],
    },
  },
  {
    n: 14, username: 'dr.alfaro', email: 'paula.alfaro@medicitas.local', firstName: 'Paula', lastName: 'Alfaro', role: 'professional', clinic: id(103),
    professional: {
      id: id(507), fullName: 'Dr. Paula Alfaro', specialties: [id(205), id(201)],
      services: [id(311), id(309)],
      hours: [shift('tue,wed,thu,fri,sat', '09:00', '15:00')],
    },
  },
].map((u) => ({ ...u, appUserId: id(400 + u.n), sub: id(1000 + u.n), active: u.active ?? true }));

export const userByName = Object.fromEntries(users.map((u) => [u.username, u]));
const appUser = (username) => userByName[username].appUserId;

export const blocks = [
  { id: id(751), clinic: id(101), professional: id(501), startsAt: '2026-12-24T18:00:00Z', endsAt: '2026-12-25T00:00:00Z', reason: 'Christmas Eve afternoon leave' },
  { id: id(752), clinic: id(102), professional: id(503), startsAt: '2026-12-21T06:00:00Z', endsAt: '2027-01-04T06:00:00Z', reason: 'Year-end vacation' },
  { id: id(753), clinic: id(103), professional: id(506), startsAt: '2026-11-26T06:00:00Z', endsAt: '2026-11-27T06:00:00Z', reason: 'National cardiology congress' },
  { id: id(754), clinic: id(101), professional: id(502), startsAt: '2026-09-21T06:00:00Z', endsAt: '2026-09-26T06:00:00Z', reason: 'Medical leave' },
  { id: id(755), clinic: id(103), professional: id(507), startsAt: '2027-01-15T15:00:00Z', endsAt: '2027-01-15T18:00:00Z', reason: 'Continuing education course' },
];

// Patients the docs and the Postman collection name. They only appear in past
// generated history, never in a future booking, so they are always free to book.
export const namedPatients = [
  { clinic: id(101), id: id(601), identification: '1-1234-5678', fullName: 'Sofia Ramirez', birthDate: '1992-05-14', phone: '+506-8888-1111', email: 'sofia.ramirez@example.com' },
  { clinic: id(101), id: id(602), identification: '1-2345-6789', fullName: 'Mateo Vargas', birthDate: '1985-11-03', phone: '+506-8888-2222', email: 'mateo.vargas@example.com' },
  { clinic: id(101), id: id(603), identification: '1-3456-7890', fullName: 'Lucia Mendez', birthDate: '2018-03-22', phone: '+506-8888-3333', email: 'lucia.parent@example.com' },
  { clinic: id(102), id: id(604), identification: '2-1111-2222', fullName: 'Andres Rojas', birthDate: '1990-08-19', phone: '+506-8888-4444', email: 'andres.rojas@example.com' },
  { clinic: id(103), id: id(605), identification: '4-0123-0456', fullName: 'Isabel Navarro', birthDate: '1978-02-09', phone: '+506-8888-5555', email: 'isabel.navarro@example.com' },
  { clinic: id(103), id: id(606), identification: '4-0234-0567', fullName: 'Tomas Araya', birthDate: '1966-07-30', phone: '+506-8888-6666', email: null },
  { clinic: id(102), id: id(607), identification: '1-1987-0654', fullName: 'Camila Solano', birthDate: '2016-10-05', phone: '+506-8888-7777', email: 'camila.parent@example.com' },
];

// How many generated patients each clinic gets, besides the named ones.
export const generatedPatients = { [id(101)]: 26, [id(102)]: 18, [id(103)]: 18 };

const C1 = id(101);
const C2 = id(102);
const C3 = id(103);

// Fixed appointments the demo relies on. Times are UTC; Costa Rica is UTC-6.
// Fields left out are derived: status_changed_* from the outcome, updated_at from it.
export const curatedAppointments = [
  {
    label: 'Attended appointment (Clinic 1) with clinical note',
    clinic: C1, id: id(801), professional: id(501), patient: id(601), service: id(301),
    startsAt: '2026-11-10T14:00:00Z', status: 'attended', createdBy: appUser('reception.sj'), createdAt: '2026-11-08T15:00:00Z',
    statusChangedAt: '2026-11-10T14:35:00Z', statusChangedBy: appUser('dr.mora'),
    note: { id: id(901), content: 'Routine annual checkup completed. Blood pressure 118/76 mmHg; no acute findings.', createdAt: '2026-11-10T14:36:00Z' },
  },
  {
    label: 'Original appointment that was rescheduled (Clinic 1)',
    clinic: C1, id: id(802), professional: id(501), patient: id(602), service: id(302),
    startsAt: '2026-11-11T15:00:00Z', status: 'rescheduled', createdBy: appUser('reception.sj'), createdAt: '2026-11-08T16:00:00Z',
    statusChangedAt: '2026-11-09T10:00:00Z', statusChangedBy: appUser('reception.sj'),
  },
  {
    label: 'Replacement booked future appointment (Clinic 1)',
    clinic: C1, id: id(803), professional: id(501), patient: id(602), service: id(302), rescheduledFrom: id(802),
    startsAt: '2027-02-01T15:00:00Z', status: 'booked', createdBy: appUser('reception.sj'), createdAt: '2026-11-09T10:00:00Z',
  },
  {
    label: 'Started booked appointment (Clinic 1) ready for outcome recording',
    clinic: C1, id: id(804), professional: id(501), patient: id(601), service: id(301),
    startsAt: '2026-11-12T16:00:00Z', status: 'booked', createdBy: appUser('reception.sj'), createdAt: '2026-11-10T09:00:00Z',
  },
  {
    label: 'Cancelled appointment (Clinic 1)',
    clinic: C1, id: id(805), professional: id(502), patient: id(603), service: id(303),
    startsAt: '2026-11-13T15:00:00Z', status: 'cancelled', createdBy: appUser('reception.sj'), createdAt: '2026-11-10T11:00:00Z',
    statusChangedAt: '2026-11-11T08:30:00Z', statusChangedBy: appUser('reception.sj'), cancelReason: 'Guardian requested reschedule',
  },
  {
    label: 'Booked future appointment (Clinic 2) for multi-tenant isolation verification',
    clinic: C2, id: id(806), professional: id(503), patient: id(604), service: id(305),
    startsAt: '2027-02-02T14:00:00Z', status: 'booked', createdBy: appUser('admin.curri'), createdAt: '2026-11-12T12:00:00Z',
  },
  {
    label: 'No-show (Clinic 1): the patient did not come',
    clinic: C1, id: id(807), professional: id(501), patient: id(603), service: id(301),
    startsAt: '2026-11-11T16:00:00Z', status: 'no_show', createdBy: appUser('reception2.sj'), createdAt: '2026-11-04T17:10:00Z',
    statusChangedAt: '2026-11-11T16:45:00Z', statusChangedBy: appUser('dr.mora'),
  },
  {
    label: 'Attended appointment (Clinic 2) with clinical note',
    clinic: C2, id: id(808), professional: id(503), patient: id(604), service: id(305),
    startsAt: '2026-11-09T15:00:00Z', status: 'attended', createdBy: appUser('reception.curri'), createdAt: '2026-11-02T14:20:00Z',
    statusChangedAt: '2026-11-09T15:40:00Z', statusChangedBy: appUser('dr.vega'),
    note: { id: id(902), content: 'Two benign nevi on the left forearm, unchanged since the last screening. Sunscreen advised; next screening in 12 months.', createdAt: '2026-11-09T15:42:00Z' },
  },
  {
    label: 'Booked future appointment (Clinic 3)',
    clinic: C3, id: id(809), professional: id(506), patient: id(605), service: id(310),
    startsAt: '2027-02-03T14:00:00Z', status: 'booked', createdBy: appUser('reception.heredia'), createdAt: '2026-11-12T15:30:00Z',
  },
  {
    label: 'Attended appointment (Clinic 3) with an edited clinical note',
    clinic: C3, id: id(810), professional: id(507), patient: id(606), service: id(311),
    startsAt: '2026-11-11T16:00:00Z', status: 'attended', createdBy: appUser('reception.heredia'), createdAt: '2026-11-05T13:00:00Z',
    statusChangedAt: '2026-11-11T16:45:00Z', statusChangedBy: appUser('dr.alfaro'),
    note: {
      id: id(903), content: 'BMI 31.2. Agreed on a 1800 kcal plan and three walks a week. Fasting glucose ordered; review in 4 weeks.',
      createdAt: '2026-11-11T16:48:00Z', updatedAt: '2026-11-12T13:05:00Z',
    },
  },
  {
    label: 'Cancelled future appointment (Clinic 3)',
    clinic: C3, id: id(811), professional: id(506), patient: id(606), service: id(309),
    startsAt: '2027-02-04T15:00:00Z', status: 'cancelled', createdBy: appUser('reception.heredia'), createdAt: '2026-11-06T14:00:00Z',
    statusChangedAt: '2026-11-13T19:15:00Z', statusChangedBy: appUser('admin.heredia'), cancelReason: 'Patient travelling abroad',
  },
  {
    label: 'Rescheduled appointment (Clinic 2) ...',
    clinic: C2, id: id(812), professional: id(505), patient: id(607), service: id(308),
    startsAt: '2027-02-01T20:00:00Z', status: 'rescheduled', createdBy: appUser('reception.curri'), createdAt: '2026-11-03T15:00:00Z',
    statusChangedAt: '2026-11-13T16:20:00Z', statusChangedBy: appUser('reception.curri'),
  },
  {
    label: '... and its replacement, one week later',
    clinic: C2, id: id(813), professional: id(505), patient: id(607), service: id(308), rescheduledFrom: id(812),
    startsAt: '2027-02-08T20:00:00Z', status: 'booked', createdBy: appUser('reception.curri'), createdAt: '2026-11-13T16:20:00Z',
  },
  {
    label: 'Home visit before the service was retired (Clinic 1)',
    clinic: C1, id: id(814), professional: id(502), patient: id(602), service: id(307),
    startsAt: '2026-09-03T17:00:00Z', status: 'attended', createdBy: appUser('admin.sj'), createdAt: '2026-08-27T15:00:00Z',
    statusChangedAt: '2026-09-03T18:05:00Z', statusChangedBy: appUser('dr.solis'),
    note: { id: id(904), content: 'Home visit after knee surgery. Wound clean, no signs of infection. Stitches out in 5 days.', createdAt: '2026-09-03T18:10:00Z' },
  },
  {
    label: 'Seen by a professional who later left the clinic (Clinic 1)',
    clinic: C1, id: id(815), professional: id(508), patient: id(601), service: id(301),
    startsAt: '2026-08-18T15:00:00Z', status: 'attended', createdBy: appUser('reception.sj'), createdAt: '2026-08-10T16:00:00Z',
    statusChangedAt: '2026-08-18T15:35:00Z', statusChangedBy: appUser('dr.campos'),
    note: { id: id(905), content: 'Seasonal allergic rhinitis. Loratadine 10 mg daily for 14 days; return if fever appears.', createdAt: '2026-08-18T15:38:00Z' },
  },
];

// Audit entries that go with the curated appointments, besides the ones the
// generator derives from every note (create/update).
export const curatedAudit = [
  { clinic: C1, id: '019a0000-0000-7000-8000-000000000a02', appUser: appUser('reception.sj'), patient: id(601), action: 'read', resource: 'patient_contact', resourceId: id(601), occurredAt: '2026-11-12T15:50:00Z' },
  { clinic: C1, id: id(2601), appUser: appUser('dr.mora'), patient: id(601), action: 'read', resource: 'clinical_note', resourceId: id(905), occurredAt: '2026-11-10T14:03:00Z' },
  { clinic: C2, id: id(2602), appUser: appUser('reception.curri'), patient: id(604), action: 'update', resource: 'patient_contact', resourceId: id(604), occurredAt: '2026-11-02T14:18:00Z' },
];
// The create entry of note 901 keeps the id it always had.
export const fixedNoteAuditIds = { [id(901)]: '019a0000-0000-7000-8000-000000000a01' };

export const cancelReasons = [
  'Patient requested cancellation', 'Patient feels better', 'Work schedule conflict', 'Transportation problem',
  'Patient travelling abroad', 'Duplicate booking', 'Professional unavailable', 'Patient admitted to hospital',
];

// Clinical note templates per specialty. {n} is replaced with a small number.
export const noteTemplates = {
  [id(201)]: [
    'Upper respiratory infection. Symptomatic treatment, fluids and rest; return if fever lasts over {n} days.',
    'Blood pressure {bp} mmHg. Lifestyle advice given; recheck in {n} weeks.',
    'Follow-up of type 2 diabetes. HbA1c reviewed, metformin unchanged. Next control in {n} months.',
    'Lower back pain after lifting. No red flags. Ibuprofen for {n} days and stretching exercises.',
    'Annual checkup. Labs within normal range; vaccines up to date.',
    'Acute gastroenteritis. Oral rehydration, bland diet; return if symptoms persist {n} days.',
  ],
  [id(202)]: [
    'Atypical chest pain. ECG in sinus rhythm, no ischemic changes. Stress test requested.',
    'Hypertension follow-up: {bp} mmHg. Losartan dose kept; home readings for {n} weeks.',
    'Palpitations. Holter monitor ordered for {n} hours; caffeine reduction advised.',
    'Post-infarction control. Stable, no angina. Continue antiplatelet therapy; echo in {n} months.',
  ],
  [id(203)]: [
    'Well-child visit. Growth on the 60th percentile; vaccination schedule up to date.',
    'Acute otitis media, right ear. Amoxicillin for {n} days; review if pain persists.',
    'Fever for 2 days, viral pharyngitis. Paracetamol by weight; return if fever lasts over {n} days.',
    'Mild asthma exacerbation. Salbutamol inhaler with spacer; control in {n} weeks.',
  ],
  [id(204)]: [
    'Acne vulgaris, moderate. Topical adapalene; review in {n} weeks.',
    'Mole screening. No suspicious lesions; next screening in 12 months.',
    'Contact dermatitis on the hands. Topical corticosteroid for {n} days; avoid detergents.',
  ],
  [id(205)]: [
    'Initial assessment. BMI {bmi}. Meal plan agreed; follow-up in {n} weeks.',
    'Follow-up: lost 2 kg since the last visit. Plan kept; increase physical activity.',
    'Dyslipidemia. Low saturated fat plan; lipid profile in {n} months.',
  ],
};

export const firstNames = [
  'Maria', 'Jose', 'Ana', 'Luis', 'Carmen', 'Jorge', 'Daniela', 'Andrea', 'Fernando', 'Gabriel',
  'Natalia', 'Ricardo', 'Paola', 'Esteban', 'Mariela', 'Sebastian', 'Valentina', 'Alejandro', 'Fabiola', 'Mauricio',
  'Adriana', 'Rodrigo', 'Silvia', 'Kevin', 'Monica', 'Josue', 'Raquel', 'Ignacio', 'Lorena', 'Emilio',
];
export const lastNames = [
  'Rodriguez', 'Vargas', 'Jimenez', 'Rojas', 'Araya', 'Solano', 'Alvarado', 'Calderon', 'Herrera', 'Salazar',
  'Ulate', 'Monge', 'Sanchez', 'Cordero', 'Fallas', 'Zuniga', 'Barrantes', 'Villalobos', 'Madrigal', 'Segura',
  'Montero', 'Picado', 'Arguedas', 'Leiva', 'Porras', 'Umana', 'Badilla', 'Cascante', 'Elizondo', 'Gamboa',
];
