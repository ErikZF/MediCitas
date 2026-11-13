import { z } from 'zod';
import type { TenantContext } from '@medicitas/db';
import { NotFoundError } from '../domain/errors.ts';
import type { BookableService, ClinicCatalog, PatientDirectory } from '../modules/booking/ports.ts';
import type { ProfessionalDirectory } from '../modules/schedule/schedule.service.ts';
import { getJson, serviceBaseUrl } from './service-client.ts';

// Real implementations of the ports that booking, availability and schedules use.
// Each call carries the caller's token, so the other service applies its own RLS:
// a resource of another clinic answers 404 there and 404 here.

const catalogEntry = z.object({
  serviceId: z.uuid(),
  durationMinutes: z.number().int().positive(),
  isActive: z.boolean(),
  timeZone: z.string().min(1),
});
const professional = z.object({ professionalId: z.uuid() });
const patient = z.object({ patientId: z.uuid() });

/** Ids are validated by the routes, but never trust them inside a URL path. */
const segment = (id: string) => encodeURIComponent(id);
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** clinics-service GET /services/:id. Inactive services are returned: rescheduling still needs them. */
export function createHttpClinicCatalog(baseUrl: string | undefined): ClinicCatalog {
  const base = serviceBaseUrl('CLINICS_SERVICE_URL', baseUrl);
  return {
    async getBookableService(_ctx: TenantContext, serviceId: string): Promise<BookableService> {
      const entry = await getJson(base, `services/${segment(serviceId)}`, catalogEntry, 'Service not found in this clinic.');
      if (!sameId(entry.serviceId, serviceId)) throw new NotFoundError('Service not found in this clinic.');
      return entry;
    },
  };
}

/** users-service GET /professionals/:id. */
export function createHttpProfessionalDirectory(baseUrl: string | undefined): ProfessionalDirectory {
  const base = serviceBaseUrl('USERS_SERVICE_URL', baseUrl);
  return {
    async assertInClinic(_ctx: TenantContext, professionalId: string): Promise<void> {
      const found = await getJson(base, `professionals/${segment(professionalId)}`, professional, 'Professional not found in this clinic.');
      if (!sameId(found.professionalId, professionalId)) throw new NotFoundError('Professional not found in this clinic.');
    },
  };
}

/** users-service GET /patients/:id. Only the id is read: no contact data crosses over. */
export function createHttpPatientDirectory(baseUrl: string | undefined): PatientDirectory {
  const base = serviceBaseUrl('USERS_SERVICE_URL', baseUrl);
  return {
    async assertInClinic(_ctx: TenantContext, patientId: string): Promise<void> {
      const found = await getJson(base, `patients/${segment(patientId)}`, patient, 'Patient not found in this clinic.');
      if (!sameId(found.patientId, patientId)) throw new NotFoundError('Patient not found in this clinic.');
    },
  };
}
