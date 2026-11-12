import assert from 'node:assert/strict';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { describe, test, vi } from 'vitest';
import { InvalidTenantContextError, type Database, type TenantContext } from '@medicitas/db';
import { ForbiddenError, ValidationError } from '../../domain/errors.ts';
import { getPatientAppointmentHistory } from '../../modules/patient-history/patient-history.service.ts';

const ctx: TenantContext = {
  clinicId: '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01',
  userId: '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04',
  role: 'clinic_admin',
};
const patientId = 'b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06';

// Only the driver is a stub. Any BEGIN or other database access is recorded;
// these tests prove early rejection, not PostgreSQL isolation or RLS.
function recordingDatabase() {
  const query = vi.fn(async () => ({ rows: [] }));
  const db = drizzle({ client: { query } as unknown as pg.Client }) as Database;
  return { db, query };
}

describe('RF16 rejects unauthorized or invalid calls before database access', () => {
  test('denies platform_admin, which has no appointment:read permission', async () => {
    const { db, query } = recordingDatabase();
    await assert.rejects(getPatientAppointmentHistory({ db }, {
      ...ctx, clinicId: null, role: 'platform_admin',
    }, patientId), ForbiddenError);
    assert.equal(query.mock.calls.length, 0);
  });

  test('validates the trusted context and accepts only a patient UUID as input', async () => {
    const { db, query } = recordingDatabase();
    for (const invalidContext of [
      { ...ctx, clinicId: null },
      { ...ctx, userId: 'invalid' },
      { ...ctx, role: 'professional' as const }, // Missing the trusted professional id.
    ]) {
      await assert.rejects(getPatientAppointmentHistory({ db }, invalidContext, patientId), InvalidTenantContextError);
    }
    for (const invalidId of ['invalid', `${patientId}' OR true --`, { patientId, clinicId: ctx.clinicId }]) {
      await assert.rejects(getPatientAppointmentHistory({ db }, ctx, invalidId), ValidationError);
    }
    assert.equal(query.mock.calls.length, 0);
  });
});
