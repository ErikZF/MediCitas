import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DbError, findPgError, mapPgError } from '../../src/errors.ts';
import { drizzleWrapped } from '../helpers/fake-db.ts';

describe('mapPgError', () => {
  const cases: Array<[string, number, string]> = [
    ['23P01', 409, 'overlap'],
    ['23505', 409, 'duplicate'],
    ['23503', 422, 'invalid_reference'],
    ['23502', 422, 'missing_field'],
    ['23514', 422, 'invalid_value'],
    ['22P02', 422, 'invalid_input'],
    ['22007', 422, 'invalid_input'],
    ['42501', 403, 'forbidden'],
    ['40001', 409, 'concurrency_conflict'],
    ['40P01', 409, 'concurrency_conflict'],
    ['57014', 503, 'timeout'],
    ['08006', 503, 'database_unavailable'],
    ['XX000', 500, 'database_error'],
  ];

  for (const [pgCode, status, code] of cases) {
    test(`${pgCode} → ${status} ${code}`, () => {
      const mapped = mapPgError(drizzleWrapped(pgCode));
      assert.ok(mapped instanceof DbError);
      assert.equal(mapped.status, status);
      assert.equal(mapped.code, code);
      assert.equal(mapped.pgCode, pgCode);
    });
  }

  test('known schema constraints get their own code', () => {
    assert.equal(mapPgError(drizzleWrapped('23P01', 'no_overlap_professional'))?.code, 'slot_taken');
    assert.equal(mapPgError(drizzleWrapped('23P01', 'no_overlap_patient'))?.code, 'patient_overlap');
    assert.equal(mapPgError(drizzleWrapped('23P01', 'no_overlap_working_hours'))?.code, 'schedule_overlap');
  });

  test('never exposes Postgres details in the message', () => {
    const mapped = mapPgError(drizzleWrapped('23505'));
    assert.ok(mapped);
    assert.doesNotMatch(mapped.message, /secret|Key \(/);
  });

  test('keeps the original cause for logging', () => {
    const original = drizzleWrapped('23505');
    assert.equal(mapPgError(original)?.cause, original);
  });

  test('a non-Postgres error returns null', () => {
    assert.equal(mapPgError(new Error('something else')), null);
    assert.equal(mapPgError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), null);
  });

  test('does not wrap a DbError twice', () => {
    const mapped = mapPgError(drizzleWrapped('23505'));
    assert.equal(mapPgError(mapped), mapped);
  });
});

describe('findPgError', () => {
  test('finds the driver error inside the cause chain', () => {
    assert.equal(findPgError(drizzleWrapped('40P01'))?.code, '40P01');
  });

  test('does not walk infinite cause chains', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    assert.equal(findPgError(loop), null);
  });
});
