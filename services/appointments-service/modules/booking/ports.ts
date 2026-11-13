import type { TenantContext } from '@medicitas/db';

// Data owned by other services that a booking needs. They are called before the
// transaction starts, so a retried transaction never repeats them.

export interface BookableService {
  serviceId: string;
  /** Duration of the service; it fixes ends_at (invariant I4). */
  durationMinutes: number;
  /** IANA time zone of the clinic, to read working hours in local time. */
  timeZone: string;
  /** Retired services (soft delete in clinics-service) take no new bookings. Missing means active. */
  isActive?: boolean;
}

/** clinics-service: the service catalog and the clinic's time zone. */
export interface ClinicCatalog {
  /** Throws a NotFoundError when the service does not belong to ctx.clinicId. */
  getBookableService(ctx: TenantContext, serviceId: string): Promise<BookableService>;
}

/** users-service: the clinic's patients. */
export interface PatientDirectory {
  /** Throws a NotFoundError when the patient does not belong to ctx.clinicId. */
  assertInClinic(ctx: TenantContext, patientId: string): Promise<void>;
}
