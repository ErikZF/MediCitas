import { z } from 'zod';

/** RF15. The body only carries the text: the appointment, professional and clinic come from the URL and the token. */
export const clinicalNoteBody = z.strictObject({
  content: z.string().trim().min(1).max(20_000),
});

export type ClinicalNoteInput = z.infer<typeof clinicalNoteBody>;
