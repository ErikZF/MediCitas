import { z } from 'zod';

// The existing Drizzle timestamp mapping uses JavaScript Date (millisecond precision).
// Reject finer precision instead of silently truncating a requested boundary.
const instant = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
);

/** RF21: current status of appointments starting in [from, to), as absolute instants. */
export const appointmentCountsRange = z.strictObject({
  from: instant,
  to: instant,
}).refine((range) => Date.parse(range.from) < Date.parse(range.to), { path: ['to'] });

export type AppointmentCountsRange = z.infer<typeof appointmentCountsRange>;
