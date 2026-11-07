import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DbConfig } from './config.ts';
import type { Database } from './tenant-tx.ts';

type AnySchema = Record<string, unknown>;

export interface DatabaseHandle<TSchema extends AnySchema> {
  db: Database<TSchema>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions<TSchema extends AnySchema> {
  schema?: TSchema;
  /** Errors from idle pool connections. Without this handler the process crashes. */
  onIdleClientError?: (error: Error) => void;
}

/**
 * One pool per database and per service. No startup parameters such as
 * statement_timeout are passed: PgBouncer rejects them. That kind of setting is
 * applied locally inside withTenantTx.
 *
 * Do not use named prepared statements (`.prepare('name')`) while PgBouncer runs in
 * transaction mode, unless it has max_prepared_statements enabled.
 */
export function createDatabase<TSchema extends AnySchema = Record<string, never>>(
  config: DbConfig,
  options: CreateDatabaseOptions<TSchema> = {},
): DatabaseHandle<TSchema> {
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    application_name: config.applicationName,
  });

  pool.on('error', options.onIdleClientError ?? (() => {}));

  const db = (options.schema === undefined
    ? drizzle({ client: pool })
    : drizzle({ client: pool, schema: options.schema })) as unknown as Database<TSchema>;

  return {
    db,
    pool,
    close: () => pool.end(),
  };
}
