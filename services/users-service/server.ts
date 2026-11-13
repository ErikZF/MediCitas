import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';
import { createHttpSpecialtyCatalog } from './adapters/specialty-catalog.http.ts';

try {
  const specialties = createHttpSpecialtyCatalog(process.env.CLINICS_SERVICE_URL);
  const { db } = createDatabase(readDbConfig('DB_USERS', 'users-service'));
  startServer(createApp({ professionals: { db, specialties } }));
} catch {
  logger.error('Users database or clinics service configuration is invalid.');
  process.exitCode = 1;
}
