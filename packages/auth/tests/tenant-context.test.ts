import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Request, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { extractTenantContext, requiereTenantContext, requiereToken } from '../src/auth.ts';

describe('multi-tenant context extraction from Keycloak tokens', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let server: Server;
  let internalUrl: string;
  const issuer = 'https://identity.medicitas.example/realms/Sistema_Clinico';
  const audience = 'Medi_Citas';

  const CLINIC_ID = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
  const USER_ID = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
  const PROF_ID = 'fa8d9e2a-1c3b-4f5a-8e7d-9a0b1c2d3e4f';

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'medicitas-key', alg: 'RS256', use: 'sig' };
    server = createServer((req, res) => {
      if (req.url !== '/realms/Sistema_Clinico/protocol/openid-connect/certs') {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [publicKey] }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    internalUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    vi.stubEnv('KEYCLOAK_INTERNAL_URL', internalUrl);
    vi.stubEnv('REALM_NAME', 'Sistema_Clinico');
    vi.stubEnv('KEYCLOAK_ISSUER', issuer);
    vi.stubEnv('KEYCLOAK_AUDIENCE', audience);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => vi.unstubAllEnvs());

  async function signedToken(claims: Record<string, unknown> = {}, roles: string[] = ['receptionist']) {
    return new SignJWT({
      sub: 'kc-user-uuid-1234',
      preferred_username: 'ana.reception',
      realm_access: { roles },
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'medicitas-key' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(keys.privateKey);
  }

  function mockHttp(token?: string) {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    } as unknown as Request;
    const res = {
      status: vi.fn(),
      json: vi.fn(),
      locals: {} as Record<string, unknown>,
    };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    return { req, res, next, asResponse: res as unknown as Response };
  }

  test('extracts valid TenantContext for receptionist from clinic_id and app_user_id claims', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: USER_ID,
    }, ['receptionist']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereToken(req, asResponse, next);
    assert.equal(next.mock.calls.length, 1);

    const ctx = extractTenantContext(req);
    assert.deepEqual(ctx, {
      clinicId: CLINIC_ID,
      userId: USER_ID,
      role: 'receptionist',
    });
  });

  test('extracts valid TenantContext for platform_admin with null clinicId', async () => {
    const token = await signedToken({
      app_user_id: USER_ID,
    }, ['platform_admin']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereToken(req, asResponse, next);
    assert.equal(next.mock.calls.length, 1);

    const ctx = extractTenantContext(req);
    assert.deepEqual(ctx, {
      clinicId: null,
      userId: USER_ID,
      role: 'platform_admin',
    });
  });

  test('extracts valid TenantContext for professional with professional_id', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: USER_ID,
      professional_id: PROF_ID,
    }, ['professional']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereToken(req, asResponse, next);
    assert.equal(next.mock.calls.length, 1);

    const ctx = extractTenantContext(req);
    assert.deepEqual(ctx, {
      clinicId: CLINIC_ID,
      userId: USER_ID,
      role: 'professional',
      professionalId: PROF_ID,
    });
  });

  test('extracts domain role specified in explicit role claim', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: USER_ID,
      role: 'clinic_admin',
    }, ['user']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereToken(req, asResponse, next);
    assert.equal(next.mock.calls.length, 1);

    const ctx = extractTenantContext(req);
    assert.deepEqual(ctx, {
      clinicId: CLINIC_ID,
      userId: USER_ID,
      role: 'clinic_admin',
    });
  });

  test('fails closed for professional missing professional_id claim', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: USER_ID,
    }, ['professional']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereTenantContext(req, asResponse, next);

    assert.equal(next.mock.calls.length, 0);
    assert.equal(res.status.mock.calls[0][0], 401);
    assert.deepEqual(res.json.mock.calls[0][0], { error: 'Tenant context required.' });
  });

  test('fails closed for clinic_admin missing clinic_id claim', async () => {
    const token = await signedToken({
      app_user_id: USER_ID,
    }, ['clinic_admin']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereTenantContext(req, asResponse, next);

    assert.equal(next.mock.calls.length, 0);
    assert.equal(res.status.mock.calls[0][0], 401);
  });

  test('fails closed when user_id is not a valid UUID', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: 'not-a-uuid',
    }, ['receptionist']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereTenantContext(req, asResponse, next);

    assert.equal(next.mock.calls.length, 0);
    assert.equal(res.status.mock.calls[0][0], 401);
  });

  test('requiereTenantContext middleware populates res.locals.tenant on success', async () => {
    const token = await signedToken({
      clinic_id: CLINIC_ID,
      app_user_id: USER_ID,
    }, ['receptionist']);

    const { req, res, next, asResponse } = mockHttp(token);
    await requiereTenantContext(req, asResponse, next);

    assert.equal(next.mock.calls.length, 1);
    assert.deepEqual(res.locals.tenant, {
      clinicId: CLINIC_ID,
      userId: USER_ID,
      role: 'receptionist',
    });
  });
});
