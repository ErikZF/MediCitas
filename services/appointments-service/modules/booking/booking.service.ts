// RF9: book an appointment. This is the operation behind the guiding question of the
// assignment: two receptionists booking the last slot at the same time.
//
// The answer does not depend on this code winning a race. Both transactions reach the
// INSERT; the EXCLUDE constraints of appointments_db (no_overlap_professional for I1,
// no_overlap_patient for I2) let exactly one commit and reject the other with 23P01,
// which @medicitas/db turns into 409 slot_taken / patient_overlap. READ COMMITTED is
// enough because the guarantee comes from the constraint, not from what each
// transaction reads.

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { lockProfessionalAgenda } from '../../db/locks.ts';
import { appointment, professionalService, scheduleBlock, workingHours } from '../../db/schema.ts';
import { freeWindows } from '../../domain/availability.ts';
import { ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import { localDateOf, parseLocalDate, weekdayOf } from '../../domain/zoned-time.ts';
import type { BookingInput } from './booking.schemas.ts';
import type { ClinicCatalog, PatientDirectory } from './ports.ts';

export interface BookingDeps {
  db: Database;
  catalog: ClinicCatalog;
  patients: PatientDirectory;
  /** Injectable clock for tests. */
  now?: () => Date;
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
}

const asApp = { dbRoles: MEDICITAS_APP_ROLE } as const;
const MINUTE_MS = 60_000;

function toAppointmentDto(row: typeof appointment.$inferSelect): AppointmentDto {
  return {
    appointmentId: row.appointmentId,
    professionalId: row.professionalId,
    patientId: row.patientId,
    serviceId: row.serviceId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    durationMinutes: row.durationMinutes,
    status: row.status,
  };
}

export async function bookAppointment(deps: BookingDeps, ctx: TenantContext, input: BookingInput): Promise<AppointmentDto> {
  if (ctx.role !== 'clinic_admin' && ctx.role !== 'receptionist') {
    throw new ForbiddenError();
  }

  const startsAt = new Date(input.startsAt);
  if (startsAt.getTime() <= (deps.now?.() ?? new Date()).getTime()) {
    throw new ValidationError('Appointments must start in the future.', 'starts_in_past');
  }

  // Other services first, outside the transaction.
  const service = await deps.catalog.getBookableService(ctx, input.serviceId);
  await deps.patients.assertInClinic(ctx, input.patientId);

  // I4: the end comes from the service, never from the request.
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * MINUTE_MS);
  const date = localDateOf(startsAt.getTime(), service.timeZone);
  const weekday = weekdayOf(parseLocalDate(date)!);

  return withTenantTx(deps.db, ctx, async (tx) => {
    // Shared: bookings run in parallel, but never alongside a schedule change (I3).
    await lockProfessionalAgenda(tx, input.professionalId, 'shared');

    const offered = await tx.select({ found: sql<number>`1` }).from(professionalService)
      .where(and(eq(professionalService.professionalId, input.professionalId), eq(professionalService.serviceId, input.serviceId)))
      .limit(1);
    if (offered.length === 0) {
      throw new ValidationError('The professional does not offer this service.', 'service_not_offered');
    }

    // I3, first half: not inside a block.
    const blocked = await tx.select({ found: sql<number>`1` }).from(scheduleBlock)
      .where(and(
        eq(scheduleBlock.professionalId, input.professionalId),
        lt(scheduleBlock.startsAt, endsAt),
        gt(scheduleBlock.endsAt, startsAt),
      ))
      .limit(1);
    if (blocked.length > 0) {
      throw new ValidationError('The professional is unavailable at that time.', 'professional_unavailable');
    }

    // I3, second half: fully inside one block of working hours, read in the clinic's time zone.
    const hours = await tx.select({ weekday: workingHours.weekday, startTime: workingHours.startTime, endTime: workingHours.endTime })
      .from(workingHours)
      .where(and(eq(workingHours.professionalId, input.professionalId), eq(workingHours.weekday, weekday)));
    const windows = freeWindows({ date, timeZone: service.timeZone, workingHours: hours, blocks: [], appointments: [] });
    if (!windows.some((w) => w.start <= startsAt.getTime() && endsAt.getTime() <= w.end)) {
      throw new ValidationError('The appointment falls outside the working hours.', 'outside_working_hours');
    }

    // I1 and I2 are decided here, by the EXCLUDE constraints, also under concurrency.
    const [row] = await tx.insert(appointment).values({
      clinicId: ctx.clinicId as string,
      professionalId: input.professionalId,
      patientId: input.patientId,
      serviceId: input.serviceId,
      startsAt,
      endsAt,
      durationMinutes: service.durationMinutes,
      status: 'booked',
      createdBy: ctx.userId,
    }).returning();

    return toAppointmentDto(row!);
  }, asApp);
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
