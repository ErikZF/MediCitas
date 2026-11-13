import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';
import { createHttpClinicCalendar } from './adapters/clinic-calendar.http.ts';

try {
  const clinics = createHttpClinicCalendar(process.env.CLINICS_SERVICE_URL);
  const { db } = createDatabase(readDbConfig('DB_APPOINTMENTS', 'appointments-service'));
  startServer(createApp({ dailyAgenda: { db, clinics }, appointmentCounts: { db }, patientHistory: { db } }));
} catch {
  logger.error('Appointments database or clinics service configuration is invalid.');
  process.exitCode = 1;
}
