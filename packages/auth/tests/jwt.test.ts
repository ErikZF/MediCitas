import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { Request, Response } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest';
import { requiereToken } from '../src/auth.ts';
import { requirePermission } from '../src/authorization.ts';

// Real jose verification and a local public JWKS; private keys exist only in memory.
describe('signed JWT authentication', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let otherKeys: Awaited<ReturnType<typeof generateKeyPair>>;
  let server: Server;
  let internalUrl: string;
  const issuer = 'https://issuer.example/realms/test';
  const audience = 'test-api';

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    otherKeys = await generateKeyPair('RS256');
    const publicKey = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
    server = createServer((req, res) => {
      if (req.url !== '/realms/test/protocol/openid-connect/certs') {
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
    vi.stubEnv('REALM_NAME', 'test');
    vi.stubEnv('KEYCLOAK_ISSUER', issuer);
    vi.stubEnv('KEYCLOAK_AUDIENCE', audience);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.unstubAllEnvs());

  async function signed(options: { audience?: string | string[] | null; issuer?: string; expiration?: number | null; wrongKey?: boolean; subject?: string | number | null } = {}) {
    let jwt = new SignJWT({
      realm_access: { roles: ['receptionist'] },
      // Negative tests deliberately sign a non-string subject.
      ...(options.subject === null ? {} : { sub: (options.subject ?? 'test-subject') as string }),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? issuer);
    if (options.audience !== null) jwt = jwt.setAudience(options.audience ?? audience);
    if (options.expiration !== null) jwt = jwt.setExpirationTime(options.expiration ?? Math.floor(Date.now() / 1000) + 300);
    return jwt.sign(options.wrongKey ? otherKeys.privateKey : keys.privateKey);
  }

  async function authenticate(token: string) {
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = { status: vi.fn(), json: vi.fn() };
    res.status.mockReturnValue(res);
    const next = vi.fn();
    await requiereToken(req, res as unknown as Response, next);
    return { req, res, next };
  }

  test('accepts a valid signature, issuer, expiry and audience and enables permission checks', async () => {
    const { req, res, next } = await authenticate(await signed());
    assert.equal(next.mock.calls.length, 1);
    assert.equal(res.status.mock.calls.length, 0);
    const allowed = vi.fn();
    requirePermission('appointment:book')(req, res as unknown as Response, allowed);
    assert.equal(allowed.mock.calls.length, 1);
    assert.equal(vi.mocked(console.error).mock.calls.length, 0);
  });

  test('accepts an audience array containing the configured recipient', async () => {
    const { next, res } = await authenticate(await signed({ audience: ['other-api', audience] }));
    assert.equal(next.mock.calls.length, 1);
    assert.equal(res.status.mock.calls.length, 0);
  });

  test.each([
    { name: 'wrong audience', options: { audience: 'other-api' } },
    { name: 'missing audience', options: { audience: null } },
    { name: 'invalid signature', options: { wrongKey: true } },
    { name: 'expired token', options: { expiration: Math.floor(Date.now() / 1000) - 60 } },
    { name: 'wrong issuer', options: { issuer: 'https://other.example' } },
    { name: 'missing expiry', options: { expiration: null } },
    { name: 'missing subject', options: { subject: null } },
    { name: 'empty subject', options: { subject: '' } },
    { name: 'non-string subject', options: { subject: 42 } },
  ])('rejects $name', async ({ options }) => {
    const { req, res, next } = await authenticate(await signed(options));
    assert.equal(res.status.mock.calls[0]?.[0], 401);
    assert.deepEqual(res.json.mock.calls[0]?.[0], { error: 'token inválido o expirado' });
    assert.equal(next.mock.calls.length, 0);
    assert.deepEqual(vi.mocked(console.error).mock.calls, [[JSON.stringify({ level: 'error', event: 'jwt_verification_failed' })]]);
    const allowed = vi.fn();
    requirePermission('appointment:book')(req, res as unknown as Response, allowed);
    assert.equal(allowed.mock.calls.length, 0);
  });

  test.each(['KEYCLOAK_ISSUER', 'KEYCLOAK_AUDIENCE', 'KEYCLOAK_INTERNAL_URL', 'REALM_NAME'])('fails closed when %s is missing', async (name) => {
    vi.stubEnv(name, undefined);
    const { res, next } = await authenticate(await signed());
    assert.equal(res.status.mock.calls[0]?.[0], 500);
    assert.deepEqual(res.json.mock.calls[0]?.[0], { error: 'Authentication unavailable.' });
    assert.equal(next.mock.calls.length, 0);
    assert.deepEqual(vi.mocked(console.error).mock.calls, [[JSON.stringify({ level: 'error', event: 'auth_configuration_invalid' })]]);
  });

  test('rejects a whitespace-only audience configuration', async () => {
    vi.stubEnv('KEYCLOAK_AUDIENCE', '   ');
    const { res, next } = await authenticate(await signed());
    assert.equal(res.status.mock.calls[0]?.[0], 500);
    assert.equal(next.mock.calls.length, 0);
  });

  test('rejects credentials embedded in the JWKS URL without logging them', async () => {
    vi.stubEnv('KEYCLOAK_INTERNAL_URL', 'https://test-user:test-secret@identity.example');
    const { res, next } = await authenticate(await signed());
    assert.equal(res.status.mock.calls[0]?.[0], 500);
    assert.equal(next.mock.calls.length, 0);
    assert.deepEqual(vi.mocked(console.error).mock.calls, [[JSON.stringify({ level: 'error', event: 'auth_configuration_invalid' })]]);
  });
});
