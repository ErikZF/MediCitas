import { z } from 'zod';
import { ProfessionalError } from '../modules/professionals/professionals.errors.ts';
import type { SpecialtyCatalog } from '../modules/professionals/professionals.service.ts';

const catalogResponse = z.array(z.object({ specialtyId: z.uuid(), name: z.string() }));

/** CLINICS_SERVICE_URL is a service base URL, not a tenant selector. */
export function createHttpSpecialtyCatalog(baseUrl: string | undefined): SpecialtyCatalog {
  let endpoint: URL;
  try {
    const base = new URL(baseUrl ?? '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new Error('Invalid clinics URL.');
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    endpoint = new URL('specialties', base);
  } catch {
    throw new Error('CLINICS_SERVICE_URL must be an HTTP(S) base URL without credentials, query or fragment.');
  }

  return {
    async assertExist(specialtyIds, authorization) {
      let known: Set<string>;
      try {
        const response = await fetch(endpoint, {
          headers: { authorization },
          signal: AbortSignal.timeout(5000),
          // Never forward the caller's Bearer to a redirect destination.
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Catalog request failed.');
        const parsed = catalogResponse.safeParse(await response.json());
        if (!parsed.success) throw new Error('Invalid catalog response.');
        known = new Set(parsed.data.map((entry) => entry.specialtyId.toLowerCase()));
      } catch {
        throw new ProfessionalError('catalog_unavailable');
      }
      if (specialtyIds.some((id) => !known.has(id))) throw new ProfessionalError('invalid_reference');
    },
  };
}
