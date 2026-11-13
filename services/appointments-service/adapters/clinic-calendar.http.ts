import { z } from 'zod';
import { isValidTimeZone } from '../domain/zoned-time.ts';
import { ClinicUnavailableError, type ClinicCalendar } from '../modules/daily-agenda/daily-agenda.service.ts';

const settings = z.strictObject({ clinicId: z.uuid(), timeZone: z.string().refine(isValidTimeZone) });

export function createHttpClinicCalendar(baseUrl: string | undefined): ClinicCalendar {
  let endpoint: URL;
  try {
    const base = new URL(baseUrl ?? '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('Invalid URL.');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    endpoint = new URL('clinic/time-zone', base);
  } catch {
    throw new Error('CLINICS_SERVICE_URL must be an HTTP(S) base URL without credentials, query or fragment.');
  }
  return {
    async getTimeZone(ctx, authorization) {
      try {
        const response = await fetch(endpoint, {
          headers: { authorization }, redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('Clinic request failed.');
        const parsed = settings.parse(await response.json());
        if (parsed.clinicId.toLowerCase() !== ctx.clinicId?.toLowerCase()) throw new Error('Clinic mismatch.');
        return parsed.timeZone;
      } catch {
        throw new ClinicUnavailableError();
      }
    },
  };
}
