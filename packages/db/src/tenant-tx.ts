import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertTenantContext, resolveDbRole, type DbRoleMap, type TenantContext } from './context.ts';
import { DEFAULT_CONSTRAINT_ERRORS, mapPgError, type ErrorMapping } from './errors.ts';
import { withRetry, type RetryOptions } from './retry.ts';

type AnySchema = Record<string, unknown>;

export type Database<TSchema extends AnySchema = Record<string, never>> = NodePgDatabase<TSchema>;
export type Transaction<TSchema extends AnySchema = Record<string, never>> =
  Parameters<Parameters<Database<TSchema>['transaction']>[0]>[0];

export interface TenantTxOptions {
  /** Defaults to READ COMMITTED, set explicitly on every transaction. */
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  accessMode?: 'read only' | 'read write';
  /** When given, every transaction runs SET LOCAL ROLE to the actor's database role. */
  dbRoles?: DbRoleMap;
  /** Per-transaction limit; applied locally so it never outlives the transaction in the pool. */
  statementTimeoutMs?: number;
  /** false disables retries of 40001/40P01. */
  retry?: RetryOptions | false;
  /** Service-specific meaning for constraints; merged over the defaults. */
  constraintErrors?: Readonly<Record<string, ErrorMapping>>;
}

/**
 * Runs `fn` inside a transaction that carries the tenant context.
 *
 * Everything it sets lives only inside the transaction (set_config(..., true) and
 * SET LOCAL), so it is safe with PgBouncer in transaction mode: the next request
 * that reuses the connection does not inherit this clinic or role.
 *
 * Postgres errors come out as DbError (with an HTTP `status`).
 * Errors thrown by `fn` itself propagate unchanged.
 */
export async function withTenantTx<T, TSchema extends AnySchema = Record<string, never>>(
  db: Database<TSchema>,
  ctx: TenantContext,
  fn: (tx: Transaction<TSchema>) => Promise<T>,
  options: TenantTxOptions = {},
): Promise<T> {
  assertTenantContext(ctx);
  const dbRole = resolveDbRole(ctx.role, options.dbRoles);
  const timeoutMs = options.statementTimeoutMs;

  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new RangeError('statementTimeoutMs must be a positive integer.');
  }

  const constraintErrors = { ...DEFAULT_CONSTRAINT_ERRORS, ...options.constraintErrors };

  const runOnce = () => db.transaction(async (tx) => {
    // One round trip for the three context variables.
    // platform_admin has no clinic: it stays empty, so RLS policies return no rows.
    await tx.execute(sql`select
      set_config('app.clinic_id', ${ctx.clinicId ?? ''}, true),
      set_config('app.user_sub', ${ctx.userSub}, true),
      set_config('app.role', ${ctx.role}, true)`);

    if (timeoutMs !== undefined) {
      await tx.execute(sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`);
    }

    if (dbRole !== null) {
      // A role name cannot be a bind parameter; sql.identifier quotes it, and
      // resolveDbRole already checked it is an identifier from a closed list.
      await tx.execute(sql`set local role ${sql.identifier(dbRole)}`);
    }

    return fn(tx);
  }, {
    isolationLevel: options.isolationLevel ?? 'read committed',
    accessMode: options.accessMode,
  });

  try {
    return options.retry === false ? await runOnce() : await withRetry(runOnce, options.retry);
  } catch (error) {
    throw mapPgError(error, constraintErrors) ?? error;
  }
}
