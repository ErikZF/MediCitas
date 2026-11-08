import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertTenantContext, resolveDbRole, type DbRoles, type TenantContext } from './context.ts';
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
  /**
   * When given, every transaction runs SET LOCAL ROLE. Pass 'medicitas_app' to use the
   * least-privilege role of the MediCitas schemas, or a map for one role per actor.
   */
  dbRoles?: DbRoles;
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
 * Everything it sets lives only inside the transaction (app_set_session_context(..., true)
 * and SET LOCAL ROLE), so it is safe with PgBouncer in transaction mode: the next request
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
    // Every MediCitas database defines app_set_session_context next to its RLS
    // policies, so the variable names live in one place: the schema.
    // The last argument (true) makes the values local to this transaction.
    // platform_admin has no clinic: the policies that need one return no rows.
    await tx.execute(sql`select app_set_session_context(
      ${ctx.clinicId}::uuid,
      ${ctx.userId}::uuid,
      ${ctx.role}::text,
      ${ctx.professionalId ?? null}::uuid,
      true
    )`);

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
