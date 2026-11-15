import { and, asc, eq } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import { MEDICITAS_DB_ROLES, withTenantTx, type Database, type TenantContext, type Transaction } from '@medicitas/db';
import { appUser, professional, professionalSpecialty } from '../../db/schema.ts';
import { ProfessionalError } from './professionals.errors.ts';
import { parseProfessionalId, parseProfessionalInput } from './professionals.schemas.ts';
import { checkActor, type Actor } from '../user-management/user-management.service.ts';

export interface SpecialtyCatalog {
  /** The owner verifies authorization independently; no unverified tenant headers. */
  assertExist(specialtyIds: readonly string[], authorization: string): Promise<void>;
}

export interface ProfessionalDeps {
  db: Database;
  specialties: SpecialtyCatalog;
  syncProfessionalId(sub: string, clinicId: string, appUserId: string, professionalId: string): Promise<boolean>;
}

export interface ProfessionalDto {
  professionalId: string;
  appUserId: string;
  fullName: string;
  isActive: boolean;
  specialtyIds: string[];
}

async function specialtyIdsOf(tx: Transaction, clinicId: string, professionalId: string) {
  const rows = await tx.select({ id: professionalSpecialty.specialtyId }).from(professionalSpecialty)
    .where(and(eq(professionalSpecialty.clinicId, clinicId), eq(professionalSpecialty.professionalId, professionalId)))
    .orderBy(asc(professionalSpecialty.specialtyId));
  return rows.map(({ id }) => id);
}

export async function getProfessional(deps: ProfessionalDeps, ctx: TenantContext, id: unknown) {
  if (!ctx.clinicId || !hasPermission(ctx.role, 'schedule:read')) throw new ProfessionalError('forbidden');
  const clinicId = ctx.clinicId;
  const professionalId = parseProfessionalId(id);
  return withTenantTx(deps.db, ctx, async (tx) => {
    const [row] = await tx.select({ professionalId: professional.professionalId }).from(professional)
      .innerJoin(appUser, and(eq(appUser.appUserId, professional.appUserId), eq(appUser.clinicId, clinicId)))
      .where(and(eq(professional.professionalId, professionalId), eq(professional.clinicId, clinicId),
        eq(professional.isActive, true), eq(appUser.isActive, true), eq(appUser.roleCode, 'professional')));
    if (!row) throw new ProfessionalError('not_found');
    if (!hasPermission(ctx.role, 'professional:create')) return row;
    return { ...row, specialtyIds: await specialtyIdsOf(tx, clinicId, professionalId) };
  }, { dbRoles: MEDICITAS_DB_ROLES, accessMode: 'read only' });
}

export async function registerProfessional(
  deps: ProfessionalDeps,
  actor: Actor,
  input: unknown,
  authorization: string,
) {
  const { ctx } = actor;
  if (ctx.clinicId === null || !hasPermission(ctx.role, 'professional:create')) {
    throw new ProfessionalError('forbidden');
  }
  const values = parseProfessionalInput(input);
  // External I/O happens once, outside the locally retried transaction.
  await deps.specialties.assertExist(values.specialtyIds, authorization);

  const clinicId = ctx.clinicId;
  const target = and(eq(appUser.appUserId, values.appUserId), eq(appUser.clinicId, clinicId));
  const profile = await withTenantTx(deps.db, ctx, async (tx) => {
    await checkActor(tx, actor);
    // Explicit clinic predicate also excludes the app_user RLS self-read exception.
    // The lock serializes registration with local account deactivation/role changes.
    const [user] = await tx.select({ role: appUser.roleCode, active: appUser.isActive }).from(appUser)
      .where(target)
      .for('update');
    if (!user) throw new ProfessionalError('not_found');
    if (!user.active || user.role !== 'professional') throw new ProfessionalError('invalid_professional_user');

    const [created] = await tx.insert(professional).values({
      clinicId, appUserId: values.appUserId, fullName: values.fullName,
    }).onConflictDoNothing({ target: [professional.clinicId, professional.appUserId] })
      .returning({ professionalId: professional.professionalId });
    if (!created) {
      // Only an identical registration may finish a previously interrupted claim update.
      const [existing] = await tx.select().from(professional).where(and(
        eq(professional.clinicId, clinicId), eq(professional.appUserId, values.appUserId),
      ));
      if (!existing?.isActive || existing.fullName !== values.fullName) throw new ProfessionalError('duplicate');
      const ids = await specialtyIdsOf(tx, clinicId, existing.professionalId);
      if (ids.length !== values.specialtyIds.length || ids.some((id, i) => id !== values.specialtyIds[i])) {
        throw new ProfessionalError('duplicate');
      }
      return { professionalId: existing.professionalId, created: false };
    }
    await tx.insert(professionalSpecialty).values(values.specialtyIds.map((specialtyId) => ({
      professionalId: created.professionalId, specialtyId, clinicId,
    })));
    return { professionalId: created.professionalId, created: true };
  }, { dbRoles: MEDICITAS_DB_ROLES });

  // Publish only a committed ID. Serialize with RF2 role changes, without retrying external I/O.
  const updated = await withTenantTx(deps.db, ctx, async (tx) => {
    await checkActor(tx, actor);
    const [user] = await tx.select().from(appUser).where(target).for('update');
    if (!user?.isActive || user.roleCode !== 'professional') throw new ProfessionalError('invalid_professional_user');
    return deps.syncProfessionalId(user.keycloakSub, clinicId, values.appUserId, profile.professionalId);
  }, { dbRoles: MEDICITAS_DB_ROLES, retry: false });
  if (!profile.created && !updated) throw new ProfessionalError('duplicate');
  const dto: ProfessionalDto = { ...values, professionalId: profile.professionalId, isActive: true };
  return { dto, status: profile.created ? 201 : 200 };
}
