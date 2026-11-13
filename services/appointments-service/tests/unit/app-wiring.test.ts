import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Database } from '@medicitas/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { createHttpClinicCatalog, createHttpPatientDirectory, createHttpProfessionalDirectory } from '../../adapters/directory.http.ts';
import { createApp } from '../../app.ts';

// The production composition (card E12): real Bearer verification on every route and
// the real HTTP adapters (E13) against a stand-in for clinics-service and users-service.
// Every request here is answered before a transaction opens, so no database is needed.

const CLINIC = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
const USER = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
const PROF = '9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03';
const PATIENT = '00000000-0000-4000-8000-000000000001';
const ACTIVE = 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';
const RETIRED = 'e5f7b9c1-4d6e-4f8a-9b0c-2d3e4f5a6b0a';
const FORBIDDEN = 'f6a8c0d2-5e7f-4a9b-8c1d-3e4f5a6b7c0b';
const UNKNOWN = 'a1b2c3d4-0000-4000-8000-00000000000f';
const audience = 'appointments-wiring';

const db = {} as Database; // never reached: every case below ends before the transaction
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let identity: Server;
let directory: Server;
let api: Server;
let issuer: string;
let identityUrl: string;
let directoryUrl: string;
let apiUrl: string;
const seen: Array<{ path: string; authorization: string | undefined }> = [];

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

/** clinics-service and users-service as far as appointments-service sees them. */
function answer(req: IncomingMessage): [number, unknown] {
  const [, resource, id] = (req.url ?? '').split('/');
  if (resource === 'services' && id === ACTIVE) return [200, { serviceId: ACTIVE, durationMinutes: 30, isActive: true, timeZone: 'UTC' }];
  if (resource === 'services' && id === RETIRED) return [200, { serviceId: RETIRED, durationMinutes: 30, isActive: false, timeZone: 'UTC' }];
  if (resource === 'services' && id === FORBIDDEN) return [403, { error: 'Request rejected.' }];
  if (resource === 'professionals' && id === PROF) return [200, { professionalId: PROF }];
  return [404, { error: 'Request rejected.' }];
}

const token = (role = 'receptionist') => new SignJWT({
  sub: 'wiring', app_user_id: USER, clinic_id: CLINIC, realm_access: { roles: [role] },
  ...(role === 'professional' ? { professional_id: PROF } : {}),
})
  .setProtectedHeader({ alg: 'RS256', kid: 'wiring' }).setIssuer(issuer).setAudience(audience).setExpirationTime('5m')
  .sign(keys.privateKey);

const call = async (method: string, path: string, bearer?: string, body?: unknown) => {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
};
const booking = (serviceId: string, patientId = PATIENT) =>
  ({ professionalId: PROF, patientId, serviceId, startsAt: '2099-01-05T09:00:00Z' });

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'wiring', alg: 'RS256', use: 'sig' };
  identity = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicKey] })));
  identityUrl = await listen(identity);
  issuer = `${identityUrl}/realms/Wiring`;

  directory = createServer((req, res) => {
    seen.push({ path: req.url ?? '', authorization: req.headers.authorization });
    const [status, body] = answer(req);
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  directoryUrl = await listen(directory);

  const catalog = createHttpClinicCatalog(directoryUrl);
  const professionals = createHttpProfessionalDirectory(directoryUrl);
  api = createApp({
    schedule: { db, directory: professionals },
    availability: { db, catalog, directory: professionals },
    booking: { db, catalog, patients: createHttpPatientDirectory(directoryUrl) },
    clinicalNotes: { db },
    patientHistory: { db },
    dailyAgenda: { db, clinics: { getTimeZone: async () => 'UTC' } },
    appointmentCounts: { db },
  }).listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  apiUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const server of [api, directory, identity]) {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
});

beforeEach(() => {
  seen.length = 0;
  vi.stubEnv('KEYCLOAK_INTERNAL_URL', identityUrl);
  vi.stubEnv('REALM_NAME', 'Wiring');
  vi.stubEnv('KEYCLOAK_ISSUER', issuer);
  vi.stubEnv('KEYCLOAK_AUDIENCE', audience);
});
afterEach(() => vi.unstubAllEnvs());

describe('every mounted route verifies the token (RF17)', () => {
  test.each([
    ['GET', `/professionals/${PROF}/working-hours`],
    ['GET', `/availability/professionals/${PROF}?serviceId=${ACTIVE}&date=2099-01-05`],
    ['GET', `/availability?serviceId=${ACTIVE}&from=2099-01-05&to=2099-01-06`],
    ['POST', '/appointments'],
    ['GET', `/appointments/${UNKNOWN}`],
    ['POST', `/appointments/${UNKNOWN}/cancel`],
    ['GET', `/appointments/${UNKNOWN}/note`],
    ['GET', `/patients/${PATIENT}/appointments`],
    ['GET', '/agenda?date=2099-01-05'],
    ['GET', '/appointments/counts?from=2099-01-01&to=2099-02-01'],
  ])('401 without a token: %s %s', async (method, path) => {
    assert.equal((await call(method, path, undefined, method === 'POST' ? {} : undefined)).status, 401);
  });

  test('401 with a token the identity provider did not sign', async () => {
    const [header, payload, signature] = (await token()).split('.');
    const middle = Math.floor(signature!.length / 2);
    const flipped = signature![middle] === 'A' ? 'B' : 'A';
    const forged = [header, payload, signature!.slice(0, middle) + flipped + signature!.slice(middle + 1)].join('.');
    assert.equal((await call('POST', '/appointments', forged, booking(ACTIVE))).status, 401);
  });

  test('403 with a valid token of a role that cannot book', async () => {
    assert.equal((await call('POST', '/appointments', await token('professional'), booking(ACTIVE))).status, 403);
  });
});

describe('the adapters reach the other services with the caller\'s token', () => {
  test('a retired service takes no new bookings: 422 service_inactive', async () => {
    const bearer = await token();
    const result = await call('POST', '/appointments', bearer, booking(RETIRED));
    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'service_inactive');
    assert.deepEqual(seen, [{ path: `/services/${RETIRED}`, authorization: `Bearer ${bearer}` }]);
  });

  test('404 when the other service does not know the resource in this clinic', async () => {
    const unknownService = await call('POST', '/appointments', await token(), booking(UNKNOWN));
    assert.equal(unknownService.status, 404);
    const unknownPatient = await call('POST', '/appointments', await token(), booking(ACTIVE, UNKNOWN));
    assert.equal(unknownPatient.status, 404);
    assert.deepEqual(seen.map((s) => s.path), [`/services/${UNKNOWN}`, `/services/${ACTIVE}`, `/patients/${UNKNOWN}`]);
  });

  test('503 dependency_unavailable when the other service refuses or is down', async () => {
    const refused = await call('POST', '/appointments', await token(), booking(FORBIDDEN));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, 'dependency_unavailable');

    const down = createHttpClinicCatalog('http://127.0.0.1:1');
    await assert.rejects(down.getBookableService({ clinicId: CLINIC, userId: USER, role: 'receptionist' }, ACTIVE),
      { status: 503, code: 'dependency_unavailable' });
  });

  test('service URLs are validated at startup', () => {
    for (const bad of [undefined, 'file:///tmp', 'http://user:secret@users', 'http://users?x=1']) {
      assert.throws(() => createHttpPatientDirectory(bad), /USERS_SERVICE_URL/);
    }
  });
});
