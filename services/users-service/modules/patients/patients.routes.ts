import { Router } from 'express';
import { extractTenantContext } from '@medicitas/auth';
import { PatientError } from './patients.errors.ts';
import { assertPatientAccess, getPatientMembership, createPatient, updatePatient, type PatientsDeps } from './patients.service.ts';

/** Mount after requiereToken and requiereTenantContext. No client identity headers. */
export function createPatientsRouter(deps: PatientsDeps): Router {
  const router = Router();
  const noQuery = (query: object) => {
    if (Object.keys(query).length !== 0) throw new PatientError('invalid_request');
  };

  router.post('/', async (req, res) => {
    const ctx = extractTenantContext(req)!;
    assertPatientAccess(ctx, 'patient:create');
    noQuery(req.query);
    const created = await createPatient(deps, ctx, req.body);
    res.location(`/patients/${created.patientId}`).status(201).json(created);
  });

  router.patch('/:patientId', async (req, res) => {
    const ctx = extractTenantContext(req)!;
    assertPatientAccess(ctx, 'patient:update');
    noQuery(req.query);
    await updatePatient(deps, ctx, req.params.patientId, req.body);
    res.status(204).end();
  });

  router.get('/:patientId', async (req, res) => {
    const ctx = extractTenantContext(req)!;
    assertPatientAccess(ctx, 'patient:read');
    noQuery(req.query);
    res.json(await getPatientMembership(deps, ctx, req.params.patientId));
  });

  return router;
}
