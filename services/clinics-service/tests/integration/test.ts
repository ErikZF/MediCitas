import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'vitest';
import app from '../../app.ts';

async function startServer(t: TestContext) {
  // A temporary loopback port keeps tests independent from the configured API port.
  const server = app.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('health is public and names the service', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'clinics-service' });
});

test('unknown routes return a JSON 404', async (t) => {
  const baseUrl = await startServer(t);
  const response = await fetch(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Route not found.' });
});
