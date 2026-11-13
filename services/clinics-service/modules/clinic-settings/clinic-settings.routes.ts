import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { extractTenantContext, hasPermission } from '@medicitas/auth';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database } from '@medicitas/db';
import { clinic } from '../../db/schema.ts';
import { CatalogError } from '../service-catalog/service-catalog.errors.ts';

/** Read only the authenticated clinic's calendar settings, after Bearer/context verification. */
export function createClinicSettingsRouter(deps: { db: Database }): Router {
  const router = Router();
  router.get('/time-zone', async (req, res) => {
    const ctx = extractTenantContext(req)!;
    if (!hasPermission(ctx.role, 'appointment:read') || ctx.clinicId === null) throw new CatalogError(403);
    if (Object.keys(req.query).length !== 0) throw new CatalogError(422);
    const [row] = await withTenantTx(deps.db, ctx, (tx) => tx
      .select({ clinicId: clinic.clinicId, timeZone: clinic.timeZone })
      .from(clinic).where(eq(clinic.clinicId, ctx.clinicId!)),
    { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
    if (!row) throw new CatalogError(404);
    res.json(row);
  });
  return router;
}
