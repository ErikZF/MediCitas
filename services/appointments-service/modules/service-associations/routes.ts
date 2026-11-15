import { Router } from 'express';
import { z } from 'zod';
import { hasPermission } from '@medicitas/auth';
import { MEDICITAS_DB_ROLES, withTenantTx, type Database } from '@medicitas/db';
import { professionalService } from '../../db/schema.ts';
import { ForbiddenError, ValidationError } from '../../domain/errors.ts';
import { tenantOf } from '../../http/context.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import type { ClinicCatalog } from '../booking/ports.ts';
import { assertTakesNewBookings } from '../booking/slot-rules.ts';

export interface SpecialtyDirectory {
  getSpecialties(professionalId: string): Promise<string[]>;
}

export interface AssociationDeps {
  db: Database;
  catalog: ClinicCatalog;
  directory: SpecialtyDirectory;
}

const empty = z.strictObject({});

export function createServiceAssociationRouter({ db, catalog, directory }: AssociationDeps): Router {
  const router = Router();
  router.put('/:professionalId/services/:serviceId', async (req, res) => {
    const ctx = tenantOf(res);
    if (!ctx.clinicId || !hasPermission(ctx.role, 'professional:create')) throw new ForbiddenError();
    const professionalId = uuidOr404(req.params.professionalId);
    const serviceId = uuidOr404(req.params.serviceId);
    parseOr422(empty, req.query);
    parseOr422(empty, req.body === undefined ? {} : req.body);

    const specialtyIds = await directory.getSpecialties(professionalId);
    const service = await catalog.getBookableService(ctx, serviceId);
    assertTakesNewBookings(service);
    if (!specialtyIds.includes(service.specialtyId)) {
      throw new ValidationError('The professional lacks the required specialty.', 'specialty_mismatch');
    }
    const { clinicId } = ctx;
    await withTenantTx(db, ctx, tx => tx.insert(professionalService)
      .values({ clinicId, professionalId, serviceId, specialtyId: service.specialtyId })
      .onConflictDoUpdate({
        target: [professionalService.clinicId, professionalService.professionalId, professionalService.serviceId],
        set: { specialtyId: service.specialtyId },
      }), { dbRoles: MEDICITAS_DB_ROLES });
    res.status(204).end();
  });
  return router;
}
