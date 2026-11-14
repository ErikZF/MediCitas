import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hasPermission, type Permission } from '@medicitas/auth';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext, type Transaction } from '@medicitas/db';
import { appUser, professional } from '../../db/schema.ts';
import type { IdentityAdmin, Assignment } from '../../adapters/keycloak-admin.ts';
import { UserManagementError } from './user-management.errors.ts';
import { parseClinicUserRole, parseManagedUserId, parseNewClinicUser } from './user-management.schemas.ts';

export interface Management { db: Database; identity: IdentityAdmin }
export interface Actor { ctx: TenantContext; subject: string }
const options = { dbRoles: MEDICITAS_APP_ROLE, retry: false } as const;
function authorize({ctx}: Actor, permission: Permission) {
  if (!hasPermission(ctx.role, permission)) throw new UserManagementError('forbidden');
}
async function checkActor(tx: Transaction, {ctx, subject}: Actor) {
  const [row] = await tx.select({id: appUser.appUserId}).from(appUser).where(and(
    eq(appUser.appUserId, ctx.userId), eq(appUser.keycloakSub, subject), eq(appUser.roleCode, ctx.role),
    eq(appUser.isActive,true), ctx.clinicId ? eq(appUser.clinicId, ctx.clinicId) : isNull(appUser.clinicId),
  )).for('share');
  if (!row) throw new UserManagementError('identity_out_of_date');
}
export async function createClinicUser(deps: Management, actor: Actor, body: unknown) {
  authorize(actor,'user:create');
  const input = parseNewClinicUser(body);
  return provision(deps, actor, input, { clinicId: actor.ctx.clinicId!, appUserId: randomUUID(), role: input.role }, false);
}

// The router obtains both IDs and username from the clinics owner's pending registration.
export async function createFirstAdmin(deps: Management, actor: Actor, pending: { clinicId: string; appUserId: string; username: string }, password: string) {
  authorize(actor,'clinic:create');
  const input = parseNewClinicUser({username: pending.username, initialPassword: password, role:'clinic_admin'});
  return provision(deps, actor, input, {clinicId: pending.clinicId, appUserId: pending.appUserId, role:'clinic_admin'}, true);
}
async function provision(deps: Management, actor: Actor, input: {username: string; initialPassword: string}, a: Assignment, first: boolean) {
  let created: string | undefined;
  // Keep the external account disabled until SQL has committed. Never retry external calls automatically.
  const sub = await withTenantTx(deps.db, actor.ctx, async tx => {
    await checkActor(tx,actor);
    if (first) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${a.clinicId}, 0))`);
      const [existing] = await tx.select().from(appUser).where(and(eq(appUser.appUserId,a.appUserId),eq(appUser.clinicId,a.clinicId),
        eq(appUser.roleCode,'clinic_admin'),eq(appUser.isActive,true),sql`is_first_admin`)).for('update');
      if (existing) return existing.keycloakSub;
    }
    created = await deps.identity.create(input.username,input.initialPassword,a);
    await deps.identity.assign(created,a);
    await tx.execute(sql`insert into app_user (app_user_id, keycloak_sub, clinic_id, role_code, is_first_admin)
      values (${a.appUserId}, ${created}, ${a.clinicId}, ${a.role}, ${first})`);
    return created;
  }, options).catch(async error => {
    // Check a possible ambiguous COMMIT before deleting the external account.
    if (created) {
      const saved = await withTenantTx(deps.db,actor.ctx,tx => tx.select({id:appUser.appUserId}).from(appUser)
        .where(eq(appUser.appUserId,a.appUserId)), options);
      if (!saved.length) await deps.identity.remove(created);
    }
    throw error;
  });
  try {
    await enableActive(deps,actor,a,sub);
  } catch {
    // SQL committed. Give the authorized caller a stable recovery target.
    throw Object.assign(new Error('Activation not confirmed'), {
      status: 503, code: 'activation_unconfirmed', appUserId: a.appUserId,
    });
  }
  return { appUserId:a.appUserId, clinicId:a.clinicId, role:a.role };
}
async function enableActive(deps: Management, actor: Actor, a: Assignment, sub: string) {
  await withTenantTx(deps.db,actor.ctx, async tx => {
    const [current] = await tx.select().from(appUser).where(and(eq(appUser.appUserId,a.appUserId),
      eq(appUser.clinicId,a.clinicId),eq(appUser.keycloakSub,sub))).for('update');
    if (!current?.isActive || current.roleCode !== a.role) throw new UserManagementError('conflict');
    await deps.identity.enabled(sub,true);
  }, options);
}

export async function changeClinicUser(deps: Management, actor: Actor, id: unknown, change: {deactivate:true} | {roleBody:unknown}) {
  const deactivate = 'deactivate' in change;
  authorize(actor,deactivate ? 'user:deactivate' : 'user:assign-role');
  const role = 'roleBody' in change ? parseClinicUserRole(change.roleBody).role : undefined;
  const target = parseManagedUserId(id);
  const clinicId = actor.ctx.clinicId!;
  const resume = await withTenantTx(deps.db,actor.ctx,async tx => {
    await checkActor(tx,actor);
    const [row] = await tx.select().from(appUser).where(and(eq(appUser.appUserId,target),eq(appUser.clinicId,clinicId))).for('update');
    if (!row) throw new UserManagementError('not_found');
    if (role && !row.isActive) throw new UserManagementError('conflict');
    await deps.identity.enabled(row.keycloakSub,false);
    await deps.identity.logout(row.keycloakSub);
    if (!role) {
      await tx.update(appUser).set({isActive:false}).where(eq(appUser.appUserId,target));
      return;
    }
    const [profile] = role === 'professional' ? await tx.select().from(professional).where(and(
      eq(professional.appUserId,target),eq(professional.clinicId,clinicId),eq(professional.isActive,true))) : [];
    const assignment = { clinicId, appUserId:target, role, professionalId:profile?.professionalId };
    await deps.identity.assign(row.keycloakSub,assignment);
    await tx.update(appUser).set({roleCode:role}).where(eq(appUser.appUserId,target));
    return {assignment, sub:row.keycloakSub};
  }, options);
  if (resume) await enableActive(deps,actor,resume.assignment,resume.sub);
}
