import { Router } from 'express';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { clinicalNoteBody } from './clinical-note.schemas.ts';
import { createClinicalNote, readClinicalNote, updateClinicalNote, type ClinicalNoteDeps } from './clinical-note.service.ts';

/**
 * Mounted under /appointments, behind requireTenantContext (RF15).
 *   POST /appointments/:appointmentId/note   201, 409 note_exists, 422 appointment_not_attended
 *   GET  /appointments/:appointmentId/note   200, 404 when there is no note yet
 *   PUT  /appointments/:appointmentId/note   200, 404 when there is no note yet
 * Anyone but the professional of the appointment: 403. Another clinic's appointment: 404.
 */
export function createClinicalNoteRouter(deps: ClinicalNoteDeps): Router {
  const router = Router();

  router.post('/:appointmentId/note', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    const body = parseOr422(clinicalNoteBody, req.body);
    res.status(201).json(await createClinicalNote(deps, tenantOf(res), appointmentId, body));
  });

  router.get('/:appointmentId/note', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    res.json(await readClinicalNote(deps, tenantOf(res), appointmentId));
  });

  router.put('/:appointmentId/note', async (req, res) => {
    const appointmentId = uuidOr404(req.params.appointmentId);
    const body = parseOr422(clinicalNoteBody, req.body);
    res.json(await updateClinicalNote(deps, tenantOf(res), appointmentId, body));
  });

  return router;
}
