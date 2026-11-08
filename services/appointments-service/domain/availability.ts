// Availability of a professional (RF7, RF8). Pure functions: no database, no clock,
// no I/O. The caller loads the data; this module only computes.
//
// Two steps on purpose:
//   1. freeWindows: working hours minus blocks and booked appointments, for one day.
//      This is what the Redis cache stores (card E8): it does not depend on the service.
//   2. slotsFromWindows: the bookable start times for a given service duration.
//
// All intervals are half-open, [start, end): an appointment ending at 09:30 does not
// overlap one starting at 09:30, the same rule as the EXCLUDE constraints in the database.

import {
  datesBetween,
  isValidTimeZone,
  localMidnightAsUtc,
  MINUTE_MS,
  parseLocalDate,
  weekdayOf,
  zonedToUtc,
} from './zoned-time.ts';

/** A row of working_hours: local wall-clock times of a weekday (0 = Sunday). */
export interface WorkingHours {
  weekday: number;
  /** "HH:MM" or "HH:MM:SS", as PostgreSQL returns TIME. */
  startTime: string;
  endTime: string;
}

/** A schedule_block or a booked appointment: real instants (timestamptz). */
export interface TimeRange {
  startsAt: Date | string;
  endsAt: Date | string;
}

/** Epoch milliseconds, half-open [start, end). */
export interface Interval {
  start: number;
  end: number;
}

export interface DayScheduleInput {
  /** Calendar date in the clinic's time zone, "YYYY-MM-DD". */
  date: string;
  /** IANA time zone of the clinic, for example "America/Costa_Rica". */
  timeZone: string;
  workingHours: readonly WorkingHours[];
  blocks: readonly TimeRange[];
  /** Only appointments that still occupy the agenda (status = 'booked'). */
  appointments: readonly TimeRange[];
}

export interface SlotOptions {
  /** Distance between candidate start times. Defaults to the service duration. */
  stepMinutes?: number;
  /** Slots starting before this instant are left out (for example, "now" on today's agenda). */
  notBefore?: Date;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
}

/** Invalid request data. Answered as 422 by the shared error handler. */
export class AvailabilityInputError extends Error {
  readonly status = 422;
  readonly code = 'invalid_availability_input';

  constructor(message: string) {
    super(message);
    this.name = 'AvailabilityInputError';
  }
}

const MAX_DURATION_MINUTES = 24 * 60;
export const MAX_RANGE_DAYS = 31;

function parseTimeOfDay(value: string): number {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (match === null) {
    throw new AvailabilityInputError(`Invalid time of day: "${value}".`);
  }
  const [hours, minutes, seconds] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  const total = hours * 60 + minutes;
  if (minutes > 59 || seconds !== 0 || total > 24 * 60) {
    throw new AvailabilityInputError(`Invalid time of day: "${value}".`);
  }
  return total;
}

function toMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new AvailabilityInputError('Invalid instant.');
  }
  return ms;
}

/** Sorts and joins overlapping or touching intervals. */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const current of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && current.start <= last.end) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** `available` minus `busy`. Both are merged first, so the inputs may overlap. */
export function subtractIntervals(available: readonly Interval[], busy: readonly Interval[]): Interval[] {
  const taken = mergeIntervals(busy);
  const result: Interval[] = [];
  for (const window of mergeIntervals(available)) {
    let cursor = window.start;
    for (const block of taken) {
      if (block.end <= cursor || block.start >= window.end) {
        continue;
      }
      if (block.start > cursor) {
        result.push({ start: cursor, end: block.start });
      }
      cursor = Math.max(cursor, block.end);
      if (cursor >= window.end) {
        break;
      }
    }
    if (cursor < window.end) {
      result.push({ start: cursor, end: window.end });
    }
  }
  return result;
}

/** Free windows of one professional on one day (RF7, step 1). */
export function freeWindows(input: DayScheduleInput): Interval[] {
  const date = parseLocalDate(input.date);
  if (date === null) {
    throw new AvailabilityInputError(`Invalid date: "${input.date}". Expected YYYY-MM-DD.`);
  }
  if (!isValidTimeZone(input.timeZone)) {
    throw new AvailabilityInputError(`Unknown time zone: "${input.timeZone}".`);
  }

  const weekday = weekdayOf(date);
  const midnight = localMidnightAsUtc(date);

  const working = input.workingHours
    .filter((hours) => hours.weekday === weekday)
    .map((hours) => {
      const start = parseTimeOfDay(hours.startTime);
      const end = parseTimeOfDay(hours.endTime);
      if (start >= end) {
        throw new AvailabilityInputError('Working hours must start before they end.');
      }
      return {
        start: zonedToUtc(midnight + start * MINUTE_MS, input.timeZone),
        end: zonedToUtc(midnight + end * MINUTE_MS, input.timeZone),
      };
    });

  const busy = [...input.blocks, ...input.appointments].map((range) => ({
    start: toMs(range.startsAt),
    end: toMs(range.endsAt),
  }));

  return subtractIntervals(working, busy);
}

/** Bookable slots of `durationMinutes` inside the free windows (RF7, step 2). */
export function slotsFromWindows(windows: readonly Interval[], durationMinutes: number, options: SlotOptions = {}): Slot[] {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DURATION_MINUTES) {
    throw new AvailabilityInputError('The service duration must be a whole number of minutes between 1 and 1440.');
  }
  const stepMinutes = options.stepMinutes ?? durationMinutes;
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1 || stepMinutes > MAX_DURATION_MINUTES) {
    throw new AvailabilityInputError('The step must be a whole number of minutes between 1 and 1440.');
  }

  const duration = durationMinutes * MINUTE_MS;
  const step = stepMinutes * MINUTE_MS;
  const notBefore = options.notBefore?.getTime() ?? Number.NEGATIVE_INFINITY;

  const slots: Slot[] = [];
  for (const window of mergeIntervals(windows)) {
    for (let start = window.start; start + duration <= window.end; start += step) {
      if (start >= notBefore) {
        slots.push({ startsAt: new Date(start).toISOString(), endsAt: new Date(start + duration).toISOString() });
      }
    }
  }
  return slots;
}

/** RF7: slots of one professional for one service on one day. */
export function availableSlots(input: DayScheduleInput & SlotOptions & { durationMinutes: number }): Slot[] {
  return slotsFromWindows(freeWindows(input), input.durationMinutes, input);
}

/** RF8 helper: the days of a requested range, limited to MAX_RANGE_DAYS. */
export function daysInRange(from: string, to: string): string[] {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (start === null || end === null) {
    throw new AvailabilityInputError('Dates must be YYYY-MM-DD.');
  }
  const days = datesBetween(start, end);
  if (days.length === 0) {
    throw new AvailabilityInputError('The range must end on or after its start.');
  }
  if (days.length > MAX_RANGE_DAYS) {
    throw new AvailabilityInputError(`The range cannot exceed ${MAX_RANGE_DAYS} days.`);
  }
  return days;
}
