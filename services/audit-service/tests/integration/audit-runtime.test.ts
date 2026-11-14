import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as reserveServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { test } from 'vitest';
import { createTestDatabase } from '../helpers/test-database.ts';

const url = process.env.TEST_DATABASE_URL;

// Real service entry point and PostgreSQL; only the OIDC issuer/JWKS is a fixture.
// This is not a test against Keycloak, the gateway or the N10 event producer.
test.skipIf(!url)('normal startup verifies Bearer, builds context and reads only its clinic', { timeout: 15000 }, async (t) => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const database = await createTestDatabase(url as string);
  const jwk = { ...await exportJWK(publicKey), kid: 'rf19-runtime', alg: 'RS256', use: 'sig' };
  let keyRequests = 0;
  const jwks = createServer((req, res) => {
    if (req.url !== '/realms/RF19/protocol/openid-connect/certs') {
      res.writeHead(404).end();
      return;
    }
    keyRequests++;
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }));
  });
  const reservation = reserveServer();
  let child: ChildProcess | undefined;
  let closed: Promise<unknown> | undefined;

  try {
    const clinic = '00000000-0000-4000-8000-000000000101';
    const otherClinic = '00000000-0000-4000-8000-000000000102';
    const user = '00000000-0000-4000-8000-000000000201';
    const patient = '00000000-0000-4000-8000-000000000301';
    const event = '00000000-0000-4000-8000-000000000401';
    await database.pool.query(`INSERT INTO audit_log
      (audit_log_id, clinic_id, app_user_id, patient_id, action, resource, resource_id, occurred_at)
      VALUES ($1, $2, $3, $4, 'read', 'patient_contact', $4, '2027-01-04T06:00:00Z'),
             (gen_uuid_v7(), $5, $3, $4, 'read', 'patient_contact', $4, '2027-01-04T06:00:00Z')`,
    [event, clinic, user, patient, otherClinic]);

    jwks.listen(0, '127.0.0.1');
    await once(jwks, 'listening');
    const keysAddress = jwks.address();
    assert.ok(keysAddress && typeof keysAddress !== 'string');
    const identityUrl = `http://127.0.0.1:${keysAddress.port}`;
    const issuer = `${identityUrl}/realms/RF19`;

    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    const dbUrl = new URL(database.url);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      API_INTERNAL_PORT: String(address.port),
      DB_LOGS_HOST: dbUrl.hostname,
      DB_CONNECT_PORT: dbUrl.port || '5432',
      DB_LOGS_NAME: decodeURIComponent(dbUrl.pathname.slice(1)),
      DB_LOGS_USER: decodeURIComponent(dbUrl.username),
      DB_LOGS_PASSWORD: decodeURIComponent(dbUrl.password),
      KEYCLOAK_INTERNAL_URL: identityUrl,
      KEYCLOAK_ISSUER: issuer,
      KEYCLOAK_AUDIENCE: 'rf19-runtime',
      REALM_NAME: 'RF19',
    };
    delete env.NODE_OPTIONS;
    delete env.TEST_DATABASE_URL;
    // Use the normal source entry point (as npm run dev does), without .env/watch.
    // Node's native TypeScript support is already required by the monorepo.
    child = spawn(process.execPath, [fileURLToPath(new URL('../../server.ts', import.meta.url))], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve) => child!.once('close', resolve));
    let output = '';
    let launchError: Error | undefined;
    child.on('error', (error) => { launchError = error; });
    child.stdout!.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    // Consume stderr without exposing connection details if startup fails.
    child.stderr!.resume();
    while (!output.includes('Server running on port ')) {
      assert.ifError(launchError);
      assert.equal(child.exitCode, null, 'Audit process exited before listening.');
      assert.equal(child.signalCode, null, 'Audit process stopped before listening.');
      await delay(25, undefined, { signal: t.signal });
    }

    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`, { signal: t.signal });
    assert.equal(health.status, 200);
    const spoofed = { 'x-role': 'clinic_admin', 'x-clinic-id': otherClinic, 'x-user-id': user };
    const denied = await fetch(`${base}/audit/logs`, { headers: spoofed, signal: t.signal });
    assert.equal(denied.status, 401); // Mounted and protected, rather than 404.

    const token = await new SignJWT({
      sub: 'keycloak-test-subject', app_user_id: user, clinic_id: clinic,
      role: 'clinic_admin', realm_access: { roles: ['clinic_admin'] },
    }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
      .setIssuer(issuer).setAudience('rf19-runtime')
      .setExpirationTime('5m').sign(privateKey);
    const response = await fetch(`${base}/audit/logs?patientId=${patient}`, {
      headers: { ...spoofed, authorization: `Bearer ${token}` }, signal: t.signal,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{
      auditLogId: event, clinicId: clinic, userId: user, patientId: patient,
      action: 'read', resource: 'patient_contact', resourceId: patient,
      occurredAt: '2027-01-04T06:00:00.000Z',
    }]);
    assert.equal(keyRequests, 1, 'The service must fetch the key to verify the JWT.');
  } finally {
    // Release the child before dropping its database; never touch another process.
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    if (reservation.listening) await new Promise<void>((resolve) => reservation.close(() => resolve()));
    jwks.closeAllConnections();
    if (jwks.listening) await new Promise<void>((resolve) => jwks.close(() => resolve()));
    await database.drop();
  }
});
