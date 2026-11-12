// RF10-RF13: what happens to an appointment after it is booked.
//
//   booked -> rescheduled   RF10, replaced by a new appointment
//   booked -> cancelled     RF11
//   booked -> attended      RF12, once it has started
//   booked -> no_show       RF12, once it has started
//
// Every other change is refused with 409 invalid_transition (RF13). The row is read
// with FOR UPDATE first, so two concurrent changes to the same appointment queue up:
// the second one sees the new status and gets the 409. The trigger
// enforce_appointment_status_transition in appointments_db refuses the same changes
// again if some other code path ever skips this check.

import { eq } from 'drizzle-orm';
import { hasPermission, type Permission } from '@medicitas/auth';
import { withTenantTx, type TenantContext, type Transaction } from '@medicitas/db';
import { lockProfessionalAgenda } from '../../db/locks.ts';
import { appointment } from '../../db/schema.ts';
import { possibleLocalDates } from '../../cache/agenda-cache.ts';
import { ForbiddenError, NotFoundError, TransitionError, ValidationError } from '../../domain/errors.ts';
import { localDateOf } from '../../domain/zoned-time.ts';
import { asApp, toAppointmentDto, type AppointmentDto, type BookingDeps } from './booking.service.ts';
import type { CancelInput, OutcomeInput, RescheduleInput } from './lifecycle.schemas.ts';
import { assertSlotBookable, slotFor } from './slot-rules.ts';

type AppointmentRow = typeof appointment.$inferSelect;

function assertAllowed(ctx: TenantContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission)) {
    throw new ForbiddenError();
  }
}

/** Reads and locks the appointment. Another clinic's appointment is invisible (RLS): 404. */
async function lockAppointment(tx: Transaction, appointmentId: string): Promise<AppointmentRow> {
  const [row] = await tx.select().from(appointment).where(eq(appointment.appointmentId, appointmentId)).for('update');
  if (row === undefined) {
    throw new NotFoundError('Appointment not found.');
  }
  return row;
}

function assertBooked(row: AppointmentRow, next: string): void {
  if (row.status !== 'booked') {
    throw new TransitionError(`An appointment that is ${row.status} cannot become ${next}.`);
  }
}

function assertNotStarted(row: AppointmentRow, now: Date): void {
  if (row.startsAt.getTime() <= now.getTime()) {
    throw new ValidationError('The appointment has already started.', 'appointment_started');
  }
}

/**
 * RF10: in one transaction, the old appointment becomes `rescheduled` and a new one is
 * inserted with rescheduled_from_id. The old one is updated first, so it stops holding
 * its time and the new one may overlap it (moving 15 minutes later works). If the new
 * time is taken, the 409 rolls everything back and the old appointment stays booked.
 */
export async function rescheduleAppointment(
  deps: BookingDeps,
  ctx: TenantContext,
  appointmentId: string,
  input: RescheduleInput,
): Promise<AppointmentDto> {
  assertAllowed(ctx, 'appointment:reschedule');
  const now = deps.now?.() ?? new Date();

  // The service of the appointment is needed before calling clinics-service, which
  // must stay outside the transaction. The locked re-read below is the one that counts.
  const current = await withTenantTx(deps.db, ctx, async (tx) => {
    const [row] = await tx.select().from(appointment).where(eq(appointment.appointmentId, appointmentId));
    return row;
  }, asApp);
  if (current === undefined) {
    throw new NotFoundError('Appointment not found.');
  }
  const service = await deps.catalog.getBookableService(ctx, current.serviceId);
  const slot = slotFor(input.professionalId ?? current.professionalId, service, new Date(input.startsAt), now);

  const moved = await withTenantTx(deps.db, ctx, async (tx) => {
    const old = await lockAppointment(tx, appointmentId);
    assertBooked(old, 'rescheduled');
    assertNotStarted(old, now);

    // Shared agenda locks never wait on each other; the fixed order keeps it that way
    // if one of them ever becomes exclusive.
    for (const professionalId of [...new Set([old.professionalId, slot.professionalId])].sort()) {
      await lockProfessionalAgenda(tx, professionalId, 'shared');
    }
    await assertSlotBookable(tx, slot);

    await tx.update(appointment).set({ status: 'rescheduled' }).where(eq(appointment.appointmentId, old.appointmentId));
    const [row] = await tx.insert(appointment).values({
      clinicId: old.clinicId,
      professionalId: slot.professionalId,
      patientId: old.patientId,
      serviceId: old.serviceId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      durationMinutes: service.durationMinutes,
      status: 'booked',
      rescheduledFromId: old.appointmentId,
      createdBy: ctx.userId,
    }).returning();

    return toAppointmentDto(row!);
  }, asApp);

  // The old day frees a slot and the new day loses one; they may belong to two professionals.
  // professional_id and starts_at never change, so the pre-read row names the old day.
  const clinicId = ctx.clinicId as string;
  await deps.cache?.dayChanged(clinicId, current.professionalId, [localDateOf(current.startsAt.getTime(), service.timeZone)]);
  await deps.cache?.dayChanged(clinicId, slot.professionalId, [slot.date]);
  return moved;
}

