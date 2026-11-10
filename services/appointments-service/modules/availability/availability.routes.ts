import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { professionalAvailabilityQuery, serviceAvailabilityQuery } from './availability.schemas.ts';
import { getProfessionalAvailability, getServiceAvailability, type AvailabilityDeps } from './availability.service.ts';

/**
 * Mounted under /availability, behind requireTenantContext.
 *   GET /availability?serviceId&from&to                         RF8
 *   GET /availability/professionals/:professionalId?serviceId&date   RF7
 */
export function createAvailabilityRouter(deps: AvailabilityDeps): Router {
  const router = Router();

  router.get('/', async (req, res) => {
    const query = parseOr422(serviceAvailabilityQuery, req.query);
    res.json(await getServiceAvailability(deps, tenantOf(res), query));
  });

  router.get('/professionals/:professionalId', async (req, res) => {
    const professionalId = uuidOr404(req.params.professionalId);
    const query = parseOr422(professionalAvailabilityQuery, req.query);
    res.json(await getProfessionalAvailability(deps, tenantOf(res), professionalId, query));
  });

  return router;
}
