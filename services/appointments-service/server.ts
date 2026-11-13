import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';
import { createHttpClinicCalendar } from './adapters/clinic-calendar.http.ts';
import { createHttpClinicCatalog, createHttpPatientDirectory, createHttpProfessionalDirectory } from './adapters/directory.http.ts';
import { agendaCacheFromEnv } from './cache/redis.ts';

// Composition root: every module of appointments-service, wired to its real
// dependencies. One cache instance serves both reads and invalidations (I8).
try {
  const { db } = createDatabase(readDbConfig('DB_APPOINTMENTS', 'appointments-service'));
  const catalog = createHttpClinicCatalog(process.env.CLINICS_SERVICE_URL);
  const clinics = createHttpClinicCalendar(process.env.CLINICS_SERVICE_URL);
  const directory = createHttpProfessionalDirectory(process.env.USERS_SERVICE_URL);
  const patients = createHttpPatientDirectory(process.env.USERS_SERVICE_URL);
  const cache = agendaCacheFromEnv();
  if (cache === undefined) logger.info('Availability cache disabled: every read goes to PostgreSQL.');

  startServer(createApp({
    schedule: { db, directory, cache },
    availability: { db, catalog, directory, cache },
    booking: { db, catalog, patients, cache },
    clinicalNotes: { db },
    patientHistory: { db },
    dailyAgenda: { db, clinics },
    appointmentCounts: { db },
  }));
} catch {
  logger.error('Appointments database, service URLs or cache configuration is invalid.');
  process.exitCode = 1;
}
