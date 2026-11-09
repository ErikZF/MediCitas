import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Database } from '@medicitas/db';

const schemaSql = new URL('../../../../database/appointments/init.sql', import.meta.url);

/**
 * Creates a throwaway database with the real appointments schema (tables, EXCLUDE
 * constraints, triggers, RLS policies and medicitas_app) and drops it afterwards.
 * `adminUrl` needs a user that can create databases.
 */
export async function createTestDatabase(adminUrl: string, label: string) {
  const name = `medicitas_${label}_${process.pid}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);

  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  // The owner connection is a superuser and bypasses RLS: use it only to seed and inspect.
  const pool = new pg.Pool({ connectionString: target.toString(), max: 4 });
  await pool.query(readFileSync(schemaSql, 'utf8'));

  return {
    pool,
    db: drizzle({ client: pool }) as unknown as Database,
    async drop() {
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
      await admin.end();
    },
  };
}
