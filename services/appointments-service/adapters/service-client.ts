import type { z } from 'zod';
import { DependencyUnavailableError, NotFoundError } from '../domain/errors.ts';
import { currentAuthorization } from '../http/request-auth.ts';

// GET requests from appointments-service to clinics-service and users-service.
// 404 means the resource is not in the caller's clinic; any other failure (403,
// 5xx, timeout, malformed body) is a 503 raised before any transaction opens.

const TIMEOUT_MS = 3000;

/** Validates a *_SERVICE_URL at startup, so a bad value fails fast instead of per request. */
export function serviceBaseUrl(name: string, value: string | undefined): URL {
  try {
    const base = new URL(value ?? '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('Invalid URL.');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    return base;
  } catch {
    throw new Error(`${name} must be an HTTP(S) base URL without credentials, query or fragment.`);
  }
}

export async function getJson<T>(base: URL, path: string, schema: z.ZodType<T>, notFound: string): Promise<T> {
  const authorization = currentAuthorization();
  let response: Response;
  try {
    response = await fetch(new URL(path, base), {
      headers: authorization === undefined ? {} : { authorization },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new DependencyUnavailableError();
  }
  if (response.status === 404) {
    throw new NotFoundError(notFound);
  }
  if (!response.ok) {
    throw new DependencyUnavailableError();
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    throw new DependencyUnavailableError();
  }
  return parsed.data;
}
