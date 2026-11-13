import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, test, vi } from 'vitest';
import { createHttpClinicCalendar } from '../../adapters/clinic-calendar.http.ts';
import { createApp } from '../../app.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
// Load the other service's source at runtime, keeping both TypeScript workspace
// rootDirs unchanged. The test exercises the normal clinics application/helper.
const { createApp: createClinicsApp } = await import(new URL(
  '../../../clinics-service/app.ts', import.meta.url).href);
const { createTestDatabase: createClinicsDatabase } = await import(new URL(
  '../../../clinics-service/tests/helpers/test-database.ts', import.meta.url).href);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const clinicA = id(1), clinicB = id(2), clinicDst = id(3), user = id(10), p1 = id(11), p2 = id(12), foreignProfessional = id(13);
const ctx: TenantContext = { clinicId: clinicA, userId: user, role: 'receptionist' };

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

// Real application compositions, Bearer/JWKS, adapter and two PostgreSQL databases.
// One focused case also starts the normal appointments server.ts in a child process.
describe.skipIf(!url)('RF20 daily agenda with real PostgreSQL and HTTP identity', () => {
  let appointments: Awaited<ReturnType<typeof createTestDatabase>>;
  let clinics: { pool: Pool; db: Database; drop(): Promise<void> };
  const servers: Server[] = [];
  let base: string, clinicsBase: string;
  let token: (role: string, clinic?: string) => Promise<string>;
  let reception: string;

  beforeAll(async () => {
    appointments = await createTestDatabase(url!, `rf20_${randomUUID().slice(0, 8)}`, 1);
    clinics = await createClinicsDatabase(url!);
    await clinics.pool.query(`INSERT INTO clinic (clinic_id, identifier, name, time_zone) VALUES
      ($1, 'rf20-a', 'A', 'America/Costa_Rica'), ($2, 'rf20-b', 'B', 'America/Panama'),
      ($3, 'rf20-dst', 'DST', 'America/New_York')`, [clinicA, clinicB, clinicDst]);
    const rows: Array<[number, string, string, string, string, string]> = [
      [101, clinicA, p1, '2027-01-04T05:45Z', '2027-01-04T06:15Z', 'booked'], // carry-in
      [102, clinicA, p2, '2027-01-04T06:00Z', '2027-01-04T06:30Z', 'attended'],
      [103, clinicA, p1, '2027-01-04T08:00Z', '2027-01-04T08:30Z', 'no_show'],
      [104, clinicA, p2, '2027-01-04T08:00Z', '2027-01-04T08:30Z', 'cancelled'],
      [105, clinicA, p1, '2027-01-05T05:45Z', '2027-01-05T06:15Z', 'rescheduled'], // carry-out
      [106, clinicA, p2, '2027-01-04T05:30Z', '2027-01-04T06:00Z', 'booked'], // excluded
      [107, clinicA, p2, '2027-01-05T06:00Z', '2027-01-05T06:30Z', 'booked'], // excluded
      [108, clinicB, foreignProfessional, '2027-01-04T08:00Z', '2027-01-04T08:30Z', 'booked'],
      [201, clinicDst, p1, '2027-03-14T05:00Z', '2027-03-14T05:30Z', 'booked'],
      [202, clinicDst, p1, '2027-03-15T03:30Z', '2027-03-15T04:00Z', 'booked'],
      [203, clinicDst, p1, '2027-03-15T04:00Z', '2027-03-15T04:30Z', 'booked'],
      [204, clinicDst, p1, '2027-11-07T04:00Z', '2027-11-07T04:30Z', 'booked'],
      [205, clinicDst, p1, '2027-11-08T04:30Z', '2027-11-08T05:00Z', 'booked'],
      [206, clinicDst, p1, '2027-11-08T05:00Z', '2027-11-08T05:30Z', 'booked'],
    ];
    for (const [n, clinic, professional, start, end, status] of rows) {
      await appointments.pool.query(`INSERT INTO appointment
        (appointment_id, clinic_id, professional_id, patient_id, service_id,
         starts_at, ends_at, duration_minutes, status, created_by, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,30,$8,$9,'2026-01-01T00:00Z')`,
      [id(n), clinic, professional, id(n + 1000), id(20), start, end, status, user]);
    }
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'rf20', alg: 'RS256', use: 'sig' };
    const keys = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ keys: [jwk] })));
    servers.push(keys);
    const identity = await listen(keys);
    const issuer = `${identity}/realms/RF20`;
    vi.stubEnv('KEYCLOAK_INTERNAL_URL', identity);
    vi.stubEnv('KEYCLOAK_ISSUER', issuer);
    vi.stubEnv('KEYCLOAK_AUDIENCE', 'rf20');
    vi.stubEnv('REALM_NAME', 'RF20');
    token = (role, clinic = clinicA) => new SignJWT({ sub: 'rf20-subject', app_user_id: user,
      clinic_id: role === 'platform_admin' ? undefined : clinic, role,
      professional_id: role === 'professional' ? p1 : undefined,
    }).setProtectedHeader({ alg: 'RS256', kid: 'rf20' }).setIssuer(issuer).setAudience('rf20')
      .setExpirationTime('5m').sign(privateKey);
    reception = await token('receptionist');

    const clinicServer = createServer(createClinicsApp({ serviceCatalog: { db: clinics.db } }));
    servers.push(clinicServer);
    clinicsBase = await listen(clinicServer);
    const app = createApp({ dailyAgenda: {
      db: appointments.db, clinics: createHttpClinicCalendar(clinicsBase),
    } });
    const server = createServer(app);
    servers.push(server);
    base = await listen(server);
  });

  afterAll(async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.unstubAllEnvs();
    await clinics?.drop();
    await appointments?.drop();
  });

  async function request(path = '/agenda?date=2027-01-04', bearer = reception) {
    return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${bearer}`, 'x-clinic-id': clinicB } });
  }

  test('clinic day includes overlaps and all states, ordered, without exposing clinical/contact data', async () => {
    for (const role of ['receptionist', 'clinic_admin']) {
      const response = await request(undefined, await token(role));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.date, '2027-01-04');
      assert.equal(body.timeZone, 'America/Costa_Rica');
      assert.equal(body.professionalId, null);
      assert.deepEqual(body.appointments.map((a: { appointmentId: string }) => a.appointmentId),
        [101, 102, 103, 104, 105].map(id));
      assert.deepEqual(body.appointments.map((a: { status: string }) => a.status),
        ['booked', 'attended', 'no_show', 'cancelled', 'rescheduled']);
      assert.deepEqual(Object.keys(body.appointments[0]).sort(),
        ['appointmentId', 'professionalId', 'patientId', 'serviceId', 'startsAt', 'endsAt', 'status'].sort());
    }
  });

  test('professional can see only own agenda; reception can filter any visible professional', async () => {
    const professional = await token('professional');
    for (const bearer of [professional, reception]) {
      const response = await request(`/agenda/professionals/${p1.toUpperCase()}?date=2027-01-04`, bearer);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).appointments.map((a: { appointmentId: string }) => a.appointmentId),
        [101, 103, 105].map(id));
    }
    for (const path of ['/agenda?date=2027-01-04', `/agenda/professionals/${p2}?date=2027-01-04`]) {
      assert.equal((await request(path, professional)).status, 403);
    }
  });

  test('platform admin cannot read the agenda or clinic calendar settings', async () => {
    assert.equal((await request(undefined, await token('platform_admin'))).status, 403);
    assert.equal((await fetch(`${clinicsBase}/clinic/time-zone`, {
      headers: { authorization: `Bearer ${await token('platform_admin')}` },
    })).status, 403);
  });

  test('strict query rejects invalid/duplicate dates and tenant/zone overrides; malformed route id is 404', async () => {
    for (const query of ['', 'date=2027-02-29', 'date=2027-01-04&date=2027-01-05',
      `date=2027-01-04&clinicId=${clinicB}`, 'date=2027-01-04&timeZone=UTC']) {
      assert.equal((await request(`/agenda?${query}`)).status, 422, query);
    }
    assert.equal((await request('/agenda/professionals/invalid?date=2027-01-04')).status, 404);
    assert.equal((await fetch(`${clinicsBase}/clinic/time-zone?clinicId=${clinicB}`, {
      headers: { authorization: `Bearer ${reception}` },
    })).status, 422);
  });

  test('another clinic gets its own zone/data; foreign professional returns an empty agenda', async () => {
    const response = await request(undefined, await token('receptionist', clinicB));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.timeZone, 'America/Panama');
    assert.deepEqual(body.appointments.map((a: { appointmentId: string }) => a.appointmentId), [id(108)]);
    const empty = await request(`/agenda/professionals/${foreignProfessional}?date=2027-01-04`);
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).appointments, []);
  });

  test('local midnight boundaries cover both 23-hour and 25-hour DST days', async () => {
    for (const [date, expected] of [['2027-03-14', [201, 202]], ['2027-11-07', [204, 205]]] as const) {
      const response = await request(`/agenda?date=${date}`, await token('receptionist', clinicDst));
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).appointments.map((a: { appointmentId: string }) => a.appointmentId),
        expected.map(id));
    }
  });

  test('RLS hides the other clinic without a tenant WHERE and pooled context does not leak', async () => {
    for (const [context, expected] of [[ctx, clinicA], [{ ...ctx, clinicId: clinicB }, clinicB], [ctx, clinicA]] as const) {
      const rows = await withTenantTx(appointments.db, context,
        (tx) => tx.execute(sql`SELECT DISTINCT clinic_id FROM appointment`),
        { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
      assert.deepEqual(rows.rows, [{ clinic_id: expected }]);
      const settings = await withTenantTx(clinics.db, context,
        (tx) => tx.execute(sql`SELECT clinic_id FROM clinic`),
        { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
      assert.deepEqual(settings.rows, [{ clinic_id: expected }]);
    }
  });

  test('normal server.ts exposes RF20 and RF21 with verified Bearer', { timeout: 15000 }, async (t) => {
    const reservation = reserveServer();
    let child: ChildProcess | undefined;
    let closed: Promise<unknown> | undefined;
    try {
      reservation.listen(0, '127.0.0.1');
      await once(reservation, 'listening');
      const address = reservation.address();
      assert.ok(address && typeof address !== 'string');
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const target = new URL(url!);
      target.pathname = `/${(await appointments.pool.query('SELECT current_database() AS name')).rows[0].name}`;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        API_INTERNAL_PORT: String(address.port),
        DB_APPOINTMENTS_HOST: target.hostname,
        DB_CONNECT_PORT: target.port || '5432',
        DB_APPOINTMENTS_NAME: decodeURIComponent(target.pathname.slice(1)),
        DB_APPOINTMENTS_USER: decodeURIComponent(target.username),
        DB_APPOINTMENTS_PASSWORD: decodeURIComponent(target.password),
        CLINICS_SERVICE_URL: clinicsBase,
        // server.ts now wires every module; RF20/RF21 never call users-service.
        USERS_SERVICE_URL: clinicsBase,
      };
      delete env.NODE_OPTIONS;
      delete env.TEST_DATABASE_URL;
      // Same source entry point as npm run dev, without watch or personal .env.
      child = spawn(process.execPath, [fileURLToPath(new URL('../../server.ts', import.meta.url))], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      closed = new Promise((resolve) => child!.once('close', resolve));
      let output = '';
      let launchError: Error | undefined;
      child.on('error', (error) => { launchError = error; });
      child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr!.resume(); // Do not expose database configuration on failure.
      while (!output.includes('Server running on port ')) {
        assert.ifError(launchError);
        assert.equal(child.exitCode, null, 'Appointments exited before listening.');
        assert.equal(child.signalCode, null, 'Appointments stopped before listening.');
        await delay(25, undefined, { signal: t.signal });
      }

      const runtime = `http://127.0.0.1:${address.port}`;
      const paths = ['/agenda?date=2027-01-04',
        '/appointments/counts?from=2027-01-04T06:00:00Z&to=2027-01-05T06:00:00Z'];
      const parts = reception.split('.');
      parts[2] = (parts[2].startsWith('A') ? 'B' : 'A') + parts[2].slice(1);
      const unauthenticated: Record<string, string>[] = [
        { 'x-clinic-id': clinicA, 'x-role': 'receptionist' },
        { authorization: `Bearer ${parts.join('.')}` },
      ];
      // Headers cannot create identity; unchanged claims with a forged signature fail.
      for (const path of paths) {
        for (const headers of unauthenticated) {
          assert.equal((await fetch(`${runtime}${path}`, { headers, signal: t.signal })).status, 401);
        }
      }
      const headers = { authorization: `Bearer ${reception}`, 'x-clinic-id': clinicB };
      const agenda = await fetch(`${runtime}${paths[0]}`, { headers, signal: t.signal });
      assert.equal(agenda.status, 200);
      assert.deepEqual((await agenda.json()).appointments.map((a: { appointmentId: string }) => a.appointmentId),
        [101, 102, 103, 104, 105].map(id));
      const counts = await fetch(`${runtime}${paths[1]}`, { headers, signal: t.signal });
      assert.equal(counts.status, 200);
      // RF21 counts starts in the range; RF20 also includes a carry-in appointment.
      assert.deepEqual(await counts.json(), {
        counts: { booked: 0, attended: 1, no_show: 1, cancelled: 1, rescheduled: 1 }, total: 4,
      });
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
      if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()));
    }
  });
});
