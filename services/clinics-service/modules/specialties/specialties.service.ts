import { asc } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { specialty } from '../../db/schema.ts';
import { CatalogError } from '../service-catalog/service-catalog.errors.ts';

/** Global reference data needed to register a professional; not service management. */
export async function listSpecialties(deps: { db: Database }, ctx: TenantContext) {
  if (ctx.clinicId === null || !hasPermission(ctx.role, 'professional:create')) throw new CatalogError(403);
  return withTenantTx(deps.db, ctx, (tx) => tx.select().from(specialty)
    .orderBy(asc(specialty.name), asc(specialty.specialtyId)),
  { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
}
