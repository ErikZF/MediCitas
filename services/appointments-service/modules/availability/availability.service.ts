// RF7 and RF8: free slots of a service. Read-only.
//
// The answer is a snapshot, not a reservation: a slot listed here can be taken a
// moment later. Booking (RF9) checks everything again and the EXCLUDE constraints
// have the last word, so availability never needs a lock.
//
// Two steps, as in domain/availability.ts:
//   1. resolveWindows: working hours minus blocks and booked appointments, per
//      professional and day. It does not depend on the service, so it is what the Redis
//      cache holds (card E8): looked up first, read from PostgreSQL only on a miss.
//   2. slotsFromWindows: the start times that fit the service duration.

import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext, type Transaction } from '@medicitas/db';
import { appointment, professionalService, scheduleBlock, workingHours } from '../../db/schema.ts';
import { daysInRange, freeWindows, slotsFromWindows, type Interval, type Slot } from '../../domain/availability.ts';
import { ForbiddenError, ValidationError } from '../../domain/errors.ts';
import { DAY_MS, localMidnightAsUtc, parseLocalDate, zonedToUtc } from '../../domain/zoned-time.ts';
import type { ClinicCatalog } from '../booking/ports.ts';
import type { AgendaCache } from '../../cache/agenda-cache.ts';
import type { ProfessionalDirectory } from '../schedule/schedule.service.ts';
import type { ProfessionalAvailabilityQuery, ServiceAvailabilityQuery } from './availability.schemas.ts';

export interface AvailabilityDeps {
  db: Database;
  catalog: ClinicCatalog;
  directory: ProfessionalDirectory;
  /** Injectable clock for tests: slots that already started are left out. */
  now?: () => Date;
  /** Without it every read goes to PostgreSQL (CACHE_ENABLED=false). */
  cache?: AgendaCache;
}

export interface DaySlotsDto {
  date: string;
  slots: Slot[];
}

export interface ProfessionalAvailabilityDto {
  professionalId: string;
  serviceId: string;
  durationMinutes: number;
  timeZone: string;
  date: string;
  slots: Slot[];
}

export interface ServiceAvailabilityDto {
  serviceId: string;
  durationMinutes: number;
  timeZone: string;
  from: string;
  to: string;
  /** Only professionals with at least one free slot; each lists only the days that have one. */
  professionals: Array<{ professionalId: string; days: DaySlotsDto[] }>;
}

const asApp = { dbRoles: MEDICITAS_APP_ROLE } as const;

/** professionalId -> date -> free windows. */
type FreeWindowsByDay = Map<string, Map<string, Interval[]>>;

function assertCanRead(ctx: TenantContext): void {
  if (ctx.role === 'platform_admin') {
    throw new ForbiddenError();
  }
}

/** [start of the first day, end of the last day) as real instants in the clinic's zone. */
function rangeOf(days: readonly string[], timeZone: string): { start: Date; end: Date } {
  const first = localMidnightAsUtc(parseLocalDate(days[0]!)!);
  const last = localMidnightAsUtc(parseLocalDate(days.at(-1)!)!);
  return { start: new Date(zonedToUtc(first, timeZone)), end: new Date(zonedToUtc(last + DAY_MS, timeZone)) };
}

async function loadFreeWindows(
  tx: Transaction,
  professionalIds: readonly string[],
  days: readonly string[],
  timeZone: string,
): Promise<FreeWindowsByDay> {
  const ids = [...professionalIds];
  const range = rangeOf(days, timeZone);

  const hours = await tx.select({
    professionalId: workingHours.professionalId,
    weekday: workingHours.weekday,
    startTime: workingHours.startTime,
    endTime: workingHours.endTime,
  }).from(workingHours).where(inArray(workingHours.professionalId, ids));

  const blocks = await tx.select({
    professionalId: scheduleBlock.professionalId,
    startsAt: scheduleBlock.startsAt,
    endsAt: scheduleBlock.endsAt,
  }).from(scheduleBlock).where(and(
    inArray(scheduleBlock.professionalId, ids),
    lt(scheduleBlock.startsAt, range.end),
    gt(scheduleBlock.endsAt, range.start),
  ));

  // Only appointments that still hold their time: cancelled or rescheduled ones free it.
  const booked = await tx.select({
    professionalId: appointment.professionalId,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
  }).from(appointment).where(and(
    inArray(appointment.professionalId, ids),
    eq(appointment.status, 'booked'),
    lt(appointment.startsAt, range.end),
    gt(appointment.endsAt, range.start),
  ));

  const result: FreeWindowsByDay = new Map();
  for (const professionalId of ids) {
    const own = <T extends { professionalId: string }>(rows: T[]) => rows.filter((row) => row.professionalId === professionalId);
    const byDay = new Map<string, Interval[]>();
    for (const date of days) {
      byDay.set(date, freeWindows({ date, timeZone, workingHours: own(hours), blocks: own(blocks), appointments: own(booked) }));
    }
    result.set(professionalId, byDay);
  }
  return result;
}

