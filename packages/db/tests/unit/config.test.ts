import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { DbConfigError, readDbConfig } from '../../src/config.ts';

const base = {
  DB_APPOINTMENTS_HOST: 'pgbouncer',
  DB_APPOINTMENTS_NAME: 'appointments_db',
  DB_APPOINTMENTS_USER: 'appointments_login',
  DB_APPOINTMENTS_PASSWORD: 'secreto',
};

describe('readDbConfig', () => {
  test('reads the database by prefix with sensible defaults', () => {
    const config = readDbConfig('DB_APPOINTMENTS', 'appointments-service', base);
    assert.deepEqual(config, {
      host: 'pgbouncer',
      port: 5432,
      database: 'appointments_db',
      user: 'appointments_login',
      password: 'secreto',
      maxConnections: 10,
      idleTimeoutMs: 30_000,
      connectionTimeoutMs: 5_000,
      applicationName: 'appointments-service',
    });
  });

  test('takes the PgBouncer port from DB_CONNECT_PORT', () => {
    const config = readDbConfig('DB_APPOINTMENTS', 'appointments-service', { ...base, DB_CONNECT_PORT: '6432' });
    assert.equal(config.port, 6432);
  });

  test('fails when a required value is missing', () => {
    const { DB_APPOINTMENTS_PASSWORD: _omit, ...withoutPassword } = base;
    assert.throws(() => readDbConfig('DB_APPOINTMENTS', 'x', withoutPassword), DbConfigError);
  });

  test('fails on invalid numbers', () => {
    assert.throws(() => readDbConfig('DB_APPOINTMENTS', 'x', { ...base, DB_APPOINTMENTS_POOL_MAX: '0' }), DbConfigError);
    assert.throws(() => readDbConfig('DB_APPOINTMENTS', 'x', { ...base, DB_CONNECT_PORT: '64a32' }), DbConfigError);
  });

  test('rejects malformed prefixes', () => {
    assert.throws(() => readDbConfig('db_appointments', 'x', base), DbConfigError);
  });
});
