import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import type { Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { requiereRol, requiereToken } from '../src/auth.ts';
import { requirePermission } from '../src/authorization.ts';
import type { Permission } from '../src/permissions.ts';

const { verify } = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('jose', () => ({ jwtVerify: verify, createRemoteJWKSet: vi.fn() }));

function request(): Request {
  return { headers: { authorization: 'Bearer test-token' } } as Request;
}

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

async function authenticate(req: Request, roles: unknown) {
  verify.mockResolvedValue({ payload: { sub: 'subject', preferred_username: 'test', realm_access: { roles } } });
  const res = response();
  const next = vi.fn();
  await requiereToken(req, res as unknown as Response, next);
  return { res, next };
}

function authorize(req: Request, permission: Permission = 'appointment:book') {
  const res = response();
  const next = vi.fn();
  requirePermission(permission)(req, res as unknown as Response, next);
  return { res, next };
}

describe('permission middleware', () => {
  beforeEach(() => {
    verify.mockReset();
    vi.stubEnv('KEYCLOAK_INTERNAL_URL', 'https://identity.example');
    vi.stubEnv('REALM_NAME', 'test');
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://identity.example/realms/test');
    vi.stubEnv('KEYCLOAK_AUDIENCE', 'test-api');
  });
  afterEach(() => vi.unstubAllEnvs());

  test('returns 401 without verified authentication', () => {
    const { res, next } = authorize(request());
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
  });

  test('does not trust an assigned usuario, body, query or role headers', () => {
    const req = request();
    req.usuario = { id: 'subject', username: 'test', roles: ['clinic_admin'] };
    req.body = { roles: ['clinic_admin'] };
    req.query = { roles: ['clinic_admin'] };
    req.headers['x-roles'] = 'clinic_admin';
    const { res, next } = authorize(req);
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
    requiereRol('clinic_admin')(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls[1]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
  });

  test.each([
    ['receptionist'], ['clinic_admin'], ['professional', 'receptionist'], ['unknown', 'receptionist'],
  ])('allows booking with verified roles %j', async (...roles) => {
    const req = request();
    await authenticate(req, roles);
    const { res, next } = authorize(req);
    assert.equal(next.mock.calls.length, 1);
    assert.equal(res.status.mock.calls.length, 0);
  });

  test.each([[], ['professional'], ['platform_admin'], ['unknown']])('returns 403 for verified roles %j', async (...roles) => {
    const req = request();
    await authenticate(req, roles);
    const { res, next } = authorize(req);
    assert.equal(res.status.mock.calls[0]?.[0], 403);
    assert.equal(next.mock.calls.length, 0);
  });

  test.each([null, 'clinic_admin', 42, {}, ['receptionist', 42]].map((roles) => ({ roles })))('returns 401 for malformed verified roles $roles', async ({ roles }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = request();
    const authentication = await authenticate(req, roles);
    assert.equal(authentication.res.status.mock.calls[0]?.[0], 401);
    assert.equal(authentication.next.mock.calls.length, 0);
    assert.equal(req.usuario, undefined);
    const { res, next } = authorize(req);
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
  });

  test('missing roles grant no permissions', async () => {
    const req = request();
    await authenticate(req, undefined);
    assert.deepEqual(req.usuario?.roles, []);
    assert.equal(authorize(req).res.status.mock.calls[0]?.[0], 403);
  });

  test('failed verification never establishes or retains provenance', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const req = request();
    await authenticate(req, ['clinic_admin']);
    verify.mockRejectedValue(new Error('Verification failed'));
    const res = response();
    const next = vi.fn();
    await requiereToken(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
    assert.equal(req.usuario, undefined);
    assert.equal(authorize(req).res.status.mock.calls[0]?.[0], 401);
  });

  test('keeps an immutable snapshot when usuario is changed later', async () => {
    const req = request();
    await authenticate(req, ['professional']);
    req.usuario!.roles.push('clinic_admin');
    assert.equal(authorize(req).res.status.mock.calls[0]?.[0], 403);
    const res = response();
    const next = vi.fn();
    requiereRol('clinic_admin')(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls[0]?.[0], 403);
    assert.equal(next.mock.calls.length, 0);
  });

  test('role checks use exact membership in verified roles, never substrings', async () => {
    const req = request();
    await authenticate(req, ['not_clinic_admin', 'receptionist']);
    const res = response();
    const next = vi.fn();
    requiereRol('clinic_admin')(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls[0]?.[0], 403);
    assert.equal(next.mock.calls.length, 0);
    requiereRol('receptionist')(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls.length, 1);
    assert.equal(next.mock.calls.length, 1);
  });

  test('does not share verified roles between requests', async () => {
    const req = request();
    await authenticate(req, ['clinic_admin']);
    assert.equal(authorize(request()).res.status.mock.calls[0]?.[0], 401);
  });

  test('clears provenance when authentication runs again without a token', async () => {
    const req = request();
    await authenticate(req, ['clinic_admin']);
    delete req.headers.authorization;
    const res = response();
    const next = vi.fn();
    await requiereToken(req, res as unknown as Response, next);
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.equal(next.mock.calls.length, 0);
    assert.equal(authorize(req).res.status.mock.calls[0]?.[0], 401);
  });

  test('does not bypass authorization for an unlisted action', async () => {
    const req = request();
    await authenticate(req, ['clinic_admin']);
    assert.equal(authorize(req, 'unknown:action' as Permission).res.status.mock.calls[0]?.[0], 403);
  });
});

describe('permission middleware over HTTP (JWT verification mocked)', () => {
  let server: Server;
  let baseUrl: string;
  const handler = vi.fn();

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.post('/book', requiereToken, requirePermission('appointment:book'), (_req, res) => {
      handler();
      res.status(200).json({ allowed: true });
    });
    app.post('/without-auth', (req, _res, next) => {
      req.usuario = { id: 'subject', username: 'test', roles: ['clinic_admin'] };
      next();
    }, requirePermission('appointment:book'), (_req, res) => {
      handler();
      res.json({ allowed: true });
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    verify.mockReset();
    handler.mockClear();
    vi.stubEnv('KEYCLOAK_INTERNAL_URL', 'https://identity.example');
    vi.stubEnv('REALM_NAME', 'test');
    vi.stubEnv('KEYCLOAK_ISSUER', 'https://identity.example/realms/test');
    vi.stubEnv('KEYCLOAK_AUDIENCE', 'test-api');
  });
  afterEach(() => vi.unstubAllEnvs());

  async function call(path = '/book', token?: string) {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-roles': 'clinic_admin' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    const result = await fetch(`${baseUrl}${path}?roles=clinic_admin`, {
      method: 'POST', headers, body: JSON.stringify({ roles: ['clinic_admin'] }),
    });
    assert.match(result.headers.get('content-type') ?? '', /application\/json/);
    return { status: result.status, body: await result.json() };
  }

  function verifiedPayload(roles: unknown) {
    verify.mockResolvedValue({ payload: { sub: 'subject', preferred_username: 'test', realm_access: { roles } } });
  }

  test('401 without a token ignores roles supplied through HTTP', async () => {
    assert.deepEqual(await call(), { status: 401, body: { error: 'falta el token de acceso' } });
    assert.equal(verify.mock.calls.length, 0);
    assert.equal(handler.mock.calls.length, 0);
  });

  test('401 after a simulated verification failure exposes no internal error in JSON', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    verify.mockRejectedValue(new Error('Internal verification detail'));
    assert.deepEqual(await call('/book', 'rejected-token'), {
      status: 401, body: { error: 'token inválido o expirado' },
    });
    assert.equal(verify.mock.calls[0]?.[0], 'rejected-token');
    assert.equal(handler.mock.calls.length, 0);
  });

  test('403 for a verified professional despite client-supplied admin roles', async () => {
    verifiedPayload(['professional']);
    assert.deepEqual(await call('/book', 'test-token'), { status: 403, body: { error: 'Permission denied.' } });
    assert.equal(handler.mock.calls.length, 0);
  });

  test.each([
    { roles: ['receptionist'] },
    { roles: ['professional', 'receptionist'] },
  ])('200 when verified roles $roles grant booking', async ({ roles }) => {
    verifiedPayload(roles);
    assert.deepEqual(await call('/book', 'test-token'), { status: 200, body: { allowed: true } });
    assert.equal(handler.mock.calls.length, 1);
  });

  test('401 for malformed roles returned by the simulated verifier', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    verifiedPayload(['receptionist', 42]);
    assert.deepEqual(await call('/book', 'test-token'), { status: 401, body: { error: 'token inválido o expirado' } });
    assert.equal(handler.mock.calls.length, 0);
  });

  test('401 when authentication middleware is omitted even with an assigned usuario', async () => {
    assert.deepEqual(await call('/without-auth', 'test-token'), { status: 401, body: { error: 'Authentication required.' } });
    assert.equal(verify.mock.calls.length, 0);
    assert.equal(handler.mock.calls.length, 0);
  });

  test('an allowed HTTP request does not authenticate the following request', async () => {
    verifiedPayload(['receptionist']);
    assert.equal((await call('/book', 'test-token')).status, 200);
    assert.equal((await call()).status, 401);
    assert.equal(handler.mock.calls.length, 1);
    assert.equal(verify.mock.calls.length, 1);
  });
});
