import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { TenantContext } from '@medicitas/db';
import { afterAll, beforeAll, describe, test } from 'vitest';
import { createApp } from '../../app.ts';
import { NotFoundError } from '../../domain/errors.ts';
import type { ProfessionalDirectory } from '../../modules/schedule/schedule.service.ts';
import { createTestDatabase } from '../helpers/test-database.ts';

// RF5 and RF6 over HTTP, against the real appointments schema and its RLS policies.
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5433/appointments_db npm test -w services/appointments-service
const url = process.env.TEST_DATABASE_URL;

const CLINIC_A = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
const CLINIC_B = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
const PROF_1 = '9d3b7f1a-6c2e-4b8d-a5f0-3e1c7b9d2a03';
const PROF_2 = '3a8e5c1d-7f2b-4d9a-9c6e-5b4a2f8d1e05';
const PROF_B = '6f2a9c4e-1b7d-4e3a-8c5f-2d9e6a1b4c09';
const USER = '7c1e4b2a-9d3f-4e6a-b8c5-2a1f6d9e3b04';
const PATIENT = 'b2c4e6f8-1a3b-4c5d-8e7f-9a0b1c2d3e06';
const SERVICE = 'd4e6a8b0-3c5d-4e7f-8a9b-1c2d3e4f5a08';

const adminA: TenantContext = { clinicId: CLINIC_A, userId: USER, role: 'clinic_admin' };
const adminB: TenantContext = { clinicId: CLINIC_B, userId: USER, role: 'clinic_admin' };
const receptionA: TenantContext = { clinicId: CLINIC_A, userId: USER, role: 'receptionist' };
const platform: TenantContext = { clinicId: null, userId: USER, role: 'platform_admin' };
const professional = (professionalId: string): TenantContext => (
  { clinicId: CLINIC_A, userId: USER, role: 'professional', professionalId }
);

// Stand-in for users-service: which professionals belong to which clinic.
const directory: ProfessionalDirectory = {
  async assertInClinic(ctx, professionalId) {
    const byClinic: Record<string, string[]> = { [CLINIC_A]: [PROF_1, PROF_2], [CLINIC_B]: [PROF_B] };
    if (!(byClinic[ctx.clinicId ?? ''] ?? []).includes(professionalId)) {
      throw new NotFoundError('Professional not found in this clinic.');
    }
  },
};

const SPLIT_SHIFT = [
  { weekday: 3, startTime: '13:00', endTime: '17:00' },
  { weekday: 1, startTime: '13:00', endTime: '17:00' },
  { weekday: 1, startTime: '08:00', endTime: '12:00' },
];

