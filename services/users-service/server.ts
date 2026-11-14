import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';
import { createHttpSpecialtyCatalog } from './adapters/specialty-catalog.http.ts';

import { keycloakAdmin } from './adapters/keycloak-admin.ts';

try {
  const specialties = createHttpSpecialtyCatalog(process.env.CLINICS_SERVICE_URL);
  const { db } = createDatabase(readDbConfig('DB_USERS', 'users-service'));
  startServer(createApp({ management: { db, identity: keycloakAdmin() }, clinicsUrl: process.env.CLINICS_SERVICE_URL, professionals: { db, specialties }, patients: { db } }));
} catch {
  logger.error('Users database or clinics service configuration is invalid.');
  process.exitCode = 1;
}
