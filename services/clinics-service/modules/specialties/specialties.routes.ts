import { Router } from 'express';
import { extractTenantContext } from '@medicitas/auth';
import type { Database } from '@medicitas/db';
import { CatalogError } from '../service-catalog/service-catalog.errors.ts';
import { listSpecialties } from './specialties.service.ts';

/** Mounted at /specialties after Bearer and tenant verification. */
export function createSpecialtiesRouter(deps: { db: Database }): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    if (Object.keys(req.query).length !== 0) throw new CatalogError(422);
    res.json(await listSpecialties(deps, extractTenantContext(req)!));
  });
  return router;
}