describe.skipIf(!url)('schedule routes (RF5, RF6)', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: Server;
  let baseUrl: string;

  async function call(method: string, path: string, ctx?: TenantContext, body?: unknown) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (ctx !== undefined) headers['x-test-context'] = JSON.stringify(ctx);
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const hoursOf = (professionalId: string) => `/professionals/${professionalId}/working-hours`;
  const blocksOf = (professionalId: string) => `/professionals/${professionalId}/blocks`;

  beforeAll(async () => {
    database = await createTestDatabase(url as string, 'schedule');
    const app = createApp({
      resolveContext: (req) => {
        const header = req.header('x-test-context');
        return header === undefined ? null : JSON.parse(header) as TenantContext;
      },
      schedule: { db: database.db, directory },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await database?.drop();
  });

  describe('working hours (RF5)', () => {
    test('a request without identity is rejected with 401', async () => {
      assert.equal((await call('GET', hoursOf(PROF_1))).status, 401);
    });

    test('clinic_admin sets a split shift and reads it back in order', async () => {
      const put = await call('PUT', hoursOf(PROF_1), adminA, { workingHours: SPLIT_SHIFT });
      assert.equal(put.status, 200);
      const simplified = (put.body.workingHours as Array<Record<string, unknown>>)
        .map(({ weekday, startTime, endTime }) => [weekday, startTime, endTime]);
      assert.deepEqual(simplified, [[1, '08:00', '12:00'], [1, '13:00', '17:00'], [3, '13:00', '17:00']]);

      const get = await call('GET', hoursOf(PROF_1), adminA);
      assert.deepEqual(get.body.workingHours, put.body.workingHours);
    });

    test('a new schedule replaces the previous one', async () => {
      await call('PUT', hoursOf(PROF_1), adminA, { workingHours: [{ weekday: 2, startTime: '07:00', endTime: '11:00' }] });
      const get = await call('GET', hoursOf(PROF_1), adminA);
      assert.equal((get.body.workingHours as unknown[]).length, 1);
    });

    test('overlapping blocks are rejected by the engine (409) and nothing changes', async () => {
      const result = await call('PUT', hoursOf(PROF_1), adminA, {
        workingHours: [{ weekday: 4, startTime: '08:00', endTime: '12:00' }, { weekday: 4, startTime: '11:00', endTime: '14:00' }],
      });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'schedule_overlap');
      const get = await call('GET', hoursOf(PROF_1), adminA);
      assert.deepEqual((get.body.workingHours as Array<{ weekday: number }>).map((h) => h.weekday), [2]);
    });

    test('invalid entries answer 422 without touching the database', async () => {
      for (const entry of [
        { weekday: 7, startTime: '08:00', endTime: '12:00' },
        { weekday: 1, startTime: '12:00', endTime: '08:00' },
        { weekday: 1, startTime: '8am', endTime: '12:00' },
      ]) {
        const result = await call('PUT', hoursOf(PROF_1), adminA, { workingHours: [entry] });
        assert.equal(result.status, 422, JSON.stringify(entry));
        assert.equal(result.body.code, 'invalid_request');
      }
    });

    test('a malformed id or a professional of another clinic answers 404', async () => {
      assert.equal((await call('GET', hoursOf('not-a-uuid'), adminA)).status, 404);
      const foreign = await call('PUT', hoursOf(PROF_B), adminA, { workingHours: [] });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.body.code, 'not_found');
    });

    test('a professional manages only their own schedule', async () => {
      const own = await call('PUT', hoursOf(PROF_2), professional(PROF_2), { workingHours: [{ weekday: 5, startTime: '09:00', endTime: '13:00' }] });
      assert.equal(own.status, 200);
      const other = await call('PUT', hoursOf(PROF_1), professional(PROF_2), { workingHours: [] });
      assert.equal(other.status, 403);
      assert.equal(other.body.code, 'forbidden');
    });

    test('reception reads schedules but cannot change them', async () => {
      assert.equal((await call('GET', hoursOf(PROF_1), receptionA)).status, 200);
      assert.equal((await call('PUT', hoursOf(PROF_1), receptionA, { workingHours: [] })).status, 403);
    });

    test('platform_admin has no access to clinic schedules', async () => {
      assert.equal((await call('GET', hoursOf(PROF_1), platform)).status, 403);
    });

    test('another clinic sees nothing of this clinic (RLS)', async () => {
      const get = await call('GET', hoursOf(PROF_1), adminB);
      assert.equal(get.status, 200);
      assert.deepEqual(get.body.workingHours, []);
    });
  });

  describe('schedule blocks (RF6)', () => {
    beforeAll(async () => {
      await database.pool.query(`
        INSERT INTO appointment (clinic_id, professional_id, patient_id, service_id, starts_at, ends_at,
                                 duration_minutes, status, created_by) VALUES
          ('${CLINIC_A}', '${PROF_1}', '${PATIENT}', '${SERVICE}', '2026-12-21 15:00Z', '2026-12-21 15:30Z', 30, 'booked', '${USER}'),
          ('${CLINIC_A}', '${PROF_1}', '${PATIENT}', '${SERVICE}', '2026-12-22 15:00Z', '2026-12-22 15:30Z', 30, 'cancelled', '${USER}'),
          ('${CLINIC_A}', '${PROF_1}', '${PATIENT}', '${SERVICE}', '2027-01-10 15:00Z', '2027-01-10 15:30Z', 30, 'booked', '${USER}');
      `);
    });

    test('a block is stored and lists the booked appointments it overlaps as conflicts', async () => {
      const result = await call('POST', blocksOf(PROF_1), adminA, {
        startsAt: '2026-12-21T00:00:00-06:00',
        endsAt: '2027-01-04T00:00:00-06:00',
        reason: 'Vacaciones',
      });
      assert.equal(result.status, 201);
      const block = result.body.block as Record<string, unknown>;
      assert.equal(block.startsAt, '2026-12-21T06:00:00.000Z');
      assert.equal(block.reason, 'Vacaciones');
      // The cancelled appointment and the one after the block are not conflicts.
      const conflicts = result.body.conflicts as Array<{ startsAt: string }>;
      assert.deepEqual(conflicts.map((c) => c.startsAt), ['2026-12-21T15:00:00.000Z']);
    });

    test('blocks are listed by range', async () => {
      const inside = await call('GET', `${blocksOf(PROF_1)}?from=2026-12-24T00:00:00Z&to=2026-12-25T00:00:00Z`, receptionA);
      assert.equal((inside.body.blocks as unknown[]).length, 1);
      const after = await call('GET', `${blocksOf(PROF_1)}?from=2027-02-01T00:00:00Z`, receptionA);
      assert.deepEqual(after.body.blocks, []);
    });

    test('reception cannot register blocks', async () => {
      const result = await call('POST', blocksOf(PROF_1), receptionA, {
        startsAt: '2027-02-01T08:00:00-06:00', endsAt: '2027-02-01T12:00:00-06:00',
      });
      assert.equal(result.status, 403);
    });

    test('a block must end after it starts and carry an offset', async () => {
      const reversed = await call('POST', blocksOf(PROF_1), adminA, {
        startsAt: '2027-02-02T12:00:00-06:00', endsAt: '2027-02-02T08:00:00-06:00',
      });
      assert.equal(reversed.status, 422);
      const noOffset = await call('POST', blocksOf(PROF_1), adminA, {
        startsAt: '2027-02-02T08:00:00', endsAt: '2027-02-02T12:00:00',
      });
      assert.equal(noOffset.status, 422);
    });
  });
});
