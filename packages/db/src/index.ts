export {
  APP_ROLES,
  assertTenantContext,
  DB_ADMIN_ROLE,
  DB_PROFESSIONAL_ROLE,
  DB_RECEPTIONIST_ROLE,
  InvalidTenantContextError,
  isUuid,
  MEDICITAS_APP_ROLE,
  MEDICITAS_DB_ROLES,
  resolveDbRole,
} from './context.ts';
export type { AppRole, DbRoleMap, DbRoles, TenantContext } from './context.ts';

export { DbConfigError, readDbConfig } from './config.ts';
export type { DbConfig } from './config.ts';

export { DbError, DEFAULT_CONSTRAINT_ERRORS, findPgError, mapPgError } from './errors.ts';
export type { ErrorMapping, PgErrorLike } from './errors.ts';

export { createDatabase } from './pool.ts';
export type { CreateDatabaseOptions, DatabaseHandle } from './pool.ts';

export { backoffDelay, isRetryable, withRetry } from './retry.ts';
export type { RetryOptions } from './retry.ts';

export { withTenantTx } from './tenant-tx.ts';
export type { Database, TenantTxOptions, Transaction } from './tenant-tx.ts';
