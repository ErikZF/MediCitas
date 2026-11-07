// Context of the caller, ALWAYS built from the verified token.
// Never filled from the route, query string or body (invariant I5).

export const APP_ROLES = ['platform_admin', 'clinic_admin', 'receptionist', 'professional'] as const;

export type AppRole = (typeof APP_ROLES)[number];

export interface TenantContext {
  /** Clinic from the token. Only null for platform_admin. */
  clinicId: string | null;
  /** Keycloak "sub" claim. */
  userSub: string;
  role: AppRole;
}

/** Application role → PostgreSQL role activated with SET LOCAL ROLE. */
export type DbRoleMap = Partial<Record<AppRole, string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PG_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export class InvalidTenantContextError extends Error {
  readonly status = 500;
  readonly code = 'invalid_tenant_context';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidTenantContextError';
  }
}

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/**
 * Fails closed: a malformed context is a server bug, not a client error,
 * and must never reach the database.
 */
export function assertTenantContext(ctx: TenantContext): void {
  if (!APP_ROLES.includes(ctx.role)) {
    throw new InvalidTenantContextError('Unknown application role.');
  }

  if (typeof ctx.userSub !== 'string' || ctx.userSub.length === 0 || ctx.userSub.length > 255) {
    throw new InvalidTenantContextError('userSub must be a non-empty string of at most 255 characters.');
  }

  if (ctx.role === 'platform_admin') {
    if (ctx.clinicId !== null) {
      throw new InvalidTenantContextError('platform_admin does not belong to a clinic.');
    }
    return;
  }

  if (ctx.clinicId === null || !isUuid(ctx.clinicId)) {
    throw new InvalidTenantContextError('clinicId must be a UUID for every role except platform_admin.');
  }
}

/**
 * Returns the database role for an application role, or null when the service
 * does not use per-actor roles yet. If a map is given and the role is missing,
 * it throws: a 500 is better than running with extra privileges.
 */
export function resolveDbRole(role: AppRole, dbRoles: DbRoleMap | undefined): string | null {
  if (dbRoles === undefined) {
    return null;
  }

  const dbRole = dbRoles[role];

  if (dbRole === undefined) {
    throw new InvalidTenantContextError(`No database role is configured for "${role}".`);
  }

  if (!PG_IDENTIFIER.test(dbRole)) {
    throw new InvalidTenantContextError('Database role names must be lowercase PostgreSQL identifiers.');
  }

  return dbRole;
}