/**
 * Free windows for every professional and day: from the cache when it has them, from
 * PostgreSQL otherwise, and the cache is filled afterwards. Redis is only touched
 * outside the transaction. `checks` runs in the same transaction as the reads.
 */
async function resolveWindows(
  deps: AvailabilityDeps,
  ctx: TenantContext,
  professionalIds: readonly string[],
  days: readonly string[],
  timeZone: string,
  checks?: (tx: Transaction) => Promise<void>,
): Promise<FreeWindowsByDay> {
  const clinicId = ctx.clinicId as string;
  // The cache counters are read here, BEFORE PostgreSQL (see cache/agenda-cache.ts).
  const lookup = deps.cache
    ? await deps.cache.lookup(clinicId, professionalIds, days)
    : { hits: [], misses: professionalIds.flatMap((professionalId) => days.map((date) => ({ professionalId, date, key: null }))) };

  let loaded: FreeWindowsByDay = new Map();
  if (checks || lookup.misses.length > 0) {
    loaded = await withTenantTx(deps.db, ctx, async (tx) => {
      if (checks) await checks(tx);
      if (lookup.misses.length === 0) return new Map() as FreeWindowsByDay;
      const ids = [...new Set(lookup.misses.map((m) => m.professionalId))];
      const missingDays = [...new Set(lookup.misses.map((m) => m.date))].sort();
      return loadFreeWindows(tx, ids, missingDays, timeZone);
    }, asApp);
  }

  const result: FreeWindowsByDay = new Map(professionalIds.map((id) => [id, new Map()]));
  for (const hit of lookup.hits) result.get(hit.professionalId)!.set(hit.date, hit.windows);
  const toFill: Array<{ key: string; windows: Interval[] }> = [];
  for (const miss of lookup.misses) {
    const windows = loaded.get(miss.professionalId)!.get(miss.date)!;
    result.get(miss.professionalId)!.set(miss.date, windows);
    if (miss.key !== null) toFill.push({ key: miss.key, windows });
  }
  if (deps.cache) await deps.cache.fill(toFill);
  return result;
}

/** RF7: the slots of one professional for one service on one day. */
export async function getProfessionalAvailability(
  deps: AvailabilityDeps,
  ctx: TenantContext,
  professionalId: string,
  query: ProfessionalAvailabilityQuery,
): Promise<ProfessionalAvailabilityDto> {
  assertCanRead(ctx);
  // Other services first, outside the transaction.
  await deps.directory.assertInClinic(ctx, professionalId);
  const service = await deps.catalog.getBookableService(ctx, query.serviceId);
  const days = daysInRange(query.date, query.date);

  const windows = await resolveWindows(deps, ctx, [professionalId], days, service.timeZone, async (tx) => {
    const offered = await tx.select({ professionalId: professionalService.professionalId }).from(professionalService)
      .where(and(eq(professionalService.professionalId, professionalId), eq(professionalService.serviceId, query.serviceId)))
      .limit(1);
    if (offered.length === 0) {
      throw new ValidationError('The professional does not offer this service.', 'service_not_offered');
    }
  });

  return {
    professionalId,
    serviceId: query.serviceId,
    durationMinutes: service.durationMinutes,
    timeZone: service.timeZone,
    date: query.date,
    slots: slotsFromWindows(windows.get(professionalId)!.get(query.date)!, service.durationMinutes, { notBefore: deps.now?.() ?? new Date() }),
  };
}

/** RF8: for a service and a range of days, the professionals with room and their slots. */
export async function getServiceAvailability(
  deps: AvailabilityDeps,
  ctx: TenantContext,
  query: ServiceAvailabilityQuery,
): Promise<ServiceAvailabilityDto> {
  assertCanRead(ctx);
  const days = daysInRange(query.from, query.to);
  const service = await deps.catalog.getBookableService(ctx, query.serviceId);

  const offering = await withTenantTx(deps.db, ctx, (tx) => tx.select({ professionalId: professionalService.professionalId })
    .from(professionalService)
    .where(eq(professionalService.serviceId, query.serviceId)), asApp);
  const windows = offering.length === 0
    ? new Map() as FreeWindowsByDay
    : await resolveWindows(deps, ctx, offering.map((row) => row.professionalId), days, service.timeZone);

  const notBefore = deps.now?.() ?? new Date();
  const professionals: ServiceAvailabilityDto['professionals'] = [];
  for (const [professionalId, byDay] of [...windows].sort(([a], [b]) => a.localeCompare(b))) {
    const withRoom = days
      .map((date) => ({ date, slots: slotsFromWindows(byDay.get(date)!, service.durationMinutes, { notBefore }) }))
      .filter((day) => day.slots.length > 0);
    if (withRoom.length > 0) {
      professionals.push({ professionalId, days: withRoom });
    }
  }

  return {
    serviceId: query.serviceId,
    durationMinutes: service.durationMinutes,
    timeZone: service.timeZone,
    from: query.from,
    to: query.to,
    professionals,
  };
}
