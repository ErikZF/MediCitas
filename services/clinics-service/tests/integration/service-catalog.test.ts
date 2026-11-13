import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type TenantContext } from '@medicitas/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, test } from 'vitest';
import type { ServiceDto } from '../../modules/service-catalog/service-catalog.service.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;
const clinic = '00000000-0000-4000-8000-000000000101';
const otherClinic = '00000000-0000-4000-8000-000000000102';
const specialty = '00000000-0000-4000-8000-000000000201';
const otherSpecialty = '00000000-0000-4000-8000-000000000202';
const foreignService = '00000000-0000-4000-8000-000000000301';
const user = '00000000-0000-4000-8000-000000000401';
const ctx: TenantContext = { clinicId: clinic, userId: user, role: 'clinic_admin' };
const input = { name: 'Consulta RF3', durationMinutes: 30, specialtyId: specialty };

// Real server.ts, Bearer verification and PostgreSQL/RLS. Only the OIDC JWKS
// provider is a local fixture: this does not assert Keycloak/Compose/gateway work.
describe.skipIf(!url)('RF3 through normal clinics-service startup', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;
  let jwks: ReturnType<typeof createServer> | undefined;
  let base: string;
  let adminToken: string;
  let receptionToken: string;
  let incompleteToken: string;
  let keyRequests = 0;

  beforeAll(async () => {
    database = await createTestDatabase(url!);
    await database.pool.query(`INSERT INTO clinic (clinic_id, identifier, name, time_zone)
      VALUES ($1, 'rf3-a', 'Clínica A', 'America/Costa_Rica'),
             ($2, 'rf3-b', 'Clínica B', 'America/Panama');
    `, [clinic, otherClinic]);
    await database.pool.query('INSERT INTO specialty (specialty_id, name) VALUES ($1, $2), ($3, $4)',
      [specialty, 'Medicina general', otherSpecialty, 'Cardiología']);
    await database.pool.query(`INSERT INTO service (service_id, clinic_id, specialty_id, name, duration_minutes)
      VALUES ($1, $2, $3, $4, 45)`, [foreignService, otherClinic, specialty, input.name]);

    // Check fresh initialization, then simulate the previous schema only inside
    // this disposable fixture to exercise the manual, non-destructive upgrade.
    assert.deepEqual((await database.pool.query('SELECT is_active FROM service')).rows, [{ is_active: true }]);
    assert.deepEqual((await database.pool.query(`SELECT
      has_table_privilege('medicitas_app', 'public.service', 'DELETE') AS app_delete,
      has_table_privilege('medicitas_app', 'public.service', 'UPDATE') AS app_update,
      has_table_privilege('db_admin', 'public.service', 'DELETE') AS admin_delete`)).rows,
    [{ app_delete: false, app_update: true, admin_delete: true }]);
    await database.pool.query('ALTER TABLE service DROP COLUMN is_active');
    await database.pool.query('GRANT DELETE ON TABLE public.service TO medicitas_app');
    assert.deepEqual((await database.pool.query("SELECT has_table_privilege('medicitas_app', 'public.service', 'DELETE') AS allowed")).rows,
      [{ allowed: true }]);
    const upgrade = readFileSync(new URL('../../../../database/updates/clinics/upgrade-service-soft-delete.sql', import.meta.url), 'utf8');
    await database.pool.query(upgrade);
    assert.deepEqual((await database.pool.query("SELECT has_table_privilege('medicitas_app', 'public.service', 'DELETE') AS allowed")).rows,
      [{ allowed: false }]);
    assert.deepEqual((await database.pool.query('SELECT service_id, name, is_active FROM service')).rows,
      [{ service_id: foreignService, name: input.name, is_active: true }]);
    await database.pool.query('UPDATE service SET is_active = false WHERE service_id = $1', [foreignService]);
    await database.pool.query(upgrade);
    assert.deepEqual((await database.pool.query('SELECT is_active FROM service')).rows, [{ is_active: false }]);
    assert.deepEqual((await database.pool.query("SELECT has_table_privilege('medicitas_app', 'public.service', 'DELETE') AS allowed")).rows,
      [{ allowed: false }]);

    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...await exportJWK(publicKey), kid: 'rf3-runtime', alg: 'RS256', use: 'sig' };
    jwks = createServer((req, res) => {
      if (req.url !== '/realms/RF3/protocol/openid-connect/certs') {
        res.writeHead(404).end();
        return;
      }
      keyRequests++;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
    });
    jwks.listen(0, '127.0.0.1');
    await once(jwks, 'listening');
    const keysAddress = jwks.address();
    assert.ok(keysAddress && typeof keysAddress !== 'string');
    const identityUrl = `http://127.0.0.1:${keysAddress.port}`;
    const issuer = `${identityUrl}/realms/RF3`;
    async function token(role: string, clinicId?: string) {
      return new SignJWT({ sub: 'rf3-test-subject', app_user_id: user, clinic_id: clinicId,
        role, realm_access: { roles: [role] } })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer)
        .setAudience('rf3-runtime').setExpirationTime('5m').sign(privateKey);
    }
    adminToken = await token('clinic_admin', clinic);
    receptionToken = await token('receptionist', clinic);
    incompleteToken = await token('clinic_admin');

    const reservation = reserveServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${address.port}`;
    const dbUrl = new URL(database.url);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      API_INTERNAL_PORT: String(address.port),
      DB_CLINICS_HOST: dbUrl.hostname,
      DB_CONNECT_PORT: dbUrl.port || '5432',
      DB_CLINICS_NAME: decodeURIComponent(dbUrl.pathname.slice(1)),
      DB_CLINICS_USER: decodeURIComponent(dbUrl.username),
      DB_CLINICS_PASSWORD: decodeURIComponent(dbUrl.password),
      KEYCLOAK_INTERNAL_URL: identityUrl,
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_AUDIENCE: 'rf3-runtime',
      REALM_NAME: 'RF3',
    };
    delete env.NODE_OPTIONS;
    delete env.TEST_DATABASE_URL;
    // The normal source entry point used by npm run dev, without .env/watch.
    child = spawn(process.execPath, [fileURLToPath(new URL('../../server.ts', import.meta.url))], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve) => child!.once('close', resolve));
    let ready = false;
    let launchError: Error | undefined;
    child.on('error', (error) => { launchError = error; });
    child.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Server running on port ')) ready = true;
    });
    child.stderr!.resume();
    const deadline = Date.now() + 10_000;
    while (!ready) {
      assert.ifError(launchError);
      assert.equal(child.exitCode, null, 'Clinics process exited before listening.');
      assert.equal(child.signalCode, null, 'Clinics process stopped before listening.');
      assert.ok(Date.now() < deadline, 'Clinics startup timed out.');
      await delay(25);
    }
  }, 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    jwks?.closeAllConnections();
    if (jwks?.listening) await new Promise<void>((resolve) => jwks!.close(() => resolve()));
    await database?.drop();
  });

  beforeEach(async () => {
    // Fixture cleanup uses the owner of the throwaway DB, never the HTTP login.
    await database!.pool.query('DELETE FROM service WHERE clinic_id = $1', [clinic]);
  });

  async function request(path = '', method = 'GET', body?: unknown, token: string | null = adminToken) {
    return fetch(`${base}/services${path}`, {
      method,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        'content-type': 'application/json',
        // Spoofed selectors must never replace verified identity.
        'x-clinic-id': otherClinic, 'x-role': 'clinic_admin', 'x-user-id': foreignService,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }

  test('global specialties use the real catalog and require professional:create', async () => {
    const response = await fetch(`${base}/specialties`, { headers: { authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      { specialtyId: otherSpecialty, name: 'Cardiología' },
      { specialtyId: specialty, name: 'Medicina general' },
    ]);
    const denied = await fetch(`${base}/specialties`, { headers: { authorization: `Bearer ${receptionToken}` } });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Request rejected.', code: 'forbidden' });
    assert.equal((await fetch(`${base}/specialties`)).status, 401);
  });

  test('CRUD persists editable attributes and exposes specialty/time zone', async () => {
    const created = await request('', 'POST', { ...input, name: `  ${input.name}  ` });
    assert.equal(created.status, 201);
    const dto = await created.json() as ServiceDto;
    assert.match(dto.serviceId, /^[0-9a-f-]{36}$/);
    assert.equal(created.headers.get('location'), `/services/${dto.serviceId}`);
    assert.deepEqual(dto, { ...input, serviceId: dto.serviceId, isActive: true, timeZone: 'America/Costa_Rica' });
    const persisted = await database!.pool.query('SELECT clinic_id, name, duration_minutes, is_active FROM service WHERE service_id = $1', [dto.serviceId]);
    assert.deepEqual(persisted.rows, [{ clinic_id: clinic, name: input.name, duration_minutes: 30, is_active: true }]);

    const read = await request(`/${dto.serviceId}`);
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), dto);
    const listed = await request();
    assert.equal(listed.status, 200);
    assert.deepEqual(await listed.json(), [dto]);

    const replacement = { name: 'Seguimiento RF3', durationMinutes: 60, specialtyId: otherSpecialty };
    const updated = await request(`/${dto.serviceId}`, 'PUT', replacement);
    assert.equal(updated.status, 200);
    assert.deepEqual(await updated.json(), { ...dto, ...replacement });
    const stored = await database!.pool.query('SELECT name, duration_minutes, specialty_id FROM service WHERE service_id = $1', [dto.serviceId]);
    assert.deepEqual(stored.rows, [{ name: replacement.name, duration_minutes: 60, specialty_id: otherSpecialty }]);
    assert.deepEqual(await (await request(`/${dto.serviceId}`)).json(), { ...dto, ...replacement });

    // Same restricted application connection and tenant as the real service:
    // direct physical deletion must fail, while the HTTP retirement still works.
    await assert.rejects(withTenantTx(database!.db, ctx, async (tx) => {
      const role = await tx.execute(sql`select current_user as role,
        has_table_privilege(current_user, 'public.service', 'DELETE') as can_delete`);
      assert.deepEqual(role.rows, [{ role: 'medicitas_app', can_delete: false }]);
      return tx.execute(sql`delete from service where service_id = ${dto.serviceId}::uuid`);
    }, { dbRoles: MEDICITAS_APP_ROLE }), { status: 403, code: 'forbidden', pgCode: '42501' });

    const deleted = await request(`/${dto.serviceId}`, 'DELETE');
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '');
    const retired = { ...dto, ...replacement, isActive: false };
    const retained = await database!.pool.query('SELECT name, duration_minutes, specialty_id, is_active FROM service WHERE service_id = $1', [dto.serviceId]);
    assert.deepEqual(retained.rows, [{ name: replacement.name, duration_minutes: 60, specialty_id: otherSpecialty, is_active: false }]);
    const historical = await request(`/${dto.serviceId}`);
    assert.equal(historical.status, 200);
    assert.deepEqual(await historical.json(), retired);
    assert.deepEqual(await (await request()).json(), []);
    assert.equal((await request(`/${dto.serviceId}`, 'DELETE')).status, 204);
    const inactivePut = await request(`/${dto.serviceId}`, 'PUT', input);
    assert.equal(inactivePut.status, 404);
    assert.deepEqual(await inactivePut.json(), { error: 'Request rejected.', code: 'not_found' });
    assert.deepEqual(await (await request(`/${dto.serviceId}`)).json(), retired);
    const reservedName = await request('', 'POST', replacement);
    assert.equal(reservedName.status, 409);
    assert.deepEqual(await reservedName.json(), { error: 'Request rejected.', code: 'duplicate' });
    assert.equal((await request(`/${user}`, 'DELETE')).status, 404);
  });

  test('other-clinic IDs stay invisible and PostgreSQL enforces RLS independently', async () => {
    for (const [method, body] of [['GET', undefined], ['PUT', input], ['DELETE', undefined]] as const) {
      const response = await request(`/${foreignService}`, method, body);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'not_found' });
    }
    assert.deepEqual(await (await request()).json(), []);
    // Deliberately omit a clinic WHERE: the engine must still hide the other row.
    await withTenantTx(database!.db, ctx, async (tx) => {
      const role = await tx.execute(sql`select current_user as role, rolsuper, rolbypassrls
        from pg_roles where rolname = current_user`);
      assert.deepEqual(role.rows, [{ role: 'medicitas_app', rolsuper: false, rolbypassrls: false }]);
      assert.equal((await tx.execute(sql`select * from service`)).rowCount, 0);
      assert.equal((await tx.execute(sql`select * from clinic`)).rowCount, 1);
    }, { dbRoles: MEDICITAS_APP_ROLE });
    await assert.rejects(withTenantTx(database!.db, ctx, (tx) => tx.execute(sql`
      insert into service (clinic_id, specialty_id, name, duration_minutes)
      values (${otherClinic}::uuid, ${specialty}::uuid, 'RLS attack', 30)
    `), { dbRoles: MEDICITAS_APP_ROLE }), { status: 403, code: 'forbidden' });
    const unchanged = await database!.pool.query('SELECT name, duration_minutes, is_active FROM service WHERE service_id = $1', [foreignService]);
    assert.deepEqual(unchanged.rows, [{ name: input.name, duration_minutes: 45, is_active: false }]);
    const selector = await request(`?clinicId=${otherClinic}`);
    assert.equal(selector.status, 422);
  });

  test('verified HTTP authorization and validation return safe, distinct rejections', async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await request('', 'GET', undefined, null)).status, 401);
    assert.equal((await request('', 'GET', undefined, 'invalid-token')).status, 401);
    assert.equal((await request('', 'GET', undefined, incompleteToken)).status, 401);
    const denied = await request('', 'GET', undefined, receptionToken);
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Request rejected.', code: 'forbidden' });
    assert.ok(keyRequests > 0, 'The service must fetch JWKS to verify Bearer signatures.');
    assert.equal((await request('/not-a-uuid')).status, 404);
    for (const body of [{ ...input, durationMinutes: 0 }, { ...input, specialtyId: 'bad-id' }, { ...input, clinicId: otherClinic }, { ...input, isActive: false }]) {
      const invalid = await request('', 'POST', body);
      assert.equal(invalid.status, 422);
      assert.deepEqual(await invalid.json(), { error: 'Request rejected.', code: 'invalid_request' });
    }
    const missingSpecialty = await request('', 'POST', { ...input, specialtyId: user });
    assert.equal(missingSpecialty.status, 422);
    assert.deepEqual(await missingSpecialty.json(), { error: 'Request rejected.', code: 'invalid_reference' });
    const created = await request('', 'POST', input);
    assert.equal(created.status, 201);
    const { serviceId } = await created.json() as ServiceDto;
    try {
      const duplicate = await request('', 'POST', input);
      assert.equal(duplicate.status, 409);
      assert.deepEqual(await duplicate.json(), { error: 'Request rejected.', code: 'duplicate' });
      const statusUpdate = await request(`/${serviceId}`, 'PUT', { ...input, isActive: true });
      assert.equal(statusUpdate.status, 422);
      assert.deepEqual(await statusUpdate.json(), { error: 'Request rejected.', code: 'invalid_request' });
      const invalidUpdate = await request(`/${serviceId}`, 'PUT', { ...input, specialtyId: user });
      assert.equal(invalidUpdate.status, 422);
      const original = await request(`/${serviceId}`);
      assert.deepEqual(await original.json(), { ...input, serviceId, isActive: true, timeZone: 'America/Costa_Rica' });
    } finally {
      assert.equal((await request(`/${serviceId}`, 'DELETE')).status, 204);
    }
  });
});
