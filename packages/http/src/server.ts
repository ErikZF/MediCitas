import type { Express } from 'express';
import { readConfig } from './env.ts';
import { logger } from './logger.ts';

// Starts a service on API_INTERNAL_PORT. Every service calls this from its own server.ts.
export function startServer(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  let port: number;

  try {
    ({ port } = readConfig(env));
  } catch {
    logger.error('API_INTERNAL_PORT is required and must be an integer between 1 and 65535.');
    process.exitCode = 1;
    return;
  }

  const server = app.listen(port);

  server.once('listening', () => {
    logger.info(`Server running on port ${port}`);
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const message = error.code === 'EADDRINUSE'
      ? 'API_INTERNAL_PORT is already in use. Choose another port or stop the application using it.'
      : 'Faild to start API. Check the configured port and permission to listen on it.';
    logger.error(message);
    process.exitCode = 1;
  });
}
