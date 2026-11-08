import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from './logger.ts';

// A stable, machine-readable code such as "slot_taken" may go to the client.
// Anything else (system codes like ECONNRESET, SQLSTATE values) never does.
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function property(error: unknown, key: 'status' | 'code'): unknown {
  return typeof error === 'object' && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

function safeCode(error: unknown): string | undefined {
  const code = property(error, 'code');
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = property(error, 'status');
  const code = safeCode(error);

  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) {
    const message = status === 400 ? 'Bad request.' : 'Request rejected.';
    res.status(status).json(code === undefined ? { error: message } : { error: message, code });
    return;
  }

  if (status === 503) {
    // A dependency (database, cache) is unavailable or too slow: worth retrying later.
    logger.error('Dependency unavailable.');
    res.status(503).set('Retry-After', '1')
      .json(code === undefined ? { error: 'Service unavailable.' } : { error: 'Service unavailable.', code });
    return;
  }

  logger.error('Unhandled request error.');
  res.status(500).json({ error: 'Internal server error.' });
};
