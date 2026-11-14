import express, { type Express } from 'express';
import { extractTenantContext, requireToken } from '@medicitas/auth';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { requireTenantContext, type ContextResolver } from './http/context.ts';
import { captureAuthorization } from './http/request-auth.ts';
import { createAppointmentCountsRouter, type AppointmentCountsDeps } from './modules/appointment-counts/appointment-counts.routes.ts';
import { createAvailabilityRouter } from './modules/availability/availability.routes.ts';
import type { AvailabilityDeps } from './modules/availability/availability.service.ts';
import { createBookingRouter } from './modules/booking/booking.routes.ts';
import type { BookingDeps } from './modules/booking/booking.service.ts';
import { createClinicalNoteRouter } from './modules/clinical-notes/clinical-note.routes.ts';
import type { ClinicalNoteDeps } from './modules/clinical-notes/clinical-note.service.ts';
import { createDailyAgendaRouter } from './modules/daily-agenda/daily-agenda.routes.ts';
import type { DailyAgendaDeps } from './modules/daily-agenda/daily-agenda.service.ts';
import { createPatientHistoryRouter, type PatientHistoryDeps } from './modules/patient-history/patient-history.routes.ts';
import routes from './modules/routes.ts';
import { createScheduleRouter } from './modules/schedule/schedule.routes.ts';
import type { ScheduleDeps } from './modules/schedule/schedule.service.ts';

export interface AppDeps {
  /** Builds the tenant context from the request (defaults to @medicitas/auth token claims in production). */
  resolveContext?: ContextResolver;
  schedule?: ScheduleDeps;
  booking?: BookingDeps;
  appointmentCounts?: AppointmentCountsDeps;
  dailyAgenda?: DailyAgendaDeps;
  availability?: AvailabilityDeps;
  patientHistory?: PatientHistoryDeps;
  clinicalNotes?: ClinicalNoteDeps;
}

/**
 * Without dependencies the app only serves /health; server.ts mounts every module.
 *
 * In production every domain route verifies the Bearer token first (RF17): 401 without
 * a valid token, then the permission checks of each module answer 403. Only tests pass
 * `resolveContext` to inject a context without Keycloak.
 */
export function createApp(deps?: AppDeps): Express {
  const app = express();

  app.use(express.json());

  app.use(routes);
  if (deps !== undefined) {
    const authenticated = deps.resolveContext === undefined
      ? [requireToken, requireTenantContext(extractTenantContext), captureAuthorization]
      : [requireTenantContext(deps.resolveContext), captureAuthorization];
    if (deps.schedule !== undefined) {
      app.use('/professionals', ...authenticated, createScheduleRouter(deps.schedule));
    }
    if (deps.appointmentCounts !== undefined) {
      app.use('/appointments/counts', ...authenticated, createAppointmentCountsRouter(deps.appointmentCounts));
    }
    if (deps.dailyAgenda !== undefined) {
      app.use('/agenda', ...authenticated, createDailyAgendaRouter(deps.dailyAgenda));
    }
    if (deps.clinicalNotes !== undefined) {
      // Only /:appointmentId/note; every other /appointments path falls through to booking.
      app.use('/appointments', ...authenticated, createClinicalNoteRouter(deps.clinicalNotes));
    }
    if (deps.booking !== undefined) {
      app.use('/appointments', ...authenticated, createBookingRouter(deps.booking));
    }
    if (deps.availability !== undefined) {
      app.use('/availability', ...authenticated, createAvailabilityRouter(deps.availability));
    }
    if (deps.patientHistory !== undefined) {
      app.use('/patients', ...authenticated, createPatientHistoryRouter(deps.patientHistory));
    }
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
