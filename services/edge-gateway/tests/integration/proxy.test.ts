import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createGateway } from '../../app.ts';
import { readUpstreams, serviceFor, type ServiceName } from '../../modules/proxy.ts';

// The gateway in front of four stand-in services that echo what they receive.

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function echo(service: ServiceName): Server {
  return createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => { body += chunk; });
    req.on('end', () => {
      if (req.url === '/appointments/conflict') {
        res.writeHead(409, { 'content-type': 'application/json', 'x-upstream': service }).end('{"code":"slot_taken"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ service, method: req.method, url: req.url, headers: req.headers, body }));
    });
  });
}

describe('edge-gateway proxy (I3)', () => {
  const servers: Server[] = [];
  let gateway: string;
  let partial: string;

  beforeAll(async () => {
    const urls: Record<string, string> = {};
    for (const service of ['clinics', 'users', 'appointments', 'audit'] as const) {
      const server = echo(service);
      servers.push(server);
      urls[service] = await listen(server);
    }
    const upstreams = readUpstreams({
      CLINICS_SERVICE_URL: urls.clinics, USERS_SERVICE_URL: urls.users,
      APPOINTMENTS_SERVICE_URL: urls.appointments, AUDIT_SERVICE_URL: `${urls.audit}/`,
    });
    const app = createGateway(upstreams).listen(0, '127.0.0.1');
    servers.push(app);
    await once(app, 'listening');
    const address = app.address();
    assert.ok(address && typeof address !== 'string');
    gateway = `http://127.0.0.1:${address.port}`;

    // Audit points to a closed port; users is not configured at all.
    const closed = createServer();
    const closedUrl = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const degraded = createGateway({ clinics: new URL(urls.clinics!), audit: new URL(closedUrl) }).listen(0, '127.0.0.1');
    servers.push(degraded);
    await once(degraded, 'listening');
    const second = degraded.address();
    assert.ok(second && typeof second !== 'string');
    partial = `http://127.0.0.1:${second.port}`;
  });

  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each([
    ['/services/abc', 'clinics'], ['/specialties', 'clinics'], ['/clinic/time-zone', 'clinics'], ['/clinics', 'clinics'],
    ['/users/abc/role', 'users'], ['/professionals', 'users'], ['/professionals/abc', 'users'],
    ['/patients', 'users'], ['/patients/abc', 'users'],
    ['/professionals/abc/working-hours', 'appointments'], ['/professionals/abc/blocks', 'appointments'],
    ['/patients/abc/appointments', 'appointments'], ['/appointments/abc/note', 'appointments'],
    ['/appointments/counts', 'appointments'], ['/availability', 'appointments'], ['/agenda/professionals/abc', 'appointments'],
    ['/audit/logs', 'audit'],
  ])('%s belongs to %s', (path, service) => {
    assert.equal(serviceFor(path), service);
  });

  test.each(['/', '/health', '/servicesx', '/professionalsx/abc', '/audits', '/missing'])('%s is not forwarded', (path) => {
    assert.equal(serviceFor(path), undefined);
  });

  test('method, path, query, body and Authorization reach the service unchanged', async () => {
    const response = await fetch(`${gateway}/appointments?x=1&y=%2B2`, {
      method: 'POST',
      headers: { authorization: 'Bearer token', 'content-type': 'application/json', 'x-test-context': '{"role":"clinic_admin"}' },
      body: JSON.stringify({ startsAt: '2027-01-04T09:00:00-06:00' }),
    });
    assert.equal(response.status, 200);
    const seen = await response.json() as { service: string; method: string; url: string; headers: Record<string, string>; body: string };
    assert.equal(seen.service, 'appointments');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/appointments?x=1&y=%2B2');
    assert.equal(seen.body, '{"startsAt":"2027-01-04T09:00:00-06:00"}');
    assert.equal(seen.headers.authorization, 'Bearer token');
    assert.equal(seen.headers['x-test-context'], undefined, 'a test-only header never crosses the gateway');
    assert.ok(seen.headers['x-forwarded-for']);
  });

  test('a service base path is kept', async () => {
    const seen = await (await fetch(`${gateway}/audit/logs?from=2027-01-01T00:00:00Z`)).json() as { service: string; url: string };
    assert.deepEqual([seen.service, seen.url], ['audit', '/audit/logs?from=2027-01-01T00:00:00Z']);
  });

  test("the service's status, headers and body come back as they are", async () => {
    const response = await fetch(`${gateway}/appointments/conflict`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('x-upstream'), 'appointments');
    assert.deepEqual(await response.json(), { code: 'slot_taken' });
  });

  test('unknown paths, / and /health stay in the gateway', async () => {
    assert.deepEqual(await (await fetch(`${gateway}/health`)).json(), { status: 'ok' });
    const missing = await fetch(`${gateway}/missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Route not found.' });
  });

  test('a service that is down: 502; one that is not configured: 503', async () => {
    const down = await fetch(`${partial}/audit/logs`);
    assert.equal(down.status, 502);
    assert.deepEqual(await down.json(), { error: 'Service unavailable.', code: 'upstream_unavailable' });
    const missing = await fetch(`${partial}/patients`);
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get('retry-after'), '1');
    assert.deepEqual(await missing.json(), { error: 'Service unavailable.', code: 'upstream_not_configured' });
    assert.equal((await fetch(`${partial}/services`)).status, 200, 'the other services keep working');
  });

  test('invalid service URLs are rejected at startup', () => {
    for (const bad of ['ftp://clinics', 'http://user:secret@clinics', 'http://clinics?x=1']) {
      assert.throws(() => readUpstreams({ CLINICS_SERVICE_URL: bad }), /CLINICS_SERVICE_URL/);
    }
  });
});
