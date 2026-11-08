// RF5 (working hours) and RF6 (schedule blocks) of a professional.
//
// Permissions follow the matrix of the assignment: clinic_admin manages any professional
// of the clinic, a professional only their own schedule, reception and platform_admin
// cannot change it. The check here gives a clear 403; the RLS policies of
// appointments_db enforce the same rule again inside the engine.

import { and, asc, eq, gt, lt } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { lockProfessionalAgenda } from '../../db/locks.ts';
import { appointment, scheduleBlock, workingHours } from '../../db/schema.ts';
import { ForbiddenError } from '../../domain/errors.ts';
import type { BlockInput, BlockRange, WorkingHoursInput } from './schedule.schemas.ts';

/** Confirms a professional exists in the caller's clinic (owned by users-service). */
export interface ProfessionalDirectory {
  /** Throws a NotFoundError when the professional does not belong to ctx.clinicId. */
  assertInClinic(ctx: TenantContext, professionalId: string): Promise<void>;
}

export interface ScheduleDeps {
  db: Database;
  directory: ProfessionalDirectory;
}

export interface WorkingHoursDto {
  workingHoursId: string;
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface BlockDto {
  scheduleBlockId: string;
  professionalId: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface ConflictDto {
  appointmentId: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
}

const asApp = { dbRoles: MEDICITAS_APP_ROLE } as const;

function assertCanRead(ctx: TenantContext): void {
  if (ctx.role === 'platform_admin') {
    throw new ForbiddenError();
  }
}

function assertCanManage(ctx: TenantContext, professionalId: string): void {
  if (ctx.role === 'clinic_admin') return;
  if (ctx.role === 'professional' && ctx.professionalId === professionalId) return;
  throw new ForbiddenError();
}

const hhmm = (time: string) => time.slice(0, 5);

function toWorkingHoursDto(row: typeof workingHours.$inferSelect): WorkingHoursDto {
  return { workingHoursId: row.workingHoursId, weekday: row.weekday, startTime: hhmm(row.startTime), endTime: hhmm(row.endTime) };
}

function toBlockDto(row: typeof scheduleBlock.$inferSelect): BlockDto {
  return {
    scheduleBlockId: row.scheduleBlockId,
    professionalId: row.professionalId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
  };
}

export async function getWorkingHours(deps: ScheduleDeps, ctx: TenantContext, professionalId: string): Promise<WorkingHoursDto[]> {
  assertCanRead(ctx);
  return withTenantTx(deps.db, ctx, async (tx) => {
    const rows = await tx.select().from(workingHours)
      .where(eq(workingHours.professionalId, professionalId))
      .orderBy(asc(workingHours.weekday), asc(workingHours.startTime));
    return rows.map(toWorkingHoursDto);
  }, asApp);
}

/**
 * RF5: replaces the whole weekly schedule in one transaction. Several blocks per day
 * (a split shift) are allowed; overlapping blocks are rejected by the EXCLUDE
 * constraint no_overlap_working_hours (409 schedule_overlap).
 */
export async function replaceWorkingHours(
  deps: ScheduleDeps,
  ctx: TenantContext,
  professionalId: string,
  hours: WorkingHoursInput,
): Promise<WorkingHoursDto[]> {
  assertCanManage(ctx, professionalId);
  // External call before the transaction: a retried transaction must not repeat it.
  await deps.directory.assertInClinic(ctx, professionalId);

  return withTenantTx(deps.db, ctx, async (tx) => {
    await lockProfessionalAgenda(tx, professionalId, 'exclusive');
    await tx.delete(workingHours).where(eq(workingHours.professionalId, professionalId));
    if (hours.length === 0) {
      return [];
    }
    const rows = await tx.insert(workingHours)
      .values(hours.map((entry) => ({ clinicId: ctx.clinicId as string, professionalId, ...entry })))
      .returning();
    return rows
      .map(toWorkingHoursDto)
      .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
  }, asApp);
}

export async function listBlocks(
  deps: ScheduleDeps,
  ctx: TenantContext,
  professionalId: string,
  range: BlockRange,
): Promise<BlockDto[]> {
  assertCanRead(ctx);
  return withTenantTx(deps.db, ctx, async (tx) => {
    const conditions = [eq(scheduleBlock.professionalId, professionalId)];
    if (range.from !== undefined) conditions.push(gt(scheduleBlock.endsAt, new Date(range.from)));
    if (range.to !== undefined) conditions.push(lt(scheduleBlock.startsAt, new Date(range.to)));
    const rows = await tx.select().from(scheduleBlock).where(and(...conditions)).orderBy(asc(scheduleBlock.startsAt));
    return rows.map(toBlockDto);
  }, asApp);
}

/**
 * RF6: registers a block. It removes availability from now on but does not cancel
 * the appointments already booked inside it: those come back as conflicts so that
 * reception reschedules them.
 */
export async function addBlock(
  deps: ScheduleDeps,
  ctx: TenantContext,
  professionalId: string,
  input: BlockInput,
): Promise<{ block: BlockDto; conflicts: ConflictDto[] }> {
  assertCanManage(ctx, professionalId);
  await deps.directory.assertInClinic(ctx, professionalId);

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.endsAt);

  return withTenantTx(deps.db, ctx, async (tx) => {
    await lockProfessionalAgenda(tx, professionalId, 'exclusive');

    const [row] = await tx.insert(scheduleBlock)
      .values({ clinicId: ctx.clinicId as string, professionalId, startsAt, endsAt, reason: input.reason ?? null })
      .returning();

    const conflicts = await tx.select({
      appointmentId: appointment.appointmentId,
      patientId: appointment.patientId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
    }).from(appointment)
      .where(and(
        eq(appointment.professionalId, professionalId),
        eq(appointment.status, 'booked'),
        lt(appointment.startsAt, endsAt),
        gt(appointment.endsAt, startsAt),
      ))
      .orderBy(asc(appointment.startsAt));

    return {
      block: toBlockDto(row!),
      conflicts: conflicts.map((c) => ({ ...c, startsAt: c.startsAt.toISOString(), endsAt: c.endsAt.toISOString() })),
    };
  }, asApp);
}
