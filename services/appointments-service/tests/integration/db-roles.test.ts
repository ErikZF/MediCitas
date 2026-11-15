import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { adminA, patient, PROF_1, receptionA, SERVICE_30, startBookingApp, type BookingApp } from '../helpers/booking-app.ts';

// Data protection (core module 5): every request runs as the database role of its
// actor, not as one shared application role (MEDICITAS_DB_ROLES in @medicitas/db):
//
//   clinic_admin -> db_admin   receptionist -> db_receptionist   professional -> db_professional
//
// The grants of init.sql are the permission matrix at engine level, and RLS still
// applies on top of them. A bug in the code cannot give an actor more than its role.
const url = process.env.TEST_DATABASE_URL;

// [database role, table, privilege, granted?]
const MATRIX: Array<[string, string, string, boolean]> = [
  ['db_admin', 'appointment', 'INSERT', true],
  ['db_admin', 'working_hours', 'UPDATE', true],
  ['db_admin', 'clinical_note', 'SELECT', false],
  ['db_receptionist', 'appointment', 'INSERT', true],
  ['db_receptionist', 'appointment', 'UPDATE', true],
  ['db_receptionist', 'appointment', 'DELETE', false],
  ['db_receptionist', 'working_hours', 'INSERT', false],
  ['db_receptionist', 'clinical_note', 'SELECT', false],
  ['db_professional', 'appointment', 'INSERT', false],
  ['db_professional', 'appointment', 'UPDATE', true],
  ['db_professional', 'working_hours', 'INSERT', true],
  ['db_professional', 'clinical_note', 'SELECT', true],
  ['db_professional', 'clinical_note', 'INSERT', true],
  ['db_professional', 'clinical_note', 'DELETE', false],
  ['db_admin', 'outbox', 'SELECT', false],
  ['db_receptionist', 'outbox', 'SELECT', false],
  ['db_professional', 'outbox', 'SELECT', false],
];

describe.skipIf(!url)('one database role per actor (least privilege)', () => {
  let app: BookingApp;

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'db_roles',
      timeZone: 'UTC',
      workingHours: [{ weekday: 1, startTime: '08:00', endTime: '12:00' }],
    });
  });

  afterAll(async () => { await app?.close(); });

  test.each(MATRIX)('%s on %s: %s is %s', async (role, table, privilege, granted) => {
    const { rows } = await app.pool.query('SELECT has_table_privilege($1, $2, $3) AS ok', [role, table, privilege]);
    assert.equal(rows[0].ok, granted);
  });

  test('a booking runs as the role of whoever books: taking INSERT from db_receptionist stops reception, not the administrator', async () => {
    const book = (ctx: typeof receptionA, n: number, startsAt: string) => app.call('POST', '/appointments', ctx, {
      professionalId: PROF_1, patientId: patient(n), serviceId: SERVICE_30, startsAt,
    });

    assert.equal((await book(receptionA, 1, '2026-03-02T08:00:00Z')).status, 201);

    await app.pool.query('REVOKE INSERT ON appointment FROM db_receptionist');
    try {
      const reception = await book(receptionA, 2, '2026-03-02T09:00:00Z');
      assert.equal(reception.status, 403);
      assert.equal(reception.body.code, 'forbidden');
      assert.equal((await book(adminA, 3, '2026-03-02T10:00:00Z')).status, 201);
    } finally {
      await app.pool.query('GRANT INSERT ON appointment TO db_receptionist');
    }
    assert.equal((await book(receptionA, 2, '2026-03-02T09:00:00Z')).status, 201);
  });
});
