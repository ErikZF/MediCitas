import { z } from 'zod';
import { parseLocalDate } from '../../domain/zoned-time.ts';

/** One calendar date, interpreted in the authenticated clinic's stored IANA zone. */
export const dailyAgendaQuery = z.strictObject({
  date: z.string().refine((value) => parseLocalDate(value) !== null),
});
