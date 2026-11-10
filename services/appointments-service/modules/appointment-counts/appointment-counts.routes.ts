import { Router } from 'express';
import { hasPermission } from '@medicitas/auth';
import type { Database } from '@medicitas/db';
import { ForbiddenError } from '../../domain/errors.ts';
import { tenantOf } from '../../http/context.ts';
import { parseOr422 } from '../../http/validation.ts';
import { appointmentCountsRange } from './appointment-counts.schemas.ts';
import { countAppointmentsByStatus } from './appointment-counts.service.ts';

export interface AppointmentCountsDeps {
  db: Database;
}

/**
 * Mounted at /appointments/counts by createApp when its dependencies are supplied,
 * behind requireTenantContext and using the agreed RF21 permission.
 */
export function createAppointmentCountsRouter(deps: AppointmentCountsDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const ctx = tenantOf(res);
    if (!hasPermission(ctx.role, 'appointment:count')) {
      throw new ForbiddenError();
    }
    const range = parseOr422(appointmentCountsRange, req.query);
    res.json(await countAppointmentsByStatus({ db: deps.db }, ctx, range));
  });

  return router;
}