/** RF11: keeps the reason and who cancelled. The time is free again at once. */
export async function cancelAppointment(
  deps: BookingDeps,
  ctx: TenantContext,
  appointmentId: string,
  input: CancelInput,
): Promise<AppointmentDto> {
  assertAllowed(ctx, 'appointment:cancel');
  const now = deps.now?.() ?? new Date();

  const cancelled = await withTenantTx(deps.db, ctx, async (tx) => {
    const row = await lockAppointment(tx, appointmentId);
    assertBooked(row, 'cancelled');
    assertNotStarted(row, now);
    const [updated] = await tx.update(appointment)
      .set({ status: 'cancelled', cancelReason: input.reason, cancelledBy: ctx.userId })
      .where(eq(appointment.appointmentId, appointmentId))
      .returning();
    return toAppointmentDto(updated!);
  }, asApp);

  await agendaChanged(deps, ctx, cancelled);
  return cancelled;
}

// The clinic's time zone is not at hand here (it lives in clinics-service), so the day
// is invalidated in every zone it could be: three calendar dates around the instant.
async function agendaChanged(deps: BookingDeps, ctx: TenantContext, changed: AppointmentDto): Promise<void> {
  await deps.cache?.dayChanged(ctx.clinicId as string, changed.professionalId, possibleLocalDates(new Date(changed.startsAt)));
}

/** RF12: attended or no_show, only once the appointment has started. */
export async function recordOutcome(
  deps: BookingDeps,
  ctx: TenantContext,
  appointmentId: string,
  input: OutcomeInput,
): Promise<AppointmentDto> {
  assertAllowed(ctx, 'appointment:record-outcome');
  const now = deps.now?.() ?? new Date();

  const recorded = await withTenantTx(deps.db, ctx, async (tx) => {
    // A professional reads the whole clinic's agenda but records only their own outcomes.
    // Checked before FOR UPDATE: RLS hides other professionals' rows from a locking read,
    // which would turn this 403 into a misleading 404. professional_id never changes.
    if (ctx.role === 'professional') {
      const [visible] = await tx.select({ professionalId: appointment.professionalId }).from(appointment)
        .where(eq(appointment.appointmentId, appointmentId));
      if (visible !== undefined && visible.professionalId !== ctx.professionalId) {
        throw new ForbiddenError();
      }
    }
    const row = await lockAppointment(tx, appointmentId);
    assertBooked(row, input.outcome);
    if (row.startsAt.getTime() > now.getTime()) {
      throw new ValidationError('The appointment has not started yet.', 'appointment_not_started');
    }
    const [updated] = await tx.update(appointment)
      .set({ status: input.outcome })
      .where(eq(appointment.appointmentId, appointmentId))
      .returning();
    return toAppointmentDto(updated!);
  }, asApp);

  // Only booked appointments hold time: an appointment still in progress frees the rest of its slot.
  await agendaChanged(deps, ctx, recorded);
  return recorded;
}
