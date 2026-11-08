import { z } from 'zod';

// "HH:MM" or "HH:MM:00"; 24:00 marks the end of the day, as PostgreSQL TIME allows.
const timeOfDay = z.string().regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)(:00)?$/);
const minutesOf = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));

// An instant with an explicit offset, for example 2026-12-07T08:00:00-06:00.
const instant = z.iso.datetime({ offset: true });

const workingHoursEntry = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: timeOfDay,
  endTime: timeOfDay,
}).refine((entry) => minutesOf(entry.startTime) < minutesOf(entry.endTime), { path: ['endTime'] });

/** RF5: the full weekly schedule; it replaces the previous one. */
export const workingHoursBody = z.object({
  workingHours: z.array(workingHoursEntry).max(42),
});

/** RF6: a vacation or leave. */
export const blockBody = z.object({
  startsAt: instant,
  endsAt: instant,
  reason: z.string().trim().min(1).max(256).optional(),
}).refine((block) => Date.parse(block.startsAt) < Date.parse(block.endsAt), { path: ['endsAt'] });

export const blockRangeQuery = z.object({
  from: instant.optional(),
  to: instant.optional(),
}).refine((range) => range.from === undefined || range.to === undefined || Date.parse(range.from) < Date.parse(range.to), { path: ['to'] });

export type WorkingHoursInput = z.infer<typeof workingHoursBody>['workingHours'];
export type BlockInput = z.infer<typeof blockBody>;
export type BlockRange = z.infer<typeof blockRangeQuery>;
