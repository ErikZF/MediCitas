import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { readConfig } from '../../config/env.ts';
import { logger } from '../../utils/logger.ts';

test('configuration requires an explicit API port', () => {
  assert.throws(() => readConfig({}), {
    message: 'API_INTERNAL_PORT is required.',
  });
});

test('configuration reads a valid TCP port as a number', () => {
  for (const port of [1, 3100, 65535]) {
    assert.equal(readConfig({ API_INTERNAL_PORT: String(port) }).port, port);
  }
});

test('configuration rejects invalid ports before starting the server', () => {
  // Reject malformed values and TCP port boundaries before any listener is created.
  for (const port of ['', ' ', '0', '-1', '65536', '3000.5', '3e3', 'abc', '3000/socket']) {
    assert.throws(() => readConfig({ API_INTERNAL_PORT: port }), /API_INTERNAL_PORT/);
  }
});

test('logger emits structured messages with a level and timestamp', () => {
  for (const level of ['info', 'error'] as const) {
    const output = vi.spyOn(console, level).mockImplementation(() => {});
    logger[level]('API infrastructure event.');
    assert.equal(output.mock.calls.length, 1);
    const [line] = output.mock.calls[0]!;
    const entry = JSON.parse(String(line));
    assert.deepEqual(Object.keys(entry).sort(), ['level', 'message', 'timestamp']);
    assert.equal(entry.level, level);
    assert.equal(entry.message, 'API infrastructure event.');
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  }
});
