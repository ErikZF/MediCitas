import { Router } from 'express';
import { hasPermission } from '@medicitas/auth';
import type { Database } from '@medicitas/db';
import { ForbiddenError } from '../../domain/errors.ts';
import { tenantOf } from '../../http/context.ts';
import { uuidOr404 } from '../../http/validation.ts';
import { getPatientAppointmentHistory } from './patient-history.service.ts';

export interface PatientHistoryDeps {
  db: Database;
}

/** Mounted at /patients behind verified Bearer/context middleware in createApp. */
export function createPatientHistoryRouter(deps: PatientHistoryDeps): Router {
  const router = Router();

  router.get('/:patientId/appointments', async (req, res) => {
    const ctx = tenantOf(res);
    if (!hasPermission(ctx.role, 'appointment:read')) {
      throw new ForbiddenError();
    }
    const patientId = uuidOr404(req.params.patientId);
    res.json(await getPatientAppointmentHistory(deps, ctx, patientId));
  });

  return router;
}
