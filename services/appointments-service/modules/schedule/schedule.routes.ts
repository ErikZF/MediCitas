import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { blockBody, blockRangeQuery, workingHoursBody } from './schedule.schemas.ts';
import { addBlock, getWorkingHours, listBlocks, replaceWorkingHours, type ScheduleDeps } from './schedule.service.ts';

/** Mounted under /professionals, behind requireTenantContext. */
export function createScheduleRouter(deps: ScheduleDeps): Router {
  const router = Router();

  // RF5: read the weekly schedule.
  router.get('/:professionalId/working-hours', async (req, res) => {
    const professionalId = uuidOr404(req.params.professionalId);
    res.json({ workingHours: await getWorkingHours(deps, tenantOf(res), professionalId) });
  });

  // RF5: replace the weekly schedule (200 with the stored schedule).
  router.put('/:professionalId/working-hours', async (req, res) => {
    const professionalId = uuidOr404(req.params.professionalId);
    const body = parseOr422(workingHoursBody, req.body);
    res.json({ workingHours: await replaceWorkingHours(deps, tenantOf(res), professionalId, body.workingHours) });
  });

  // RF6: list blocks, optionally only those touching [from, to).
  router.get('/:professionalId/blocks', async (req, res) => {
    const professionalId = uuidOr404(req.params.professionalId);
    const range = parseOr422(blockRangeQuery, req.query);
    res.json({ blocks: await listBlocks(deps, tenantOf(res), professionalId, range) });
  });

  // RF6: register a block (201 with the block and the booked appointments it overlaps).
  router.post('/:professionalId/blocks', async (req, res) => {
    const professionalId = uuidOr404(req.params.professionalId);
    const body = parseOr422(blockBody, req.body);
    res.status(201).json(await addBlock(deps, tenantOf(res), professionalId, body));
  });

  return router;
}
