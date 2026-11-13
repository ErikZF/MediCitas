import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { uuidOr404 } from '../../http/validation.ts';
import { authorizeDailyAgenda, getDailyAgenda, type DailyAgendaDeps } from './daily-agenda.service.ts';

/** Mount at /agenda behind verified Bearer and tenant context. */
export function createDailyAgendaRouter(deps: DailyAgendaDeps): Router {
  const router = Router();
  router.get('/', async (req, res) => {
    res.json(await getDailyAgenda(deps, tenantOf(res), req.query, req.get('authorization') ?? ''));
  });
  router.get('/professionals/:professionalId', async (req, res) => {
    const ctx = tenantOf(res);
    const rawId = req.params.professionalId as string;
    authorizeDailyAgenda(ctx, rawId);
    const professionalId = uuidOr404(rawId);
    res.json(await getDailyAgenda(deps, ctx, req.query, req.get('authorization') ?? '', professionalId));
  });
  return router;
}
