import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { test, vi, type TestContext } from 'vitest';
import { errorHandler } from '../../src/errors.ts';

async function respond(t: TestContext, error: unknown) {
  const app = express();
  app.get('/', () => { throw error; });
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test('a 4xx error keeps its safe code so clients can tell conflicts apart', async (t) => {
  const result = await respond(t, Object.assign(new Error('x'), { status: 409, code: 'slot_taken' }));
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { error: 'Request rejected.', code: 'slot_taken' });
});

test('a 4xx error without a code keeps the previous body', async (t) => {
  const result = await respond(t, Object.assign(new Error('x'), { status: 400 }));
  assert.deepEqual(result.body, { error: 'Bad request.' });
});

test('codes that could leak internals are dropped', async (t) => {
  for (const code of ['ECONNRESET', '23505', 'has spaces', 'x'.repeat(80)]) {
    const result = await respond(t, Object.assign(new Error('x'), { status: 409, code }));
    assert.deepEqual(result.body, { error: 'Request rejected.' }, code);
  }
});

test('503 stays 503 with Retry-After instead of becoming 500', async (t) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await respond(t, Object.assign(new Error('pool exhausted'), { status: 503, code: 'database_unavailable' }));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('retry-after'), '1');
  assert.deepEqual(result.body, { error: 'Service unavailable.', code: 'database_unavailable' });
});

test('other server errors still answer a generic 500 without details', async (t) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await respond(t, Object.assign(new Error('secret'), { status: 502, code: 'upstream_failed' }));
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Internal server error.' });
});
