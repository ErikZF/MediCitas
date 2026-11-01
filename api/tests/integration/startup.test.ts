import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test, type TestContext } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// Vitest runs this TypeScript file, but startup must exercise pretest's fresh build.
const serverPath = fileURLToPath(new URL('../../dist/server.js', import.meta.url));
const apiDirectory = fileURLToPath(new URL('../../', import.meta.url));

function launchServer(t: TestContext, port?: string) {
  const env = { ...process.env };
  delete env.API_INTERNAL_PORT;
  delete env.NODE_OPTIONS;
  if (port !== undefined) env.API_INTERNAL_PORT = port;

  // Run the compiled entry point directly so a local .env cannot hide missing configuration.
  const child = spawn(process.execPath, [serverPath], {
    cwd: apiDirectory,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let launchError: Error | undefined;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.on('error', (error) => { launchError = error; });

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  t.onTestFinished(async () => {
    // Stop only the child created by this test, including when an assertion times out.
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });

  return {
    closed,
    output: () => ({ stdout, stderr }),
    async waitUntilListening() {
      while (!stdout.includes('Server running on port ')) {
        assert.ifError(launchError);
        assert.equal(child.exitCode, null, `Server exited before listening: ${stderr}`);
        assert.equal(child.signalCode, null, 'Server was terminated before listening.');
        await delay(25, undefined, { signal: t.signal });
      }
    },
  };
}

async function reservePort(t: TestContext) {
  const reservation = createServer();
  const close = () => new Promise<void>((resolve, reject) => {
    if (!reservation.listening) {
      resolve();
      return;
    }
    reservation.close((error) => error ? reject(error) : resolve());
  });
  t.onTestFinished(close);
  // Let the OS select a temporary port instead of relying on a fixed test port.
  reservation.listen(0);
  await once(reservation, 'listening');
  const address = reservation.address();
  assert.ok(address && typeof address !== 'string');
  return { port: address.port, close };
}

function assertStartupFailure(
  output: { stdout: string; stderr: string },
  expectedMessage: string,
) {
  // Startup failures must exit quietly except for one safe, structured error message.
  assert.equal(output.stdout, '', 'A failed startup must not announce success.');
  const lines = output.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, 'Only a controlled log entry should be emitted.');
  const entry = JSON.parse(lines[0]!);
  assert.deepEqual(Object.keys(entry).sort(), ['level', 'message', 'timestamp']);
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, expectedMessage);
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
}

test('compiled server starts on the configured port and preserves public responses', { timeout: 10000 }, async (t) => {
  const reservation = await reservePort(t);
  // Release the temporary port so the real API process can bind to it.
  await reservation.close();
  const server = launchServer(t, String(reservation.port));
  await server.waitUntilListening();
  const baseUrl = `http://127.0.0.1:${reservation.port}`;

  const root = await fetch(`${baseUrl}/`, { signal: t.signal });
  assert.equal(root.status, 200);
  assert.equal(await root.text(), 'Hello World!');

  const health = await fetch(`${baseUrl}/health`, { signal: t.signal });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const missing = await fetch(`${baseUrl}/missing`, { signal: t.signal });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Route not found.' });
  assert.equal(server.output().stderr, '');
});

const configurationMessage = 'API_INTERNAL_PORT is required and must be an integer between 1 and 65535.';

test('compiled server rejects an absent port', { timeout: 10000 }, async (t) => {
  const server = launchServer(t);
  assert.deepEqual(await server.closed, { code: 1, signal: null });
  assertStartupFailure(server.output(), configurationMessage);
});

test('compiled server rejects an invalid port', { timeout: 10000 }, async (t) => {
  // readConfig unit tests cover the full set of invalid values; this checks process startup.
  const server = launchServer(t, '3000.5');
  assert.deepEqual(await server.closed, { code: 1, signal: null });
  assertStartupFailure(server.output(), configurationMessage);
});

test('compiled server rejects an occupied port without announcing success', { timeout: 10000 }, async (t) => {
  // Keep this listener open to trigger a real port conflict, not a mocked error.
  const reservation = await reservePort(t);
  const server = launchServer(t, String(reservation.port));
  assert.deepEqual(await server.closed, { code: 1, signal: null });
  assertStartupFailure(
    server.output(),
    'API_INTERNAL_PORT is already in use. Choose another port or stop the application using it.',
  );
});
