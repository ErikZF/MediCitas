import { z } from 'zod';

// Calendar dates in the clinic's time zone, "YYYY-MM-DD".
const localDate = z.iso.date();

/** RF7: one professional, one service, one day. */
export const professionalAvailabilityQuery = z.object({
  serviceId: z.uuid(),
  date: localDate,
});

/** RF8: every professional who offers the service, over a range of days. */
export const serviceAvailabilityQuery = z.object({
  serviceId: z.uuid(),
  from: localDate,
  to: localDate,
});

export type ProfessionalAvailabilityQuery = z.infer<typeof professionalAvailabilityQuery>;
export type ServiceAvailabilityQuery = z.infer<typeof serviceAvailabilityQuery>;
