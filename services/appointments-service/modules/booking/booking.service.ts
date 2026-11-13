// RF9: book an appointment. This is the operation behind the guiding question of the
// assignment: two receptionists booking the last slot at the same time.
//
// The answer does not depend on this code winning a race. Both transactions reach the
// INSERT; the EXCLUDE constraints of appointments_db (no_overlap_professional for I1,
// no_overlap_patient for I2) let exactly one commit and reject the other with 23P01,
// which @medicitas/db turns into 409 slot_taken / patient_overlap. READ COMMITTED is
// enough because the guarantee comes from the constraint, not from what each
// transaction reads.

import { eq } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { lockProfessionalAgenda } from '../../db/locks.ts';
import { appointment } from '../../db/schema.ts';
import { ForbiddenError, NotFoundError } from '../../domain/errors.ts';
import type { BookingInput } from './booking.schemas.ts';
import type { AgendaCache } from '../../cache/agenda-cache.ts';
import type { ClinicCatalog, PatientDirectory } from './ports.ts';
import { assertSlotBookable, assertTakesNewBookings, slotFor } from './slot-rules.ts';

export interface BookingDeps {
  db: Database;
  catalog: ClinicCatalog;
  patients: PatientDirectory;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Invalidated after every COMMIT that changes an agenda (card E8). */
  cache?: AgendaCache;
}

export interface AppointmentDto {
  appointmentId: string;
  professionalId: string;
  patientId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  status: string;
  cancelReason: string | null;
  /** The appointment this one replaced (RF10), if any. */
  rescheduledFromId: string | null;
}

export const asApp = { dbRoles: MEDICITAS_APP_ROLE } as const;

export function toAppointmentDto(row: typeof appointment.$inferSelect): AppointmentDto {
  return {
    appointmentId: row.appointmentId,
    professionalId: row.professionalId,
    patientId: row.patientId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    status: row.status,
    cancelReason: row.cancelReason,
    rescheduledFromId: row.rescheduledFromId,
  };
}

export async function bookAppointment(deps: BookingDeps, ctx: TenantContext, input: BookingInput): Promise<AppointmentDto> {
  if (ctx.role !== 'clinic_admin' && ctx.role !== 'receptionist') {
    throw new ForbiddenError();
  }

  // Other services first, outside the transaction.
  const service = await deps.catalog.getBookableService(ctx, input.serviceId);
  assertTakesNewBookings(service);
  const slot = slotFor(input.professionalId, service, new Date(input.startsAt), deps.now?.() ?? new Date());
  await deps.patients.assertInClinic(ctx, input.patientId);

  const booked = await withTenantTx(deps.db, ctx, async (tx) => {
    // Shared: bookings run in parallel, but never alongside a schedule change (I3).
    await lockProfessionalAgenda(tx, input.professionalId, 'shared');
    await assertSlotBookable(tx, slot);

    // I1 and I2 are decided here, by the EXCLUDE constraints, also under concurrency.
    const [row] = await tx.insert(appointment).values({
      clinicId: ctx.clinicId as string,
      professionalId: input.professionalId,
      patientId: input.patientId,
      serviceId: input.serviceId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      durationMinutes: service.durationMinutes,
      status: 'booked',
      createdBy: ctx.userId,
    }).returning();

    return toAppointmentDto(row!);
  }, asApp);

  // After the COMMIT and before answering 201: from here on, no reader gets the old day (I8).
  await deps.cache?.dayChanged(ctx.clinicId as string, input.professionalId, [slot.date]);
  return booked;
}

export async function getAppointment(deps: Pick<BookingDeps, 'db'>, ctx: TenantContext, appointmentId: string): Promise<AppointmentDto> {
  if (ctx.role === 'platform_admin') {
    throw new ForbiddenError();
  }
  const row = await withTenantTx(deps.db, ctx, async (tx) => {
    const [found] = await tx.select().from(appointment).where(eq(appointment.appointmentId, appointmentId)).limit(1);
    return found;
  }, asApp);
  // Another clinic's appointment is invisible through RLS: same answer as one that does not exist.
  if (row === undefined) {
    throw new NotFoundError('Appointment not found.');
  }
  return toAppointmentDto(row);
}
