import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { TenantContext } from '@medicitas/db';
import { createApp } from '../../app.ts';
import { NotFoundError } from '../../domain/errors.ts';
import type { ClinicCatalog, PatientDirectory } from '../../modules/booking/ports.ts';
import { createTestDatabase } from './test-database.ts';

// A running appointments-service on a throwaway database, with clinics-service and
// users-service replaced by in-memory stand-ins.

export const CLINIC_A = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
export const CLINIC_B = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
export const PROF_1 = '9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03';
export const PROF_2 = '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05';
export const USER = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
export const SERVICE_30 = 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';
export const SERVICE_OTHER = 'e5f7b9c1-4d6e-4f8a-9b0c-2d3e4f5a6b0a';
export const SPECIALTY = 'f6a8c0d2-5e7f-4a9b-8c1d-3e4f5a6b7c0b';

export const receptionA: TenantContext = { clinicId: CLINIC_A, userId: USER, role: 'receptionist' };
export const adminA: TenantContext = { clinicId: CLINIC_A, userId: USER, role: 'clinic_admin' };
export const receptionB: TenantContext = { clinicId: CLINIC_B, userId: USER, role: 'receptionist' };

/** Deterministic patient ids: patient(1), patient(2), ... */
export function patient(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export interface BookingApp {
  pool: Awaited<ReturnType<typeof createTestDatabase>>['pool'];
  call(method: string, path: string, ctx?: TenantContext, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/**
 * Seeds PROF_1 and PROF_2 in clinic A, both offering SERVICE_30 (30 minutes), with the
 * working hours given (local time in `timeZone`). SERVICE_OTHER exists but nobody offers it.
 */
export async function startBookingApp(options: {
  adminUrl: string;
  label: string;
  timeZone: string;
  workingHours: Array<{ weekday: number; startTime: string; endTime: string }>;
  maxConnections?: number;
  now?: Date;
}): Promise<BookingApp> {
  const database = await createTestDatabase(options.adminUrl, options.label, options.maxConnections ?? 4);

  for (const professionalId of [PROF_1, PROF_2]) {
    await database.pool.query(
      `INSERT INTO professional_service (professional_id, service_id, clinic_id, specialty_id) VALUES ($1, $2, $3, $4)`,
      [professionalId, SERVICE_30, CLINIC_A, SPECIALTY],
    );
    for (const hours of options.workingHours) {
      await database.pool.query(
        `INSERT INTO working_hours (clinic_id, professional_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4, $5)`,
        [CLINIC_A, professionalId, hours.weekday, hours.startTime, hours.endTime],
      );
    }
  }

  const catalog: ClinicCatalog = {
    async getBookableService(ctx, serviceId) {
      if (ctx.clinicId !== CLINIC_A || (serviceId !== SERVICE_30 && serviceId !== SERVICE_OTHER)) {
        throw new NotFoundError('Service not found in this clinic.');
      }
      return { serviceId, durationMinutes: 30, timeZone: options.timeZone };
    },
  };
  const patients: PatientDirectory = {
    async assertInClinic(ctx, patientId) {
      if (ctx.clinicId !== CLINIC_A || !patientId.startsWith('00000000-0000-4000-8000-')) {
        throw new NotFoundError('Patient not found in this clinic.');
      }
    },
  };

  const app = createApp({
    resolveContext: (req) => {
      const header = req.header('x-test-context');
      return header === undefined ? null : JSON.parse(header) as TenantContext;
    },
    booking: { db: database.db, catalog, patients, now: () => options.now ?? new Date('2026-01-01T00:00:00Z') },
  });
  const server: Server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    pool: database.pool,
    async call(method, path, ctx, body) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (ctx !== undefined) headers['x-test-context'] = JSON.stringify(ctx);
      const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await database.drop();
    },
  };
}
