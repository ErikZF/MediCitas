import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { requireTenantContext, type ContextResolver } from './http/context.ts';
import routes from './modules/routes.ts';
import { createScheduleRouter } from './modules/schedule/schedule.routes.ts';
import type { ScheduleDeps } from './modules/schedule/schedule.service.ts';

export interface AppDeps {
  /** Builds the tenant context from the request (the verified token in production). */
  resolveContext: ContextResolver;
  schedule: ScheduleDeps;
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
    app.use('/professionals', requireTenantContext(deps.resolveContext), createScheduleRouter(deps.schedule));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
