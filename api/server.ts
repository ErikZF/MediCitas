import app from './app.ts';
import { readConfig } from './config/env.ts';
import { logger } from './utils/logger.ts';

function startServer(): void {
  let port: number;

  try {
    ({ port } = readConfig());
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

startServer();
