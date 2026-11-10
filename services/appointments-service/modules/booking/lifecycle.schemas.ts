import { z } from 'zod';

/** RF10. The service and the patient stay; the professional may change. */
export const rescheduleBody = z.strictObject({
  startsAt: z.iso.datetime({ offset: true }),
  professionalId: z.uuid().optional(),
});

/** RF11. */
export const cancelBody = z.strictObject({
  reason: z.string().trim().min(1).max(256),
});

/** RF12. */
export const outcomeBody = z.strictObject({
  outcome: z.enum(['attended', 'no_show']),
});

export type RescheduleInput = z.infer<typeof rescheduleBody>;
export type CancelInput = z.infer<typeof cancelBody>;
export type OutcomeInput = z.infer<typeof outcomeBody>;
