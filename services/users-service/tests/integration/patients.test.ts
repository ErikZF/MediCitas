import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MEDICITAS_APP_ROLE, withTenantTx, type TenantContext } from '@medicitas/db';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const upgrade = readFileSync(new URL('../../../../database/updates/users/upgrade-patient-audit-outbox.sql', import.meta.url), 'utf8');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clinic = id(1), foreignClinic = id(2), user = id(10), professionalUser = id(11), professionalId = id(12);
const legacy = id(100), foreignPatient = id(200);
const ctx: TenantContext = { clinicId: clinic, userId: user, role: 'receptionist' };
const input = { identification: '001234567', fullName: 'Ana Pérez', birthDate: '1990-05-20', phone: '8888-8888', email: 'ana@example.com' };
const now = new Date('2026-11-13T18:00:00.000Z');

// Normal users server.ts, real Bearer and PostgreSQL, using the existing DB helper.
describe.skipIf(!url)('RF14 patients and repeatable users outbox upgrade', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const servers: Server[] = [];
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  let base: string;
  let signed: (role?: string, clinicId?: string) => Promise<string>;

  async function listen(server: Server) {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }

  beforeAll(async () => {
    database = await createTestDatabase(url!, 'users');
    assert.match(new URL(database.url).pathname, /^\/medicitas_rf4_users_/);
    // Simulate the legacy schema only in this fresh disposable database. When
    // init.sql gains outbox, it is still empty here; no shared data is removed.
    const existing = await database.pool.query("SELECT to_regclass('public.outbox') AS name");
    if (existing.rows[0].name) {
      assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
      await database.pool.query('DROP TABLE public.outbox');
    }
    await database.pool.query(`INSERT INTO app_user (app_user_id, keycloak_sub, clinic_id, role_code)
      VALUES ($1, 'rf14-reception', $3, 'receptionist'), ($2, 'rf14-professional', $3, 'professional')`,
    [user, professionalUser, clinic]);
    await database.pool.query(`INSERT INTO professional (professional_id, clinic_id, app_user_id, full_name)
      VALUES ($1, $2, $3, 'Profesional existente')`, [professionalId, clinic, professionalUser]);
    await database.pool.query(`INSERT INTO patient (patient_id, clinic_id, identification, full_name, birth_date, phone)
      VALUES ($1, $2, 'legacy', 'Paciente existente', '1980-01-01', '7777-7777')`, [legacy, clinic]);
    // First application creates the queue on an already populated users schema.
    await database.pool.query(upgrade);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'rf14', alg: 'RS256', use: 'sig' };
    const identity = await listen(createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ keys: [jwk] }))));
    const issuer = `${identity}/realms/RF14`;
    signed = (role = 'receptionist', clinicId = clinic) => new SignJWT({
      sub: 'rf14-subject', app_user_id: role === 'professional' ? professionalUser : user,
      clinic_id: clinicId, role, professional_id: role === 'professional' ? professionalId : undefined,
    }).setProtectedHeader({ alg: 'RS256', kid: 'rf14' }).setIssuer(issuer)
      .setAudience('rf14').setExpirationTime('5m').sign(privateKey);

    const reservation = createServer();
    base = await listen(reservation);
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const target = new URL(database.url);
    const env: NodeJS.ProcessEnv = {
      ...process.env, API_INTERNAL_PORT: new URL(base).port,
      DB_USERS_HOST: target.hostname, DB_CONNECT_PORT: target.port || '5432',
      DB_USERS_NAME: decodeURIComponent(target.pathname.slice(1)),
      DB_USERS_USER: decodeURIComponent(target.username), DB_USERS_PASSWORD: decodeURIComponent(target.password),
      KEYCLOAK_INTERNAL_URL: identity, KEYCLOAK_ISSUER: issuer, KEYCLOAK_AUDIENCE: 'rf14', REALM_NAME: 'RF14',
      // Patients do not call this catalog; the RF4 suite covers its real adapter.
      CLINICS_SERVICE_URL: identity,
    };
    delete env.NODE_OPTIONS;
    delete env.TEST_DATABASE_URL;
    child = spawn(process.execPath, [fileURLToPath(new URL('../../server.ts', import.meta.url))], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve) => child!.once('close', resolve));
    let output = '', launchError: Error | undefined;
    child.on('error', (error) => { launchError = error; });
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.resume();
    const deadline = Date.now() + 10000;
    while (!output.includes('Server running on port ')) {
      assert.ifError(launchError);
      assert.equal(child.exitCode, null, 'Users exited before listening.');
      assert.equal(child.signalCode, null, 'Users stopped before listening.');
      assert.ok(Date.now() < deadline, 'Users startup timed out.');
      await delay(25);
    }
  }, 25000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await database?.drop();
  });

  beforeEach(async () => {
    // The owner inspects/clears only this suite's disposable fixture data.
    await database.pool.query('DELETE FROM outbox');
    await database.pool.query('DELETE FROM patient WHERE patient_id <> $1', [legacy]);
  });

  async function request(method: string, path = '/patients', body?: unknown, bearer?: string | null) {
    const token = bearer === undefined ? await signed() : bearer;
    return fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-clinic-id': foreignClinic, 'x-role': 'platform_admin',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function create(body: unknown = input) {
    const response = await request('POST', undefined, body);
    assert.equal(response.status, 201);
    const dto = await response.json() as { patientId: string };
    assert.deepEqual(Object.keys(dto), ['patientId']);
    assert.equal(response.headers.get('location'), `/patients/${dto.patientId}`);
    return dto.patientId;
  }
  const events = async () => (await database.pool.query(`SELECT event_id, clinic_id, aggregate_id,
    event_type, payload, published_at FROM outbox ORDER BY event_id`)).rows;

  test('upgrade creates outbox and repeated applications preserve patients, professionals and pending/published events', async () => {
    for (const [n, published] of [[900, null], [901, now]] as const) {
      await database.pool.query(`INSERT INTO outbox (event_id, clinic_id, aggregate_id, event_type, payload, published_at)
        VALUES ($1, $2, $3, 'AuditRecorded', $4, $5)`, [id(n), clinic, legacy,
        { appUserId: user, patientId: legacy, action: 'create', resource: 'patient_contact', resourceId: legacy, occurredAt: now.toISOString() }, published]);
    }
    const previousEvents = await events();
    await database.pool.query(upgrade);
    await database.pool.query(upgrade);
    assert.deepEqual(await events(), previousEvents);
    assert.deepEqual((await database.pool.query('SELECT identification, phone FROM patient WHERE patient_id=$1', [legacy])).rows,
      [{ identification: 'legacy', phone: '7777-7777' }]);
    assert.deepEqual((await database.pool.query('SELECT app_user_id FROM professional WHERE professional_id=$1', [professionalId])).rows,
      [{ app_user_id: professionalUser }]);
    await withTenantTx(database.db, ctx, async (tx) => {
      const privileges = await tx.execute(sql`SELECT
        row_security_active('public.outbox'::regclass) AS rls,
        has_table_privilege(current_user, 'public.outbox', 'INSERT') AS enqueue,
        has_table_privilege(current_user, 'public.outbox', 'SELECT') AS read,
        has_table_privilege(current_user, 'public.outbox', 'UPDATE') AS update,
        has_table_privilege(current_user, 'public.outbox', 'DELETE') AS delete,
        has_table_privilege(current_user, 'public.outbox', 'TRUNCATE') AS truncate`);
      assert.deepEqual(privileges.rows, [{ rls: true, enqueue: true, read: false, update: false, delete: false, truncate: false }]);
    }, { dbRoles: MEDICITAS_APP_ROLE });
  });

  test('registers and patches contact atomically without returning it; omitted fields stay and null clears', async () => {
    const patientId = await create({ ...input, identification: ` ${input.identification} `, fullName: ` ${input.fullName} ` });
    assert.equal((await request('PATCH', `/patients/${patientId}`, { phone: null })).status, 204);
    assert.equal((await request('PATCH', `/patients/${patientId}`, { fullName: 'Ana actualizada' })).status, 204);
    assert.deepEqual((await database.pool.query(`SELECT clinic_id, identification, full_name, birth_date::text, phone, email
      FROM patient WHERE patient_id = $1`, [patientId])).rows, [{ clinic_id: clinic, identification: input.identification,
      full_name: 'Ana actualizada', birth_date: input.birthDate, phone: null, email: input.email }]);
    const audit = await events();
    assert.equal(audit.length, 2); // Demographic-only update neither reads nor writes contact.
    assert.deepEqual(audit.map((row) => row.payload.action).sort(), ['create', 'update']);
    for (const row of audit) {
      assert.equal(row.clinic_id, clinic);
      assert.equal(row.aggregate_id, patientId);
      assert.equal(row.event_type, 'AuditRecorded');
      assert.ok(Number.isFinite(Date.parse(row.payload.occurredAt)));
      assert.deepEqual(row.payload, { appUserId: user, patientId, action: row.payload.action,
        resource: 'patient_contact', resourceId: patientId, occurredAt: row.payload.occurredAt });
    }
    const membership = await request('GET', `/patients/${patientId}`);
    assert.equal(membership.status, 200);
    assert.deepEqual(await membership.json(), { patientId }); // Exact response: no contact or other personal fields.
  });

  test('membership is tenant-scoped with RLS; professional can check it but cannot write and headers do not authorize', async () => {
    await database.pool.query(`INSERT INTO patient (patient_id, clinic_id, identification, full_name, birth_date)
      VALUES ($1, $2, 'foreign', 'Otra clínica', '1980-01-01')`, [foreignPatient, foreignClinic]);
    for (const patientId of [foreignPatient, id(9999), 'invalid']) {
      const response = await request('GET', `/patients/${patientId}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'not_found' });
    }
    const professional = await signed('professional');
    const membership = await request('GET', `/patients/${legacy}`, undefined, professional);
    assert.equal(membership.status, 200);
    assert.deepEqual(await membership.json(), { patientId: legacy });
    assert.equal((await request('POST', undefined, input, professional)).status, 403);
    assert.equal((await request('PATCH', `/patients/${legacy}`, { phone: null }, professional)).status, 403);
    assert.equal((await request('POST', undefined, input, null)).status, 401);
    await withTenantTx(database.db, ctx, async (tx) => {
      assert.deepEqual((await tx.execute(sql`SELECT patient_id FROM patient`)).rows, [{ patient_id: legacy }]);
    }, { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
    await assert.rejects(withTenantTx(database.db, ctx, (tx) => tx.execute(sql`
      INSERT INTO outbox (clinic_id, aggregate_id, event_type, payload)
      VALUES (${foreignClinic}::uuid, ${legacy}::uuid, 'AuditRecorded', '{}'::jsonb)`),
    { dbRoles: MEDICITAS_APP_ROLE }), { status: 403, code: 'forbidden' });
    assert.equal((await events()).length, 0);
  });

  test('duplicate identification and invalid input keep their errors and produce no extra writes/events', async () => {
    const patientId = await create();
    const duplicate = await request('POST', undefined, input);
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'Request rejected.', code: 'duplicate_identification' });
    const duplicatePatch = await request('PATCH', `/patients/${patientId}`, { identification: 'legacy', phone: null });
    assert.equal(duplicatePatch.status, 409);
    assert.deepEqual(await duplicatePatch.json(), { error: 'Request rejected.', code: 'duplicate_identification' });
    for (const body of [{ ...input, clinicId: foreignClinic }, { ...input, birthDate: '2026-02-30' },
      { ...input, birthDate: '2099-01-01' }, { ...input, email: 'invalid' }]) {
      const invalid = await request('POST', undefined, body);
      assert.equal(invalid.status, 422);
      assert.deepEqual(await invalid.json(), { error: 'Request rejected.', code: 'invalid_request' });
    }
    assert.equal((await request('PATCH', `/patients/${patientId}`, {})).status, 422);
    assert.equal((await request('PATCH', `/patients/${id(9999)}`, { phone: null })).status, 404);
    assert.equal((await events()).length, 1);
    assert.equal((await database.pool.query('SELECT phone FROM patient WHERE patient_id=$1', [patientId])).rows[0].phone, input.phone);
    const otherClinic = await request('POST', undefined, input, await signed('receptionist', foreignClinic));
    assert.equal(otherClinic.status, 201); // Uniqueness is per clinic.
  });

  test('queue denial is audit_unavailable with rollback; unrelated database validation is not masked', async () => {
    const patientId = await create();
    await database.pool.query('REVOKE INSERT ON public.outbox FROM medicitas_app');
    try {
      const response = await request('PATCH', `/patients/${patientId}`, { phone: '9999-9999' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Service unavailable.', code: 'audit_unavailable' });
    } finally {
      await database.pool.query('GRANT INSERT ON public.outbox TO medicitas_app');
    }
    assert.equal((await database.pool.query('SELECT phone FROM patient WHERE patient_id=$1', [patientId])).rows[0].phone, input.phone);
    assert.equal((await events()).length, 1);
    // A different error even at the enqueue statement must retain DB translation.
    await database.pool.query('ALTER TABLE outbox ADD CONSTRAINT test_reject_event CHECK (false) NOT VALID');
    try {
      const response = await request('PATCH', `/patients/${patientId}`, { phone: null });
      assert.equal(response.status, 422);
      assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'invalid_value' });
    } finally {
      await database.pool.query('ALTER TABLE outbox DROP CONSTRAINT test_reject_event');
    }
    assert.equal((await database.pool.query('SELECT phone FROM patient WHERE patient_id=$1', [patientId])).rows[0].phone, input.phone);
    assert.equal((await events()).length, 1);
  });
});
