import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { backoffDelay, isRetryable, withRetry } from '../../src/retry.ts';
import { drizzleWrapped } from '../helpers/fake-db.ts';

describe('withRetry', () => {
  test('only 40001 and 40P01 are retryable', () => {
    assert.equal(isRetryable(drizzleWrapped('40001')), true);
    assert.equal(isRetryable(drizzleWrapped('40P01')), true);
    assert.equal(isRetryable(drizzleWrapped('23P01')), false);
    assert.equal(isRetryable(new Error('timeout de red')), false);
  });

  test('waits with capped exponential backoff and reports every retry', async () => {
    const waits: number[] = [];
    const notices: number[] = [];
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw drizzleWrapped('40P01');
      return 'ok';
    }, {
      maxAttempts: 3,
      baseDelayMs: 20,
      maxDelayMs: 250,
      random: () => 0.999,
      sleep: async (ms) => { waits.push(ms); },
      onRetry: ({ attempt }) => notices.push(attempt),
    });
    assert.deepEqual(waits, [19, 39]);
    assert.deepEqual(notices, [1, 2]);
  });

  test('the wait cap holds as the base grows', () => {
    assert.equal(backoffDelay(10, 20, 250, () => 0.999), 249);
    assert.equal(backoffDelay(1, 20, 250, () => 0), 0);
  });

  test('rethrows the last error once attempts run out', async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => {
      calls += 1;
      throw drizzleWrapped('40001');
    }, { maxAttempts: 2, sleep: async () => {} }));
    assert.equal(calls, 2);
  });

  test('rejects a configuration with no attempts', async () => {
    await assert.rejects(withRetry(async () => 1, { maxAttempts: 0 }), RangeError);
  });
});
