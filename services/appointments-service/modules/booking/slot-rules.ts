// Rules a new appointment must meet before the INSERT. Shared by booking (RF9) and
// rescheduling (RF10), which creates a new appointment too.
//
// I1 and I2 (no overlaps) are not checked here: the EXCLUDE constraints decide them
// at the INSERT, also under concurrency.

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Transaction } from '@medicitas/db';
import { professionalService, scheduleBlock, workingHours } from '../../db/schema.ts';
import { freeWindows } from '../../domain/availability.ts';
import { ValidationError } from '../../domain/errors.ts';
import { localDateOf, parseLocalDate, weekdayOf } from '../../domain/zoned-time.ts';
import type { BookableService } from './ports.ts';

const MINUTE_MS = 60_000;

export interface Slot {
  professionalId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  /** Calendar date and weekday of startsAt in the clinic's time zone. */
  date: string;
  weekday: number;
  timeZone: string;
}

/**
 * A retired service (soft-deleted in clinics-service) takes no new bookings and shows
 * no availability. Rescheduling an existing appointment of it is still allowed.
 */
export function assertTakesNewBookings(service: BookableService): void {
  if (service.isActive === false) {
    throw new ValidationError('The service is no longer offered.', 'service_inactive');
  }
}

/** I4: the end comes from the service, never from the request. */
export function slotFor(professionalId: string, service: BookableService, startsAt: Date, now: Date): Slot {
  if (startsAt.getTime() <= now.getTime()) {
    throw new ValidationError('Appointments must start in the future.', 'starts_in_past');
  }
  const date = localDateOf(startsAt.getTime(), service.timeZone);
  return {
    professionalId,
    serviceId: service.serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + service.durationMinutes * MINUTE_MS),
    date,
    weekday: weekdayOf(parseLocalDate(date)!),
    timeZone: service.timeZone,
  };
}

/** Service offered, no block (I3), and fully inside one block of working hours (I3). */
export async function assertSlotBookable(tx: Transaction, slot: Slot): Promise<void> {
  const offered = await tx.select({ found: sql<number>`1` }).from(professionalService)
    .where(and(eq(professionalService.professionalId, slot.professionalId), eq(professionalService.serviceId, slot.serviceId)))
    .limit(1);
  if (offered.length === 0) {
    throw new ValidationError('The professional does not offer this service.', 'service_not_offered');
  }

  const blocked = await tx.select({ found: sql<number>`1` }).from(scheduleBlock)
    .where(and(
      eq(scheduleBlock.professionalId, slot.professionalId),
      lt(scheduleBlock.startsAt, slot.endsAt),
      gt(scheduleBlock.endsAt, slot.startsAt),
    ))
    .limit(1);
  if (blocked.length > 0) {
    throw new ValidationError('The professional is unavailable at that time.', 'professional_unavailable');
  }

  const hours = await tx.select({ weekday: workingHours.weekday, startTime: workingHours.startTime, endTime: workingHours.endTime })
    .from(workingHours)
    .where(and(eq(workingHours.professionalId, slot.professionalId), eq(workingHours.weekday, slot.weekday)));
  const windows = freeWindows({ date: slot.date, timeZone: slot.timeZone, workingHours: hours, blocks: [], appointments: [] });
  if (!windows.some((w) => w.start <= slot.startsAt.getTime() && slot.endsAt.getTime() <= w.end)) {
    throw new ValidationError('The appointment falls outside the working hours.', 'outside_working_hours');
  }
}
