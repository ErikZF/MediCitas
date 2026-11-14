import express, { type Express } from 'express';
import { extractTenantContext, requireToken } from '@medicitas/auth';
import { errorHandler, notFoundHandler } from '@medicitas/http';
import { requireTenantContext, type ContextResolver } from './http/context.ts';
import { createAuditQueryRouter, type AuditQueryDeps } from './modules/audit-query/audit-query.routes.ts';
import routes from './modules/routes.ts';

export interface AppDeps {
  /** Test/composition override. Without it, the route verifies the Bearer token. */
  resolveContext?: ContextResolver;
  auditQuery?: AuditQueryDeps;
}

/** Domain routes require injected dependencies; the default app keeps /health only. */
export function createApp(deps?: AppDeps): Express {
  const app = express();

  app.use(express.json());
  app.use(routes);
  if (deps?.auditQuery !== undefined) {
    const withContext = deps.resolveContext === undefined
      ? [requireToken, requireTenantContext(extractTenantContext)]
      : [requireTenantContext(deps.resolveContext)];
    app.use('/audit/logs', ...withContext, createAuditQueryRouter(deps.auditQuery));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp();
