import { Router } from 'express';
import { extractTenantContext } from '@medicitas/auth';
import { ProfessionalError } from './professionals.errors.ts';
import { registerProfessional, type ProfessionalDeps } from './professionals.service.ts';

/** Mounted after requireToken and requireTenantContext, with no auth override. */
export function createProfessionalsRouter(deps: ProfessionalDeps): Router {
  const router = Router();
  router.post('/', async (req, res) => {
    if (Object.keys(req.query).length !== 0) throw new ProfessionalError('invalid_request');
    res.status(201).json(await registerProfessional(
      deps, extractTenantContext(req)!, req.body, req.get('authorization')!,
    ));
  });
  return router;
}
