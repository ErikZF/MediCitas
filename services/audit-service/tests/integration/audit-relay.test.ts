import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, test } from 'vitest';
import type { Database } from '@medicitas/db';
import { relayAuditEvents, type RelaySource } from '../../modules/audit-relay/audit-relay.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

// RF18 delivery against three real schemas: the producers' outboxes (appointments_db,
// users_db) and the append-only audit_log (logs_db).
const url = process.env.TEST_DATABASE_URL;

const CLINIC_A = '019a0000-0000-7000-8000-00000000a001';
const CLINIC_B = '019a0000-0000-7000-8000-00000000b002';
const USER = '019a0000-0000-7000-8000-0000000000c1';
const PATIENT = '019a0000-0000-7000-8000-0000000000d1';

async function sourceDatabase(adminUrl: string, schema: 'appointments' | 'users') {
  const name = `medicitas_relay_${schema}_${process.pid}_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 2 });
  await pool.query(readFileSync(new URL(`../../../../database/${schema}/init.sql`, import.meta.url), 'utf8'));
  return {
    pool,
    source: { name: schema, db: drizzle({ client: pool }) as unknown as Database } satisfies RelaySource,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}

const event = (overrides: Record<string, unknown> = {}) => ({
  appUserId: USER, patientId: PATIENT, action: 'read', resource: 'clinical_note',
  resourceId: randomUUID(), occurredAt: '2027-01-04T15:00:00.000Z', ...overrides,
});

describe.skipIf(!url)('audit relay (RF18): outbox events reach audit_log', () => {
  let logs: Awaited<ReturnType<typeof createTestDatabase>>;
  let appointments: Awaited<ReturnType<typeof sourceDatabase>>;
  let users: Awaited<ReturnType<typeof sourceDatabase>>;

  const enqueue = async (pool: pg.Pool, clinicId: string, payload: unknown, type = 'AuditRecorded') =>
    (await pool.query(
      `INSERT INTO outbox (clinic_id, aggregate_id, event_type, payload) VALUES ($1, $2, $3, $4) RETURNING event_id`,
      [clinicId, PATIENT, type, JSON.stringify(payload)],
    )).rows[0].event_id as string;
  const pending = async (pool: pg.Pool) =>
    (await pool.query(`SELECT event_type FROM outbox WHERE published_at IS NULL ORDER BY created_at`)).rows.map((r) => r.event_type);
  const logged = async (id: string) =>
    (await logs.pool.query(`SELECT clinic_id, app_user_id, patient_id, action, resource, occurred_at FROM audit_log WHERE audit_log_id = $1`, [id])).rows;

  beforeAll(async () => {
    logs = await createTestDatabase(url as string);
    appointments = await sourceDatabase(url as string, 'appointments');
    users = await sourceDatabase(url as string, 'users');
  });

  afterAll(async () => {
    await logs?.drop();
    await appointments?.drop();
    await users?.drop();
  });

  test('note events of two clinics land in audit_log with the event id; other events are not touched', async () => {
    const a = await enqueue(appointments.pool, CLINIC_A, event());
    const b = await enqueue(appointments.pool, CLINIC_B, event({ action: 'create' }));
    await enqueue(appointments.pool, CLINIC_A, { professionalId: USER, dates: null }, 'AgendaChanged');

    assert.equal(await relayAuditEvents(appointments.source, logs.db), 2);
    assert.deepEqual(await logged(a), [{
      clinic_id: CLINIC_A, app_user_id: USER, patient_id: PATIENT, action: 'read', resource: 'clinical_note',
      occurred_at: new Date('2027-01-04T15:00:00.000Z'),
    }]);
    assert.equal((await logged(b))[0].clinic_id, CLINIC_B);
    assert.deepEqual(await pending(appointments.pool), ['AgendaChanged'], 'the cache relay owns AgendaChanged');
    assert.equal(await relayAuditEvents(appointments.source, logs.db), 0, 'nothing is delivered twice');
  });

  test('patient contact events from users_db are delivered too', async () => {
    const id = await enqueue(users.pool, CLINIC_A, event({ resource: 'patient_contact', action: 'update', resourceId: PATIENT }));
    assert.equal(await relayAuditEvents(users.source, logs.db), 1);
    assert.equal((await logged(id))[0].resource, 'patient_contact');
    assert.deepEqual(await pending(users.pool), []);
  });

  test('a relay that died after writing audit_log does not duplicate the row', async () => {
    const payload = event();
    const id = await enqueue(appointments.pool, CLINIC_A, payload);
    // As if the previous pass inserted it and died before marking the event published.
    await logs.pool.query(
      `INSERT INTO audit_log (audit_log_id, clinic_id, app_user_id, patient_id, action, resource, resource_id, occurred_at)
       VALUES ($1, $2, $3, $4, 'read', 'clinical_note', $5, $6)`,
      [id, CLINIC_A, USER, PATIENT, payload.resourceId, payload.occurredAt]);

    assert.equal(await relayAuditEvents(appointments.source, logs.db), 1);
    assert.equal((await logged(id)).length, 1);
    assert.deepEqual(await pending(appointments.pool), ['AgendaChanged']);
  });

  test('if logs_db is unreachable, the events stay pending', async () => {
    const down = new pg.Pool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', connectionTimeoutMillis: 500 });
    await enqueue(appointments.pool, CLINIC_B, event());
    await assert.rejects(relayAuditEvents(appointments.source, drizzle({ client: down }) as unknown as Database));
    await down.end();
    assert.deepEqual(await pending(appointments.pool), ['AgendaChanged', 'AuditRecorded']);
    assert.equal(await relayAuditEvents(appointments.source, logs.db), 1);
  });

  test('a malformed event is left pending and does not block the others', async () => {
    await enqueue(users.pool, CLINIC_A, { appUserId: 'not-a-uuid' });
    const good = await enqueue(users.pool, CLINIC_A, event({ resource: 'patient_contact' }));
    assert.equal(await relayAuditEvents(users.source, logs.db), 1);
    assert.equal((await logged(good)).length, 1);
    assert.deepEqual(await pending(users.pool), ['AuditRecorded']);
  });

  test('audit_log stays append-only: the relay role cannot rewrite it', async () => {
    const [{ count }] = (await logs.pool.query('SELECT count(*)::int AS count FROM audit_log')).rows;
    await assert.rejects(logs.pool.query(`UPDATE audit_log SET action = 'create'`), /append-only/);
    assert.equal((await logs.pool.query('SELECT count(*)::int AS count FROM audit_log')).rows[0].count, count);
  });
});
