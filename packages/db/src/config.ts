// Reads one database connection from prefixed environment variables,
// for example DB_APPOINTMENTS_HOST, DB_APPOINTMENTS_NAME, DB_APPOINTMENTS_USER...

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
  applicationName: string;
}

export class DbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new DbConfigError(`${key} is required.`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    throw new DbConfigError(`${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/**
 * @param prefix  Database prefix, for example "DB_APPOINTMENTS".
 * @param applicationName  Name shown in pg_stat_activity, for example "appointments-service".
 *
 * The port comes from DB_CONNECT_PORT (shared): 6432 through PgBouncer, 5432 when
 * connecting directly. Not to be confused with DB_*_PORT in .env, which is the port
 * published to the host.
 */
export function readDbConfig(prefix: string, applicationName: string, env: NodeJS.ProcessEnv = process.env): DbConfig {
  if (!/^[A-Z][A-Z0-9_]*$/.test(prefix)) {
    throw new DbConfigError('prefix must be uppercase, for example "DB_APPOINTMENTS".');
  }

  return {
    host: required(env, `${prefix}_HOST`),
    port: integer(env, 'DB_CONNECT_PORT', 5432, 1, 65535),
    database: required(env, `${prefix}_NAME`),
    user: required(env, `${prefix}_USER`),
    password: required(env, `${prefix}_PASSWORD`),
    maxConnections: integer(env, `${prefix}_POOL_MAX`, 10, 1, 200),
    idleTimeoutMs: integer(env, `${prefix}_POOL_IDLE_MS`, 30_000, 0, 3_600_000),
    connectionTimeoutMs: integer(env, `${prefix}_CONNECT_TIMEOUT_MS`, 5_000, 100, 120_000),
    applicationName,
  };
}
