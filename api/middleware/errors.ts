import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../utils/logger.ts';

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
};

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const status = typeof error === 'object' && error !== null && 'status' in error
    ? error.status
    : undefined;

  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 500) {
    const message = status === 400 ? 'Bad request.' : 'Request rejected.';
    res.status(status).json({ error: message });
    return;
  }

  logger.error('Unhandled request error.');
  res.status(500).json({ error: 'Internal server error.' });
};
