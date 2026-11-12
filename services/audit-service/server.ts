import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';

try {
  const { db } = createDatabase(readDbConfig('DB_LOGS', 'audit-service'));
  // No context override: createApp requires a verified Bearer token for RF19.
  startServer(createApp({ auditQuery: { db } }));
} catch {
  logger.error('Audit database configuration is invalid.');
  process.exitCode = 1;
}
