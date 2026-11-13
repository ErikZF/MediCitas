import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Database } from '@medicitas/db';

const schemaSql = new URL('../../../../database/clinics/init.sql', import.meta.url);

// Same TEST_DATABASE_URL convention as appointments/audit: use the existing test
// instance to create an isolated, disposable database, never a Compose database.
export async function createTestDatabase(adminUrl: string) {
  const name = `medicitas_rf3_${process.pid}_${randomUUID().slice(0, 8)}`;
  const login = `${name}_app`;
  const password = randomUUID();
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } catch (error) {
    await admin.end();
    throw error;
  }
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: target.toString(), max: 1 });
  let appPool: pg.Pool | undefined;
  let loginCreated = false;

  async function drop() {
    await appPool?.end();
    await pool.end();
    try {
      await admin.query(`DROP DATABASE ${name}`);
      if (loginCreated) await admin.query(`DROP ROLE ${login}`);
    } finally {
      await admin.end();
    }
  }

  try {
    await pool.query(readFileSync(schemaSql, 'utf8'));
    // Generated identifiers/password only. Runtime connects without superuser or
    // BYPASSRLS privileges; fixture setup alone uses the test instance owner.
    await pool.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE medicitas_app`);
    loginCreated = true;
    target.username = login;
    target.password = password;
    appPool = new pg.Pool({ connectionString: target.toString(), max: 1 });
    return { pool, db: drizzle({ client: appPool }) as unknown as Database, url: target.toString(), drop };
  } catch (error) {
    await drop();
    throw error;
  }
}
