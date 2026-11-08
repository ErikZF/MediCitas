// Context of the caller, ALWAYS built from the verified token.
// Never filled from the route, query string or body (invariant I5).
//
// It is loaded into PostgreSQL with app_set_session_context(...), the function every
// MediCitas database defines next to its RLS policies (see docs/database.md).

export const APP_ROLES = ['platform_admin', 'clinic_admin', 'receptionist', 'professional'] as const;

export type AppRole = (typeof APP_ROLES)[number];

export interface TenantContext {
  /** Clinic from the token. Only null for platform_admin. */
  clinicId: string | null;
  /** Domain user id (app_user.app_user_id in users_db). RLS compares it with app_user_id columns. */
  userId: string;
  role: AppRole;
  /** professional.professional_id. Required for the professional role, absent for every other role. */
  professionalId?: string | null;
}

/**
 * PostgreSQL role activated with SET LOCAL ROLE.
 * A single name applies to every application role (MediCitas uses medicitas_app);
 * a map allows one database role per application role.
 */
export type DbRoleMap = Partial<Record<AppRole, string>>;
export type DbRoles = string | DbRoleMap;

/** Least-privilege role created by every MediCitas init.sql. It has no BYPASSRLS. */
export const MEDICITAS_APP_ROLE = 'medicitas_app';

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

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Fails closed: a malformed context is a server bug, not a client error,
 * and must never reach the database.
 */
export function assertTenantContext(ctx: TenantContext): void {
  if (!APP_ROLES.includes(ctx.role)) {
    throw new InvalidTenantContextError('Unknown application role.');
  }

  if (!isUuid(ctx.userId)) {
    throw new InvalidTenantContextError('userId must be a UUID (app_user_id).');
  }

  if (ctx.role === 'platform_admin') {
    if (ctx.clinicId !== null) {
      throw new InvalidTenantContextError('platform_admin does not belong to a clinic.');
    }
  } else if (!isUuid(ctx.clinicId)) {
    throw new InvalidTenantContextError('clinicId must be a UUID for every role except platform_admin.');
  }

  const professionalId = ctx.professionalId ?? null;

  if (ctx.role === 'professional') {
    // Without it, the professional-only RLS policies would silently return no rows.
    if (!isUuid(professionalId)) {
      throw new InvalidTenantContextError('professionalId must be a UUID for the professional role.');
    }
  } else if (professionalId !== null) {
    throw new InvalidTenantContextError('Only the professional role carries a professionalId.');
  }
}

/**
 * Returns the database role for an application role, or null when the service
 * does not switch roles. If a map is given and the role is missing, it throws:
 * a 500 is better than running with extra privileges.
 */
export function resolveDbRole(role: AppRole, dbRoles: DbRoles | undefined): string | null {
  if (dbRoles === undefined) {
    return null;
  }

  const dbRole = typeof dbRoles === 'string' ? dbRoles : dbRoles[role];

  if (dbRole === undefined) {
    throw new InvalidTenantContextError(`No database role is configured for "${role}".`);
  }

  if (!PG_IDENTIFIER.test(dbRole)) {
    throw new InvalidTenantContextError('Database role names must be lowercase PostgreSQL identifiers.');
  }

  return dbRole;
}
