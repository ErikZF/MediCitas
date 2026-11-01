import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, vi, type TestContext } from 'vitest';
import express, { type Express } from 'express';
import app from '../../app.ts';
import { errorHandler } from '../../middleware/errors.ts';

async function startServer(t: TestContext, application: Express) {
  // A temporary loopback port keeps tests independent from the configured API port.
  const server = application.listen(0, '127.0.0.1');
  t.onTestFinished(async () => {
    // Close requests and the listener so test resources do not survive a failure.
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

test('the existing root response is preserved', async (t) => {
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Hello World!');
});

test('health is public and works without external services', async (t) => {
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('unknown routes return a JSON 404', async (t) => {
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/missing`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'Route not found.' });
});

test('malformed JSON returns a safe JSON 400', async (t) => {
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/missing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"secret":',
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Bad request.' });
});

test('oversized JSON preserves the parser status', async (t) => {
  const baseUrl = await startServer(t, app);
  const response = await fetch(`${baseUrl}/missing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: 'x'.repeat(110 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request rejected.' });
});

test('unexpected async errors return a generic JSON 500', async (t) => {
  // Capture logging only; the request still exercises Express error handling over HTTP.
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const failingApp = express();
  failingApp.get('/failure', async () => {
    throw new Error('Private diagnostic details');
  });
  failingApp.use(errorHandler);
  const baseUrl = await startServer(t, failingApp);
  const response = await fetch(`${baseUrl}/failure`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error.' });
  assert.equal(log.mock.calls.length, 1);
  const serializedLog = JSON.stringify(log.mock.calls[0]!);
  assert.ok(!serializedLog.includes('Private diagnostic details'));
  assert.ok(serializedLog.includes('Unhandled request error.'));
});
