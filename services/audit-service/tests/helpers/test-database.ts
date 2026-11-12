import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Database } from '@medicitas/db';

const schemaSql = new URL('../../../../database/logs/init.sql', import.meta.url);

// Same TEST_DATABASE_URL convention as appointments: create and drop a temporary DB.
// The URL must point to a test instance whose owner can create databases.
export async function createTestDatabase(adminUrl: string) {
  const name = `medicitas_rf19_${process.pid}_${randomUUID().slice(0, 8)}`;
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

  async function drop() {
    await pool.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  }

  try {
    await pool.query(readFileSync(schemaSql, 'utf8'));
    return { pool, db: drizzle({ client: pool }) as unknown as Database, url: target.toString(), drop };
  } catch (error) {
    await drop();
    throw error;
  }
}
