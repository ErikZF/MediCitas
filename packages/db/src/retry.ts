import { findPgError } from './errors.ts';

// 40001 serialization_failure and 40P01 deadlock_detected: Postgres has already rolled
// back the transaction, so running it again from the start is safe. No other code is retried.
const RETRYABLE = new Set(['40001', '40P01']);

export interface RetryOptions {
  /** Total attempts, including the first one. Defaults to 3. */
  maxAttempts?: number;
  /** Base of the exponential backoff, in milliseconds. Defaults to 20. */
  baseDelayMs?: number;
  /** Maximum wait between attempts. Defaults to 250. */
  maxDelayMs?: number;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; pgCode: string }) => void;
}

export function isRetryable(error: unknown): boolean {
  const pg = findPgError(error);
  return pg !== null && RETRYABLE.has(pg.code);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with "full jitter": a random wait between 0 and min(cap, base·2^n). */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 20;
  const maxDelayMs = options.maxDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer.');
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      options.onRetry?.({ attempt, delayMs, pgCode: findPgError(error)?.code ?? '' });
      await sleep(delayMs);
    }
  }
}
