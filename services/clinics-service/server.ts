import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';

try {
  const { db } = createDatabase(readDbConfig('DB_CLINICS', 'clinics-service'));
  startServer(createApp({ serviceCatalog: { db } }));
} catch {
  logger.error('Clinics database configuration is invalid.');
  process.exitCode = 1;
}
