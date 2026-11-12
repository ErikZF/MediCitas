import { Router } from 'express';
import { hasPermission } from '@medicitas/auth';
import type { Database } from '@medicitas/db';
import { tenantOf } from '../../http/context.ts';
import { queryAuditLogs } from './audit-query.service.ts';

export interface AuditQueryDeps {
  db: Database;
}

/** Mounted at /audit/logs by createApp only when its dependencies are provided. */
export function createAuditQueryRouter(deps: AuditQueryDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const ctx = tenantOf(res);
    if (!hasPermission(ctx.role, 'audit:read')) {
      res.status(403).json({ error: 'Request rejected.', code: 'forbidden' });
      return;
    }
    // The service validates filters once and scopes the query to ctx.clinicId.
    res.json(await queryAuditLogs(deps, ctx, req.query));
  });

  return router;
}
