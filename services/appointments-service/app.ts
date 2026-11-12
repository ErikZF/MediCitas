import express, { type Express } from 'express';
import { extractTenantContext, requiereToken } from '@medicitas/auth';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { defaultContextResolver, requireTenantContext, type ContextResolver } from './http/context.ts';
import { createAppointmentCountsRouter, type AppointmentCountsDeps } from './modules/appointment-counts/appointment-counts.routes.ts';
import { createAvailabilityRouter } from './modules/availability/availability.routes.ts';
import type { AvailabilityDeps } from './modules/availability/availability.service.ts';
import { createBookingRouter } from './modules/booking/booking.routes.ts';
import type { BookingDeps } from './modules/booking/booking.service.ts';
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
  availability?: AvailabilityDeps;
  patientHistory?: PatientHistoryDeps;
}

/**
 * Without dependencies the app only serves /health. The domain routes are mounted
 * once server.ts can build the context from the token claims (cards N3 and J1).
 */
export function createApp(deps?: AppDeps): Express {
  const app = express();

  app.use(express.json());

  app.use(routes);
  if (deps !== undefined) {
    const withContext = requireTenantContext(deps.resolveContext ?? defaultContextResolver);
    if (deps.schedule !== undefined) {
      app.use('/professionals', withContext, createScheduleRouter(deps.schedule));
    }
    if (deps.appointmentCounts !== undefined) {
      app.use('/appointments/counts', withContext, createAppointmentCountsRouter(deps.appointmentCounts));
    }
    if (deps.booking !== undefined) {
      app.use('/appointments', withContext, createBookingRouter(deps.booking));
    }
    if (deps.availability !== undefined) {
      app.use('/availability', withContext, createAvailabilityRouter(deps.availability));
    }
    if (deps.patientHistory !== undefined) {
      // Only an explicit test/composition resolver bypasses Bearer verification.
      const withPatientHistoryContext = deps.resolveContext === undefined
        ? [requiereToken, requireTenantContext(extractTenantContext)]
        : [withContext];
      app.use('/patients', ...withPatientHistoryContext, createPatientHistoryRouter(deps.patientHistory));
    }
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
