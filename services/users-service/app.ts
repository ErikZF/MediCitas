import express, { type Express } from 'express';
import { requiereTenantContext, requiereToken } from '@medicitas/auth';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import routes from './modules/routes.ts';
import { createProfessionalsRouter } from './modules/professionals/professionals.routes.ts';
import type { ProfessionalDeps } from './modules/professionals/professionals.service.ts';
import { createPatientsRouter } from './modules/patients/patients.routes.ts';
import type { PatientsDeps } from './modules/patients/patients.service.ts';

export interface AppDeps {
  professionals?: ProfessionalDeps;
  patients?: PatientsDeps;
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(routes);
  if (deps.professionals !== undefined) {
    app.use('/professionals', requiereToken, requiereTenantContext, createProfessionalsRouter(deps.professionals));
  }
  if (deps.patients !== undefined) {
    app.use('/patients', requiereToken, requiereTenantContext, createPatientsRouter(deps.patients));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp();
