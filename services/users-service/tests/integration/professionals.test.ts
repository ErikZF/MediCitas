import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type TenantContext } from '@medicitas/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const clinic = '00000000-0000-4000-8000-000000000101';
const otherClinic = '00000000-0000-4000-8000-000000000102';
const caller = '00000000-0000-4000-8000-000000000201';
const targetUser = '00000000-0000-4000-8000-000000000202';
const targetSubject = '00000000-0000-4000-8000-000000000302';
const foreignUser = '00000000-0000-4000-8000-000000000203';
const inactiveUser = '00000000-0000-4000-8000-000000000204';
const wrongRoleUser = '00000000-0000-4000-8000-000000000205';
const specialty = '00000000-0000-4000-8000-000000000a01';
const otherSpecialty = '00000000-0000-4000-8000-000000000a02';
const ctx: TenantContext = { clinicId: clinic, userId: caller, role: 'clinic_admin' };
const input = { appUserId: targetUser, fullName: 'Dra. Ana', specialtyIds: [specialty, otherSpecialty] };

// Both normal service entry points, real Bearer/JWKS and isolated PostgreSQL DBs.
// The HTTP proxy can fail the catalog; successful calls reach the real owner.
describe.skipIf(!url)('RF4 professional registration through users and clinics', () => {
  let users: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let clinics: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let appointments: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let appointmentsBase: string;
  let claim: string | undefined;
  let identityFails = false;
  const children: Array<{ child: ChildProcess; closed: Promise<unknown> }> = [];
  const servers: Server[] = [];
  let base: string;
  let adminToken: string;
  let receptionToken: string;
  let professionalToken: string;
  let catalogFails = false;
  let catalogCalls = 0;
  let forwardedAuthorization: string | undefined;
  let jwksCalls = 0;

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }

  async function startService(file: URL, env: NodeJS.ProcessEnv): Promise<string> {
    const reservation = reserveServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, API_INTERNAL_PORT: String(address.port) };
    delete childEnv.NODE_OPTIONS;
    delete childEnv.TEST_DATABASE_URL;
    const child = spawn(process.execPath, [fileURLToPath(file)], {
      env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = new Promise((resolve) => child.once('close', resolve));
    children.push({ child, closed });
    let output = '';
    let launchError: Error | undefined;
    child.on('error', (error) => { launchError = error; });
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr!.resume(); // Consume without publishing credentials, tokens or DB details.
    const deadline = Date.now() + 10_000;
    while (!output.includes('Server running on port ')) {
      assert.ifError(launchError);
      assert.equal(child.exitCode, null, 'Service exited before listening.');
      assert.equal(child.signalCode, null, 'Service stopped before listening.');
      assert.ok(Date.now() < deadline, 'Service startup timed out.');
      await delay(25);
    }
    return `http://127.0.0.1:${address.port}`;
  }

  function databaseEnv(databaseUrl: string, prefix: 'DB_USERS' | 'DB_CLINICS' | 'DB_APPOINTMENTS'): NodeJS.ProcessEnv {
    const parsed = new URL(databaseUrl);
    return {
      [`${prefix}_HOST`]: parsed.hostname,
      DB_CONNECT_PORT: parsed.port || '5432',
      [`${prefix}_NAME`]: decodeURIComponent(parsed.pathname.slice(1)),
      [`${prefix}_USER`]: decodeURIComponent(parsed.username),
      [`${prefix}_PASSWORD`]: decodeURIComponent(parsed.password),
    };
  }

  beforeAll(async () => {
    users = await createTestDatabase(url!, 'users');
    clinics = await createTestDatabase(url!, 'clinics');
    appointments = await createTestDatabase(url!, 'appointments');
    await users.pool.query(`INSERT INTO app_user (app_user_id, keycloak_sub, clinic_id, role_code, is_active)
      VALUES ($1, 'rf4-admin', $6, 'clinic_admin', true),
             ($2, $8, $6, 'professional', true),
             ($3, 'rf4-foreign', $7, 'professional', true),
             ($4, 'rf4-inactive', $6, 'professional', false),
             ($5, 'rf4-reception', $6, 'receptionist', true)`,
    [caller, targetUser, foreignUser, inactiveUser, wrongRoleUser, clinic, otherClinic, targetSubject]);
    await clinics.pool.query('INSERT INTO specialty (specialty_id, name) VALUES ($1, $2), ($3, $4)',
      [specialty, 'General', otherSpecialty, 'Cardiology']);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'rf4-runtime', alg: 'RS256', use: 'sig' };
    const identityUrl = await listen(createServer(async (req, res) => {
      if (req.url === '/realms/RF4/protocol/openid-connect/token') {
        res.writeHead(200).end(JSON.stringify({ access_token: 'test-admin-token' }));
        return;
      }
      if (req.url === '/admin/realms/RF4/users/' + targetSubject && req.headers.authorization === 'Bearer test-admin-token') {
        if (identityFails) { res.writeHead(503).end(); return; }
        if (req.method === 'GET') {
          res.writeHead(200).end(JSON.stringify({ attributes: {
            clinic_id: [clinic], app_user_id: [targetUser], role: ['professional'], extra: ['keep'],
            ...(claim ? { professional_id: [claim] } : {}),
          } }));
        } else if (req.method === 'PUT') {
          const chunks = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          const { attributes } = JSON.parse(Buffer.concat(chunks).toString());
          if (attributes.extra?.[0] !== 'keep') { res.writeHead(400).end(); return; }
          claim = attributes.professional_id[0];
          res.writeHead(204).end();
        } else res.writeHead(405).end();
        return;
      }
      if (req.url !== '/realms/RF4/protocol/openid-connect/certs') {
        res.writeHead(404).end();
        return;
      }
      jwksCalls++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    }));
    const authEnv = {
      KEYCLOAK_INTERNAL_URL: identityUrl,
      KEYCLOAK_ISSUER: `${identityUrl}/realms/RF4`,
      KEYCLOAK_AUDIENCE: 'rf4-runtime', REALM_NAME: 'RF4',
    };
    async function token(role: string) {
      return new SignJWT({ sub: 'rf4-admin', app_user_id: caller, clinic_id: clinic,
        ...(role === 'professional' ? { professional_id: targetUser } : {}),
        role, realm_access: { roles: [role] } })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(authEnv.KEYCLOAK_ISSUER).setAudience(authEnv.KEYCLOAK_AUDIENCE)
        .setExpirationTime('5m').sign(privateKey);
    }
    adminToken = await token('clinic_admin');
    receptionToken = await token('receptionist');
    professionalToken = await token('professional');
    const clinicsBase = await startService(new URL('../../../clinics-service/server.ts', import.meta.url), {
      ...authEnv, ...databaseEnv(clinics.url, 'DB_CLINICS'),
    });
    const catalogUrl = await listen(createServer(async (req, res) => {
      catalogCalls++;
      forwardedAuthorization = req.headers.authorization;
      if (catalogFails) {
        res.writeHead(503).end();
        return;
      }
      try {
        assert.equal(req.url, '/specialties');
        const response = await fetch(`${clinicsBase}/specialties`, {
          headers: { authorization: req.headers.authorization ?? '' }, signal: AbortSignal.timeout(5000),
        });
        res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text());
      } catch {
        res.writeHead(503).end();
      }
    }));
    base = await startService(new URL('../../server.ts', import.meta.url), {
      ...authEnv, ...databaseEnv(users.url, 'DB_USERS'), CLINICS_SERVICE_URL: catalogUrl, KEYCLOAK_USER_ADMIN_SECRET: 'test-only',
    });
    appointmentsBase = await startService(new URL('../../../appointments-service/server.ts', import.meta.url), {
      ...authEnv, ...databaseEnv(appointments.url, 'DB_APPOINTMENTS'), CLINICS_SERVICE_URL: clinicsBase,
      USERS_SERVICE_URL: base, CACHE_ENABLED: 'false',
    });
  }, 25_000);

  afterAll(async () => {
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(children.map(({ closed }) => closed));
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await users?.drop();
    await clinics?.drop();
    await appointments?.drop();
  });

  beforeEach(async () => {
    catalogFails = false;
    identityFails = false;
    claim = undefined;
    catalogCalls = 0;
    forwardedAuthorization = undefined;
    // Only fixture owners clear these disposable DBs; the HTTP login has no bypass.
    await users!.pool.query('DELETE FROM professional_specialty; DELETE FROM professional');
  });

  async function request(body: unknown = input, token: string | null = adminToken) {
    return fetch(`${base}/professionals`, {
      method: 'POST', headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'x-clinic-id': otherClinic, 'x-role': 'clinic_admin',
      },
      body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
  }

  async function assertNoProfiles() {
    assert.equal((await users!.pool.query('SELECT 1 FROM professional')).rowCount, 0);
    assert.equal((await users!.pool.query('SELECT 1 FROM professional_specialty')).rowCount, 0);
  }

  async function call(method: string, path: string, bearer = adminToken, body?: unknown) {
    return fetch(appointmentsBase + path, { method, headers: {
      authorization: 'Bearer ' + bearer, 'content-type': 'application/json',
      'x-clinic-id': otherClinic, 'x-role': 'clinic_admin',
    }, body: JSON.stringify(body) });
  }

  async function serviceFor(clinicId: string, specialtyId: string) {
    await clinics!.pool.query(`insert into clinic(clinic_id, identifier, name, time_zone)
      values ($1, $2, 'Clinic', 'UTC') on conflict do nothing`, [clinicId, clinicId.slice(-8)]);
    const id = randomUUID();
    await clinics!.pool.query(`insert into service(service_id, clinic_id, specialty_id, name, duration_minutes)
      values ($1, $2, $3, $4, 30)`, [id, clinicId, specialtyId, id]);
    return id;
  }

  test('an assigned service supplies a real slot and booking until its required specialty changes', async () => {
    const registration = await request({ ...input, specialtyIds: [specialty] });
    assert.equal(registration.status, 201);
    const { professionalId } = await registration.json();
    const id = await serviceFor(clinic, specialty);
    const association = `/professionals/${professionalId}/services/${id}`;
    assert.equal((await call('PUT', association)).status, 204);
    assert.equal((await call('PUT', association)).status, 204);
    assert.deepEqual((await appointments!.pool.query('select * from professional_service where service_id=$1', [id])).rows,
      [{ professional_id: professionalId, service_id: id, clinic_id: clinic, specialty_id: specialty }]);
    const date = '2099-01-05';
    const hours = { workingHours: [{ weekday: new Date(date).getUTCDay(), startTime: '09:00', endTime: '11:00' }] };
    assert.equal((await call('PUT', `/professionals/${professionalId}/working-hours`, adminToken, hours)).status, 200);
    const availability = `/availability/professionals/${professionalId}?serviceId=${id}&date=${date}`;
    const response = await call('GET', availability, receptionToken);
    assert.equal(response.status, 200);
    const { slots } = await response.json();
    assert.ok(slots.length >= 2);
    assert.equal((await call('GET', availability, professionalToken)).status, 200);
    const patientId = randomUUID();
    await users!.pool.query(`insert into patient(patient_id,clinic_id,identification,full_name,birth_date)
      values ($1,$2,'RF4','Test Patient','1990-01-01')`, [patientId,clinic]);
    const booking = { patientId, professionalId, serviceId: id, startsAt: slots[0].startsAt };
    assert.equal((await call('POST', '/appointments', receptionToken, booking)).status, 201);
    await clinics!.pool.query('update service set specialty_id=$1 where service_id=$2', [otherSpecialty,id]);
    assert.equal((await call('PUT', association)).status, 422);
    assert.equal((await call('GET', availability, receptionToken)).status, 422);
    const stale = await call('POST', '/appointments', receptionToken, { ...booking, startsAt: slots[1].startsAt });
    assert.equal((await stale.json()).code, 'service_not_offered');
  });

  test('association rejects incompatible specialties, foreign IDs and unauthorized roles', async () => {
    const registration = await request({ ...input, specialtyIds: [specialty] });
    assert.equal(registration.status, 201);
    const { professionalId } = await registration.json();
    const local = await serviceFor(clinic, otherSpecialty);
    const foreign = await serviceFor(otherClinic, specialty);
    const foreignProfessional = randomUUID();
    await users!.pool.query(`insert into professional(professional_id, app_user_id, clinic_id, full_name)
      values ($1,$2,$3,'Foreign')`, [foreignProfessional, foreignUser, otherClinic]);
    for (const [prof, svc, token, status, code] of [
      [professionalId, local, receptionToken, 403, 'forbidden'],
      [professionalId, local, professionalToken, 403, 'forbidden'],
      [professionalId, local, adminToken, 422, 'specialty_mismatch'],
      [professionalId, foreign, adminToken, 404, 'not_found'],
      [professionalId, randomUUID(), adminToken, 404, 'not_found'],
      [foreignProfessional, local, adminToken, 404, 'not_found'],
      [randomUUID(), local, adminToken, 404, 'not_found'],
    ] as const) {
      const res = await call('PUT', `/professionals/${prof}/services/${svc}`, token);
      assert.equal(res.status, status);
      assert.deepEqual(await res.json(), { error: 'Request rejected.', code });
    }
    const spoof = await call('PUT', `/professionals/${professionalId}/services/${local}`, adminToken, { clinicId: otherClinic });
    assert.equal(spoof.status, 422);
    assert.equal((await appointments!.pool.query('select 1 from professional_service where professional_id=$1', [professionalId])).rowCount, 0);
  });

  test('normal startup registers atomically through the real catalog without changing app_user', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const before = (await users!.pool.query('SELECT * FROM app_user ORDER BY app_user_id')).rows;
    const response = await request({ ...input, fullName: `  ${input.fullName}  `,
      specialtyIds: [otherSpecialty.toUpperCase(), specialty.toUpperCase()] });
    assert.equal(response.status, 201);
    const dto = await response.json() as { professionalId: string };
    assert.match(dto.professionalId, /^[0-9a-f-]{36}$/);
    assert.equal(claim, dto.professionalId);
    assert.deepEqual(dto, { ...input, professionalId: dto.professionalId, isActive: true });
    assert.deepEqual((await users!.pool.query(`SELECT clinic_id, app_user_id, full_name, is_active
      FROM professional WHERE professional_id = $1`, [dto.professionalId])).rows,
    [{ clinic_id: clinic, app_user_id: targetUser, full_name: input.fullName, is_active: true }]);
    assert.deepEqual((await users!.pool.query(`SELECT professional_id, specialty_id, clinic_id
      FROM professional_specialty ORDER BY specialty_id`)).rows,
    input.specialtyIds.map((id) => ({ professional_id: dto.professionalId, specialty_id: id, clinic_id: clinic })));
    assert.deepEqual((await users!.pool.query('SELECT * FROM app_user ORDER BY app_user_id')).rows, before);
    assert.equal(forwardedAuthorization, `Bearer ${adminToken}`);
    assert.ok(jwksCalls >= 2, 'Users and clinics must independently fetch keys to verify Bearer.');
    const duplicate = await request();
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: 'Request rejected.', code: 'duplicate' });
    assert.equal((await users!.pool.query('SELECT 1 FROM professional')).rowCount, 1);
    assert.equal((await users!.pool.query('SELECT 1 FROM professional_specialty')).rowCount, 2);
  });

  test('authorization, tenant separation and invalid references reject without partial writes', async () => {
    assert.equal((await request(input, null)).status, 401);
    assert.equal((await request(input, 'invalid')).status, 401);
    assert.equal((await request(input, receptionToken)).status, 403);
    assert.equal(catalogCalls, 0, 'Denied requests must not call the owner.');
    for (const [body, status, code] of [
      [{ ...input, appUserId: foreignUser }, 404, 'not_found'],
      [{ ...input, appUserId: inactiveUser }, 422, 'invalid_professional_user'],
      [{ ...input, appUserId: wrongRoleUser }, 422, 'invalid_professional_user'],
      [{ ...input, specialtyIds: [specialty, targetUser] }, 422, 'invalid_reference'],
      [{ ...input, specialtyIds: [specialty, specialty.toUpperCase()] }, 422, 'invalid_request'],
      [{ ...input, clinicId: otherClinic, role: 'professional', isActive: true }, 422, 'invalid_request'],
    ] as const) {
      const rejected = await request(body);
      assert.equal(rejected.status, status);
      assert.deepEqual(await rejected.json(), { error: 'Request rejected.', code });
      await assertNoProfiles();
    }
    await users!.pool.query(`INSERT INTO professional (clinic_id, app_user_id, full_name)
      VALUES ($1, $2, 'Otro profesional')`, [otherClinic, foreignUser]);
    await withTenantTx(users!.db, ctx, async (tx) => {
      assert.deepEqual((await tx.execute(sql`select current_user as role`)).rows, [{ role: 'medicitas_app' }]);
      assert.equal((await tx.execute(sql`select * from professional`)).rowCount, 0);
    }, { dbRoles: MEDICITAS_APP_ROLE });
    await assert.rejects(withTenantTx(users!.db, ctx, (tx) => tx.execute(sql`
      insert into professional (clinic_id, app_user_id, full_name)
      values (${otherClinic}::uuid, ${targetUser}::uuid, 'Cross-tenant')
    `), { dbRoles: MEDICITAS_APP_ROLE }), { status: 403, code: 'forbidden' });
  });

  test('owner failures leave either no profile or one committed profile whose claim can be retried', async () => {
    catalogFails = true;
    const response = await request();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Service unavailable.', code: 'catalog_unavailable' });
    assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(catalogCalls, 1);
    await assertNoProfiles();
    catalogFails = false;
    identityFails = true;
    assert.equal((await request()).status, 503);
    const [{ professional_id: id }] = (await users!.pool.query('SELECT professional_id FROM professional')).rows;
    identityFails = false;
    assert.equal((await request()).status, 200);
    assert.equal(claim, id);
  });
});
