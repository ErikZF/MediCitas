import { z } from 'zod';

/**
 * RF9. Strict on purpose: a body that tries to set endsAt or durationMinutes is
 * rejected, because the duration always comes from the service (invariant I4).
 */
export const bookingBody = z.strictObject({
  professionalId: z.uuid(),
  patientId: z.uuid(),
  serviceId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
});

export type BookingInput = z.infer<typeof bookingBody>;
