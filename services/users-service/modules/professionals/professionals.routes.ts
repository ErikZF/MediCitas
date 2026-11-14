import { Router } from 'express';
import { extractTenantContext } from '@medicitas/auth';
import { ProfessionalError } from './professionals.errors.ts';
import { getProfessional, registerProfessional, type ProfessionalDeps } from './professionals.service.ts';

/** Mounted after requireToken and requireTenantContext, with no auth override. */
export function createProfessionalsRouter(deps: ProfessionalDeps): Router {
  const router = Router();
  router.get('/:professionalId', async (req, res) => {
    if (Object.keys(req.query).length !== 0) throw new ProfessionalError('invalid_request');
    res.json(await getProfessional(deps, extractTenantContext(req)!, req.params.professionalId));
  });
  router.post('/', async (req, res) => {
    if (Object.keys(req.query).length !== 0) throw new ProfessionalError('invalid_request');
    const result = await registerProfessional(
      deps, { ctx: extractTenantContext(req)!, subject: req.user!.id }, req.body, req.get('authorization')!,
    );
    res.status(result.status).json(result.dto);
  });
  return router;
}
