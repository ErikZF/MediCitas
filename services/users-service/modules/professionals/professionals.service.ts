import { and, eq } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { appUser, professional, professionalSpecialty } from '../../db/schema.ts';
import { ProfessionalError } from './professionals.errors.ts';
import { parseProfessionalInput } from './professionals.schemas.ts';

export interface SpecialtyCatalog {
  /** The owner verifies authorization independently; no unverified tenant headers. */
  assertExist(specialtyIds: readonly string[], authorization: string): Promise<void>;
}

export interface ProfessionalDeps {
  db: Database;
  specialties: SpecialtyCatalog;
}

export interface ProfessionalDto {
  professionalId: string;
  appUserId: string;
  fullName: string;
  isActive: boolean;
  specialtyIds: string[];
}

export async function registerProfessional(
  deps: ProfessionalDeps,
  ctx: TenantContext,
  input: unknown,
  authorization: string,
): Promise<ProfessionalDto> {
  if (ctx.clinicId === null || !hasPermission(ctx.role, 'professional:create')) {
    throw new ProfessionalError('forbidden');
  }
  const values = parseProfessionalInput(input);
  // External I/O happens once, outside the locally retried transaction.
  await deps.specialties.assertExist(values.specialtyIds, authorization);

  return withTenantTx(deps.db, ctx, async (tx) => {
    // Explicit clinic predicate also excludes the app_user RLS self-read exception.
    // The lock serializes registration with local account deactivation/role changes.
    const [user] = await tx.select({ role: appUser.roleCode, active: appUser.isActive }).from(appUser)
      .where(and(eq(appUser.appUserId, values.appUserId), eq(appUser.clinicId, ctx.clinicId!)))
      .for('update');
    if (!user) throw new ProfessionalError('not_found');
    if (!user.active || user.role !== 'professional') throw new ProfessionalError('invalid_professional_user');

    const [created] = await tx.insert(professional).values({
      clinicId: ctx.clinicId!, appUserId: values.appUserId, fullName: values.fullName,
    }).returning({
      professionalId: professional.professionalId,
      appUserId: professional.appUserId,
      fullName: professional.fullName,
      isActive: professional.isActive,
    });
    await tx.insert(professionalSpecialty).values(values.specialtyIds.map((specialtyId) => ({
      professionalId: created!.professionalId, specialtyId, clinicId: ctx.clinicId!,
    })));
    return { ...created!, specialtyIds: values.specialtyIds };
  }, { dbRoles: MEDICITAS_APP_ROLE });
}
