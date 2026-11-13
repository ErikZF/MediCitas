import express, { type Express } from 'express';
import { requiereTenantContext, requiereToken } from '@medicitas/auth';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import routes from './modules/routes.ts';
import { createServiceCatalogRouter } from './modules/service-catalog/service-catalog.routes.ts';
import type { ServiceCatalogDeps } from './modules/service-catalog/service-catalog.service.ts';
import { createSpecialtiesRouter } from './modules/specialties/specialties.routes.ts';
import { createClinicSettingsRouter } from './modules/clinic-settings/clinic-settings.routes.ts';

export interface AppDeps {
  serviceCatalog?: ServiceCatalogDeps;
}

/** server.ts supplies the real database; authentication has no context override. */
export function createApp(deps: AppDeps = {}): Express {
  const app = express();
  app.use(express.json());
  app.use(routes);
  if (deps.serviceCatalog !== undefined) {
    app.use('/services', requiereToken, requiereTenantContext, createServiceCatalogRouter(deps.serviceCatalog));
    app.use('/specialties', requiereToken, requiereTenantContext, createSpecialtiesRouter(deps.serviceCatalog));
    app.use('/clinic', requiereToken, requiereTenantContext, createClinicSettingsRouter(deps.serviceCatalog));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export default createApp();
