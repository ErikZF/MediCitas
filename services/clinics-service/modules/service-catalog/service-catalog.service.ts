import { and, asc, eq } from 'drizzle-orm';
import { hasPermission, type Permission } from '@medicitas/auth';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext, type Transaction } from '@medicitas/db';
import { clinic, service } from '../../db/schema.ts';
import { CatalogError } from './service-catalog.errors.ts';
import { parseServiceId, parseServiceInput } from './service-catalog.schemas.ts';

export interface ServiceCatalogDeps {
  db: Database;
}

// Retains specialty for RF4 and the clinic time zone needed by ClinicCatalog.
const serviceFields = {
  serviceId: service.serviceId,
  name: service.name,
  durationMinutes: service.durationMinutes,
  specialtyId: service.specialtyId,
  isActive: service.isActive,
  timeZone: clinic.timeZone,
};

export interface ServiceDto {
  serviceId: string;
  name: string;
  durationMinutes: number;
  specialtyId: string;
  isActive: boolean;
  timeZone: string;
}

const asApp = { dbRoles: MEDICITAS_APP_ROLE } as const;
const readAsApp = { ...asApp, accessMode: 'read only' } as const;

function authorize(ctx: TenantContext, permission: Permission): void {
  if (ctx.clinicId === null || !hasPermission(ctx.role, permission)) throw new CatalogError(403);
}

async function findService(tx: Transaction, serviceId: string): Promise<ServiceDto> {
  const [row] = await tx.select(serviceFields).from(service)
    .innerJoin(clinic, eq(service.clinicId, clinic.clinicId))
    .where(eq(service.serviceId, serviceId));
  // RLS makes another clinic's ID indistinguishable from an unknown ID.
  if (!row) throw new CatalogError(404);
  return row;
}

export async function createService(deps: ServiceCatalogDeps, ctx: TenantContext, input: unknown): Promise<ServiceDto> {
  authorize(ctx, 'service:create');
  const values = parseServiceInput(input);
  return withTenantTx(deps.db, ctx, async (tx) => {
    // Only the verified context supplies clinicId. FK/UNIQUE checks are left to PG
    // and translated by @medicitas/db, avoiding racy duplicate prechecks.
    const [created] = await tx.insert(service).values({ ...values, clinicId: ctx.clinicId! })
      .returning({ serviceId: service.serviceId });
    return findService(tx, created!.serviceId);
  }, asApp);
}

export async function getService(deps: ServiceCatalogDeps, ctx: TenantContext, id: unknown): Promise<ServiceDto> {
  authorize(ctx, 'service:read');
  const serviceId = parseServiceId(id);
  return withTenantTx(deps.db, ctx, (tx) => findService(tx, serviceId), readAsApp);
}

export async function listServices(deps: ServiceCatalogDeps, ctx: TenantContext): Promise<ServiceDto[]> {
  authorize(ctx, 'service:read');
  return withTenantTx(deps.db, ctx, (tx) => tx.select(serviceFields).from(service)
    .innerJoin(clinic, eq(service.clinicId, clinic.clinicId))
    .where(eq(service.isActive, true))
    .orderBy(asc(service.name), asc(service.serviceId)), readAsApp);
}

export async function updateService(deps: ServiceCatalogDeps, ctx: TenantContext, id: unknown, input: unknown): Promise<ServiceDto> {
  authorize(ctx, 'service:update');
  const serviceId = parseServiceId(id);
  const values = parseServiceInput(input);
  return withTenantTx(deps.db, ctx, async (tx) => {
    // Retired services remain readable, but PUT cannot edit or reactivate them.
    const [updated] = await tx.update(service).set(values)
      .where(and(eq(service.serviceId, serviceId), eq(service.isActive, true)))
      .returning({ serviceId: service.serviceId });
    if (!updated) throw new CatalogError(404);
    return findService(tx, updated.serviceId);
  }, asApp);
}

export async function deleteService(deps: ServiceCatalogDeps, ctx: TenantContext, id: unknown): Promise<void> {
  authorize(ctx, 'service:delete');
  const serviceId = parseServiceId(id);
  return withTenantTx(deps.db, ctx, async (tx) => {
    // Keep the catalog row for historical/logical references. Repeating DELETE
    // for a visible service is a successful no-op, including when already inactive.
    const [deleted] = await tx.update(service).set({ isActive: false })
      .where(eq(service.serviceId, serviceId))
      .returning({ serviceId: service.serviceId });
    if (!deleted) throw new CatalogError(404);
  }, asApp);
}
