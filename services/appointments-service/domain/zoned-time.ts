// Converts clinic-local wall-clock times to UTC instants using the IANA time zone of
// the clinic (clinic.time_zone). Built on Intl, so it needs no date library and
// follows daylight-saving changes.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    // Throws RangeError for an unknown time zone.
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timeZone` at `instantMs`, in milliseconds (local time minus UTC). */
export function timeZoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return localAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * Converts a wall-clock time, given as milliseconds "as if it were UTC", into the
 * real UTC instant in `timeZone`.
 *
 * Daylight-saving edges: a local time that does not exist (the hour skipped in
 * spring) moves forward by the gap; a local time that happens twice (the hour
 * repeated in autumn) resolves to one of the two instants.
 */
export function zonedToUtc(localAsUtcMs: number, timeZone: string): number {
  const firstGuess = localAsUtcMs - timeZoneOffsetMs(localAsUtcMs, timeZone);
  const offsetAtGuess = timeZoneOffsetMs(firstGuess, timeZone);
  return localAsUtcMs - offsetAtGuess;
}

/** Parses "YYYY-MM-DD" into its parts, or returns null when it is not a real calendar date. */
export function parseLocalDate(date: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** Day of the week of a calendar date: 0 = Sunday ... 6 = Saturday (same as working_hours.weekday). */
export function weekdayOf(date: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Midnight of the calendar date, as milliseconds "as if it were UTC". */
export function localMidnightAsUtc(date: { year: number; month: number; day: number }): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

/** Every "YYYY-MM-DD" from `from` to `to`, both included. */
export function datesBetween(from: { year: number; month: number; day: number }, to: { year: number; month: number; day: number }): string[] {
  const dates: string[] = [];
  for (let ms = localMidnightAsUtc(from); ms <= localMidnightAsUtc(to); ms += DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

export { DAY_MS, MINUTE_MS };
