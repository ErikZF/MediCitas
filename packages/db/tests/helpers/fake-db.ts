import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../../src/tenant-tx.ts';

const dialect = new PgDialect();

export interface RenderedQuery {
  sql: string;
  params: unknown[];
}

/**
 * Fake database that mimics Drizzle's db.transaction and records the SQL that would
 * run on each attempt, already rendered with its parameters separated.
 */
export function fakeDb() {
  const configs: unknown[] = [];
  const attempts: RenderedQuery[][] = [];

  const db = {
    async transaction<T>(fn: (tx: unknown) => Promise<T>, config?: unknown): Promise<T> {
      configs.push(config);
      const statements: RenderedQuery[] = [];
      attempts.push(statements);
      const tx = {
        async execute(query: SQL) {
          statements.push(dialect.sqlToQuery(query));
          return { rows: [] };
        },
      };
      return fn(tx);
    },
  };

  return { db: db as unknown as Database, configs, attempts };
}

/** Error shaped like the ones Drizzle 0.44+ throws: the driver error sits in `cause`. */
export function drizzleWrapped(code: string, constraint?: string) {
  return Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('pg error'), { code, constraint, detail: 'Key (id)=(secret) already exists.' }),
  });
}

export const CLINIC_A = '0b6c2f3e-4d1a-4c8e-9f2b-7a1d3e5c9b01';
export const CLINIC_B = '5e9a1c7d-2b4f-4a6e-8d3c-1f7b9e2a4c02';
