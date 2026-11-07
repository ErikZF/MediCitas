import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DbError } from '../../src/errors.ts';
import { InvalidTenantContextError, type TenantContext } from '../../src/context.ts';
import { withTenantTx } from '../../src/tenant-tx.ts';
import { CLINIC_A, drizzleWrapped, fakeDb } from '../helpers/fake-db.ts';

const receptionist: TenantContext = { clinicId: CLINIC_A, userSub: 'kc-sub-recepcion-a', role: 'receptionist' };
const noWait = { sleep: async () => {}, random: () => 0 };

describe('withTenantTx: transaction setup', () => {
  test('sets READ COMMITTED explicitly', async () => {
    const { db, configs } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok');
    assert.deepEqual(configs, [{ isolationLevel: 'read committed', accessMode: undefined }]);
  });

  test('allows another level when a use case needs it', async () => {
    const { db, configs } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok', { isolationLevel: 'serializable', accessMode: 'read only' });
    assert.deepEqual(configs, [{ isolationLevel: 'serializable', accessMode: 'read only' }]);
  });

  test('passes clinic, user and role as transaction-local parameters', async () => {
    const { db, attempts } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok');
    const [first] = attempts[0];
    assert.match(first.sql, /set_config\('app\.clinic_id', \$1, true\)/);
    assert.match(first.sql, /set_config\('app\.user_sub', \$2, true\)/);
    assert.match(first.sql, /set_config\('app\.role', \$3, true\)/);
    assert.deepEqual(first.params, [CLINIC_A, 'kc-sub-recepcion-a', 'receptionist']);
  });

  test('platform_admin gets no clinic', async () => {
    const { db, attempts } = fakeDb();
    await withTenantTx(db, { clinicId: null, userSub: 'kc-sub-plataforma', role: 'platform_admin' }, async () => 'ok');
    assert.equal(attempts[0][0].params[0], '');
  });

  test('switches to the actor database role with SET LOCAL ROLE and a quoted name', async () => {
    const { db, attempts } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok', { dbRoles: { receptionist: 'db_receptionist' } });
    assert.equal(attempts[0].at(-1)?.sql, 'set local role "db_receptionist"');
  });

  test('without a role map the role is not changed', async () => {
    const { db, attempts } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok');
    assert.equal(attempts[0].some((q) => q.sql.includes('role "')), false);
  });

  test('applies statement_timeout only inside the transaction', async () => {
    const { db, attempts } = fakeDb();
    await withTenantTx(db, receptionist, async () => 'ok', { statementTimeoutMs: 1500 });
    const timeout = attempts[0].find((q) => q.sql.includes('statement_timeout'));
    assert.ok(timeout);
    assert.match(timeout.sql, /set_config\('statement_timeout', \$1, true\)/);
    assert.deepEqual(timeout.params, ['1500ms']);
  });
});

describe('withTenantTx: fails closed before touching the database', () => {
  test('rejects a clinic that is not a UUID', async () => {
    const { db, configs } = fakeDb();
    await assert.rejects(
      withTenantTx(db, { ...receptionist, clinicId: "' OR 1=1 --" }, async () => 'ok'),
      InvalidTenantContextError,
    );
    assert.equal(configs.length, 0);
  });

  test('rejects a role missing from the database role map', async () => {
    const { db, configs } = fakeDb();
    await assert.rejects(
      withTenantTx(db, receptionist, async () => 'ok', { dbRoles: { clinic_admin: 'db_clinic_admin' } }),
      InvalidTenantContextError,
    );
    assert.equal(configs.length, 0);
  });

  test('rejects database role names that are not plain identifiers', async () => {
    const { db } = fakeDb();
    await assert.rejects(
      withTenantTx(db, receptionist, async () => 'ok', { dbRoles: { receptionist: 'postgres"; drop table x; --' } }),
      InvalidTenantContextError,
    );
  });

  test('platform_admin cannot carry a clinic and every other role must', async () => {
    const { db } = fakeDb();
    await assert.rejects(withTenantTx(db, { clinicId: CLINIC_A, userSub: 's', role: 'platform_admin' }, async () => 1));
    await assert.rejects(withTenantTx(db, { clinicId: null, userSub: 's', role: 'professional' }, async () => 1));
  });
});

describe('withTenantTx: errors and retries', () => {
  test('reruns the whole transaction after a deadlock and then returns', async () => {
    const { db, attempts } = fakeDb();
    let calls = 0;
    const result = await withTenantTx(db, receptionist, async () => {
      calls += 1;
      if (calls === 1) throw drizzleWrapped('40P01');
      return 'reservada';
    }, { retry: noWait });
    assert.equal(result, 'reservada');
    assert.equal(attempts.length, 2);
    // The second attempt sets the context again: nothing carries over from the first.
    assert.match(attempts[1][0].sql, /app\.clinic_id/);
  });

  test('stops after 3 attempts and responds 409', async () => {
    const { db, attempts } = fakeDb();
    const error = await withTenantTx(db, receptionist, async () => {
      throw drizzleWrapped('40001');
    }, { retry: noWait }).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'concurrency_conflict');
    assert.equal(attempts.length, 3);
  });

  test('does not retry a taken slot and maps it to 409 slot_taken', async () => {
    const { db, attempts } = fakeDb();
    const error = await withTenantTx(db, receptionist, async () => {
      throw drizzleWrapped('23P01', 'no_overlap_professional');
    }, { retry: noWait }).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'slot_taken');
    assert.equal(attempts.length, 1);
  });

  test('each service can give meaning to its own constraints', async () => {
    const { db } = fakeDb();
    const error = await withTenantTx(db, receptionist, async () => {
      throw drizzleWrapped('23505', 'patient_clinic_id_identification_key');
    }, {
      constraintErrors: {
        patient_clinic_id_identification_key: { status: 409, code: 'patient_exists', message: 'El paciente ya está registrado.' },
      },
    }).catch((e: unknown) => e);
    assert.ok(error instanceof DbError);
    assert.equal(error.code, 'patient_exists');
  });

  test('domain errors pass through unchanged', async () => {
    const { db } = fakeDb();
    class OutsideWorkingHours extends Error {}
    await assert.rejects(
      withTenantTx(db, receptionist, async () => { throw new OutsideWorkingHours('fuera de horario'); }),
      OutsideWorkingHours,
    );
  });
});
