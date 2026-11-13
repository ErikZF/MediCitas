import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { TenantContext } from '@medicitas/db';
import {
  adminA, CLINIC_A, CLINIC_B, patient, PROF_1, PROF_2, receptionA, SERVICE_30, startBookingApp, USER,
  type BookingApp,
} from '../helpers/booking-app.ts';

// RF15 (clinical note) and the producer side of RF18 (audit events in the outbox), over
// HTTP against the real appointments schema.
const url = process.env.TEST_DATABASE_URL;

const OTHER_USER = '8d2f5c3b-0e4a-4f7b-9c6d-3b2a7e0f4c05';
const professional = (professionalId: string, clinicId = CLINIC_A): TenantContext =>
  ({ clinicId, userId: professionalId === PROF_1 ? USER : OTHER_USER, role: 'professional', professionalId });
const prof1 = professional(PROF_1);
const prof2 = professional(PROF_2);
const NOW = new Date('2027-01-04T20:00:00Z');

describe.skipIf(!url)('clinical note (RF15) and its audit events (RF18)', () => {
  let app: BookingApp;
  let slot = 0;

  /** An appointment of PROF_1 inserted directly with the status the test needs. */
  const appointmentOf = async (status: 'attended' | 'booked' | 'no_show', patientNumber = 1, professionalId = PROF_1) => {
    const startsAt = new Date(Date.UTC(2027, 0, 4, 8) + (slot++) * 30 * 60_000);
    const result = await app.pool.query(
      `INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at, duration_minutes, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 30, $7, $8) RETURNING appointment_id`,
      [CLINIC_A, professionalId, patient(patientNumber), SERVICE_30, startsAt, new Date(startsAt.getTime() + 30 * 60_000), status, USER],
    );
    return result.rows[0].appointment_id as string;
  };
  const note = (method: string, appointmentId: string, ctx: TenantContext, body?: unknown) =>
    app.call(method, `/appointments/${appointmentId}/note`, ctx, body);
  const auditEvents = async (resourceId?: string) => {
    const result = await app.pool.query(
      `SELECT clinic_id, aggregate_id, payload, published_at FROM outbox
       WHERE event_type = 'AuditRecorded' AND ($1::uuid IS NULL OR aggregate_id = $1) ORDER BY created_at, event_id`,
      [resourceId ?? null],
    );
    return result.rows as Array<{ clinic_id: string; aggregate_id: string; payload: Record<string, string>; published_at: Date | null }>;
  };

  beforeAll(async () => {
    app = await startBookingApp({
      adminUrl: url as string,
      label: 'clinical_note',
      timeZone: 'UTC',
      workingHours: [],
      now: () => NOW,
    });
  });

  afterAll(async () => { await app?.close(); });

  test('the professional who attended writes, reads and edits the note; each access is one audit event', async () => {
    const appointmentId = await appointmentOf('attended', 7);

    const created = await note('POST', appointmentId, prof1, { content: 'Dolor lumbar. Reposo 3 días.' });
    assert.equal(created.status, 201);
    assert.equal(created.body.appointmentId, appointmentId);
    assert.equal(created.body.professionalId, PROF_1);
    assert.equal(created.body.content, 'Dolor lumbar. Reposo 3 días.');
    const noteId = created.body.clinicalNoteId as string;

    const read = await note('GET', appointmentId, prof1);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, created.body);

    const edited = await note('PUT', appointmentId, prof1, { content: 'Dolor lumbar. Reposo 5 días.' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.content, 'Dolor lumbar. Reposo 5 días.');
    assert.equal(edited.body.clinicalNoteId, noteId);

    const events = await auditEvents(noteId);
    assert.deepEqual(events.map((e) => e.payload.action), ['create', 'read', 'update']);
    for (const event of events) {
      assert.equal(event.clinic_id, CLINIC_A);
      assert.equal(event.published_at, null, 'pending until the relay (N10) copies it');
      assert.deepEqual(event.payload, {
        appUserId: USER,
        patientId: patient(7),
        action: event.payload.action,
        resource: 'clinical_note',
        resourceId: noteId,
        occurredAt: NOW.toISOString(),
      });
      assert.equal(JSON.stringify(event.payload).includes('Dolor'), false, 'the event never carries the note itself');
    }
  });

  test('409 note_exists: one note per appointment, also when two POSTs race', async () => {
    const appointmentId = await appointmentOf('attended');
    const results = await Promise.all([
      note('POST', appointmentId, prof1, { content: 'Primera' }),
      note('POST', appointmentId, prof1, { content: 'Segunda' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal(results.find((r) => r.status === 409)!.body.code, 'note_exists');

    const stored = await app.pool.query('SELECT clinical_note_id FROM clinical_note WHERE appointment_id = $1', [appointmentId]);
    assert.equal(stored.rowCount, 1);
    assert.equal((await auditEvents(stored.rows[0].clinical_note_id)).length, 1, 'the losing POST left no event');
  });

  test('422 appointment_not_attended: booked or no_show appointments get no note', async () => {
    for (const status of ['booked', 'no_show'] as const) {
      const result = await note('POST', await appointmentOf(status), prof1, { content: 'Nota' });
      assert.equal(result.status, 422, status);
      assert.equal(result.body.code, 'appointment_not_attended', status);
    }
  });

  test('422: empty content or extra fields', async () => {
    const appointmentId = await appointmentOf('attended');
    for (const body of [{ content: '   ' }, {}, { content: 'Nota', professionalId: PROF_2 }]) {
      const result = await note('POST', appointmentId, prof1, body);
      assert.equal(result.status, 422, JSON.stringify(body));
    }
  });

  test('404 when the appointment has no note yet, and nothing is audited', async () => {
    const appointmentId = await appointmentOf('attended');
    const before = (await auditEvents()).length;
    assert.equal((await note('GET', appointmentId, prof1)).status, 404);
    assert.equal((await note('PUT', appointmentId, prof1, { content: 'Nota' })).status, 404);
    assert.equal((await auditEvents()).length, before);
  });

  describe('nobody else reads or writes it', () => {
    let appointmentId: string;
    let eventsBefore: number;

    beforeAll(async () => {
      appointmentId = await appointmentOf('attended', 8);
      assert.equal((await note('POST', appointmentId, prof1, { content: 'Confidencial' })).status, 201);
      eventsBefore = (await auditEvents()).length;
    });

    test('403: another professional of the same clinic', async () => {
      assert.equal((await note('GET', appointmentId, prof2)).status, 403);
      assert.equal((await note('PUT', appointmentId, prof2, { content: 'Cambio' })).status, 403);
      assert.equal((await note('POST', await appointmentOf('attended', 9), prof2, { content: 'Ajena' })).status, 403);
    });

    test('403: reception and the clinic administrator', async () => {
      for (const ctx of [receptionA, adminA]) {
        assert.equal((await note('GET', appointmentId, ctx)).status, 403, ctx.role);
        assert.equal((await note('PUT', appointmentId, ctx, { content: 'Cambio' })).status, 403, ctx.role);
      }
    });

    test('404: a professional of another clinic does not even see the appointment (RLS)', async () => {
      const result = await note('GET', appointmentId, professional(PROF_1, CLINIC_B));
      assert.equal(result.status, 404);
    });

    test('RLS hides the note from another professional even if the code skipped its checks', async () => {
      const client = await app.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT app_set_session_context($1, $2, $3, $4, true)', [CLINIC_A, OTHER_USER, 'professional', PROF_2]);
        await client.query('SET LOCAL ROLE medicitas_app');
        const visible = await client.query('SELECT count(*)::int AS n FROM clinical_note WHERE appointment_id = $1', [appointmentId]);
        assert.equal(visible.rows[0].n, 0);
        const updated = await client.query(`UPDATE clinical_note SET content = 'x' WHERE appointment_id = $1`, [appointmentId]);
        assert.equal(updated.rowCount, 0);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    test('rejected attempts leave no audit event and the note unchanged', async () => {
      assert.equal((await auditEvents()).length, eventsBefore);
      const stored = await app.pool.query('SELECT content FROM clinical_note WHERE appointment_id = $1', [appointmentId]);
      assert.equal(stored.rows[0].content, 'Confidencial');
    });
  });

  test('if the audit event cannot be stored, the note is neither written nor read', async () => {
    const appointmentId = await appointmentOf('attended');
    const existing = await appointmentOf('attended');
    assert.equal((await note('POST', existing, prof1, { content: 'Antes' })).status, 201);

    // Make every new outbox row fail, as a full disk or a broken grant would.
    await app.pool.query('ALTER TABLE outbox ADD CONSTRAINT test_outbox_down CHECK (false) NOT VALID');
    try {
      assert.notEqual((await note('POST', appointmentId, prof1, { content: 'Nota' })).status, 201);
      assert.notEqual((await note('GET', existing, prof1)).status, 200);
      assert.notEqual((await note('PUT', existing, prof1, { content: 'Después' })).status, 200);
    } finally {
      await app.pool.query('ALTER TABLE outbox DROP CONSTRAINT test_outbox_down');
    }

    const created = await app.pool.query('SELECT 1 FROM clinical_note WHERE appointment_id = $1', [appointmentId]);
    assert.equal(created.rowCount, 0, 'the note rolled back with its event');
    const kept = await app.pool.query('SELECT content FROM clinical_note WHERE appointment_id = $1', [existing]);
    assert.equal(kept.rows[0].content, 'Antes');
  });
});
