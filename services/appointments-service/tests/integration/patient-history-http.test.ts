import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Database, TenantContext } from '@medicitas/db';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, test, vi, type TestContext } from 'vitest';
import { createApp } from '../../app.ts';
import { getPatientAppointmentHistory } from '../../modules/patient-history/patient-history.service.ts';

vi.mock('../../modules/patient-history/patient-history.service.ts', () => ({ getPatientAppointmentHistory: vi.fn() }));

// Actual app, router, permission matrix and Bearer verification. Only the query
// is mocked; PostgreSQL/RLS stays covered by patient-history.test.ts.
// An ephemeral public JWKS fixture follows packages/auth's existing JWT tests;
// no Keycloak, service startup or additional database infrastructure is involved.
const ctx: TenantContext = {
  clinicId: '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01',
  userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04',
  role: 'receptionist',
};
const patient = 'b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06';
const foreignClinic = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
const history: Awaited<ReturnType<typeof getPatientAppointmentHistory>> = [{
  appointmentId: 'e1000000-0000-4000-8000-000000000005',
  professionalId: '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05',
  serviceId: 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08',
  startsAt: '2099-01-04T10:00:00.000Z', endsAt: '2099-01-04T10:30:00.000Z',
  status: 'booked', rescheduledFromId: 'e1000000-0000-4000-8000-000000000001',
}, {
  appointmentId: 'e1000000-0000-4000-8000-000000000001',
  professionalId: '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05',
  serviceId: 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08',
  startsAt: '2026-01-04T18:00:00.000Z', endsAt: '2026-01-04T18:30:00.000Z',
  status: 'rescheduled', rescheduledFromId: null,
}];
const db = {} as Database;
const query = vi.mocked(getPatientAppointmentHistory);
const spoofed = { 'x-clinic-id': foreignClinic, 'x-role': 'clinic_admin', 'x-user-id': ctx.userId };
const audience = 'rf16-http';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: Server;
let issuer: string;
let identityUrl: string;
let keyRequests = 0;

beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const publicKey = { ...await exportJWK(keys.publicKey), kid: 'rf16-http', alg: 'RS256', use: 'sig' };
  jwks = createServer((_req, res) => {
    keyRequests++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicKey] }));
  }).listen(0, '127.0.0.1');
  await once(jwks, 'listening');
  const address = jwks.address();
  assert.ok(address && typeof address !== 'string');
  identityUrl = `http://127.0.0.1:${address.port}`;
  issuer = `${identityUrl}/realms/RF16`;
});

afterAll(async () => {
  if (jwks) {
    jwks.closeAllConnections();
    await new Promise<void>((resolve, reject) => jwks.close((error) => error ? reject(error) : resolve()));
  }
});

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue(history);
  vi.stubEnv('KEYCLOAK_INTERNAL_URL', identityUrl);
  vi.stubEnv('REALM_NAME', 'RF16');
  vi.stubEnv('KEYCLOAK_ISSUER', issuer);
  vi.stubEnv('KEYCLOAK_AUDIENCE', audience);
});
afterEach(() => vi.unstubAllEnvs());

async function signed(identity: TenantContext = ctx, claims: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: 'rf16-subject', app_user_id: identity.userId, clinic_id: identity.clinicId,
    realm_access: { roles: [identity.role] }, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'rf16-http' })
    .setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(keys.privateKey);
}

async function startApp(t: TestContext, deps: Parameters<typeof createApp>[0] = { patientHistory: { db } }) {
  const server = createApp(deps).listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return (path = `/patients/${patient}/appointments`, token?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { ...spoofed, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  });
}

test('200: verifies Bearer, forwards only patient/context and preserves the response, including []', async (t) => {
  const request = await startApp(t);
  const token = await signed();
  const response = await request(`/patients/${patient}/appointments?clinicId=${foreignClinic}&role=platform_admin`, token);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), history);
  assert.deepEqual(query.mock.lastCall, [{ db }, ctx, patient]);
  assert.ok(keyRequests > 0, 'The real authentication middleware must fetch the public key.');
  query.mockResolvedValueOnce([]);
  const empty = await request(undefined, token);
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), []);
  assert.equal(query.mock.calls.length, 2);
});

test('401: missing/invalid Bearer or missing context never calls the query, even with spoofed headers', async (t) => {
  const request = await startApp(t);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const valid = await signed();
  const [header, payload] = valid.split('.');
  // Keep the valid payload but replace its signature: decoding alone must not authorize.
  for (const token of [undefined, `${header}.${payload}.${'A'.repeat(342)}`, await signed(ctx, { clinic_id: null })]) {
    const response = await request(undefined, token);
    assert.equal(response.status, 401);
  }
  const withoutIdentity = await startApp(t, { patientHistory: { db }, resolveContext: () => null });
  assert.equal((await withoutIdentity()).status, 401);
  assert.equal(query.mock.calls.length, 0);
  log.mockRestore();
});

test('403: a verified platform_admin lacks appointment:read and cannot reach the query', async (t) => {
  const request = await startApp(t);
  const response = await request(undefined, await signed({ ...ctx, clinicId: null, role: 'platform_admin' }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'forbidden' });
  assert.equal(query.mock.calls.length, 0);
});

test('404: invalid patient UUID is rejected before querying; the route is absent without its dependency', async (t) => {
  const request = await startApp(t, { patientHistory: { db }, resolveContext: () => ctx });
  const response = await request('/patients/not-a-uuid/appointments');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Request rejected.', code: 'not_found' });
  const withoutDependency = await startApp(t, {});
  assert.equal((await withoutDependency()).status, 404);
  assert.equal(query.mock.calls.length, 0);
});
