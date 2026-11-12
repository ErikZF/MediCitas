import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { requireTenantContext, type ContextResolver } from './http/context.ts';
import { createAuditQueryRouter, type AuditQueryDeps } from './modules/audit-query/audit-query.routes.ts';
import routes from './modules/routes.ts';

export interface AppDeps {
  resolveContext: ContextResolver;
  auditQuery?: AuditQueryDeps;
}

/** Domain routes require injected dependencies; the default app keeps /health only. */
export function createApp(deps?: AppDeps): Express {
  const app = express();

  app.use(express.json());
  app.use(routes);
  if (deps?.auditQuery !== undefined) {
    app.use('/audit/logs', requireTenantContext(deps.resolveContext), createAuditQueryRouter(deps.auditQuery));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
