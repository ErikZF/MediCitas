import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';

try {
  const { db } = createDatabase(readDbConfig('DB_CLINICS', 'clinics-service'));
  startServer(createApp({ usersUrl: process.env.USERS_SERVICE_URL, serviceCatalog: { db } }));
} catch {
  logger.error('Clinics database configuration is invalid.');
  process.exitCode = 1;
}
