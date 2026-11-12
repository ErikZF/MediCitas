import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { assertTenantContext, MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { auditLog } from '../../db/schema.ts';
import { auditQueryFilters, AuditQueryValidationError } from './audit-query.schemas.ts';

/** Internal RF19 query. The HTTP caller must authorize audit:read before calling. */
export async function queryAuditLogs(
  deps: { db: Database },
  ctx: TenantContext,
  input: unknown,
): Promise<Array<typeof auditLog.$inferSelect>> {
  assertTenantContext(ctx);
  const parsed = auditQueryFilters.safeParse(input);
  if (!parsed.success) throw new AuditQueryValidationError();
  const filters = parsed.data;
  // platform_admin has no clinic and must never obtain clinical audit data.
  if (ctx.clinicId === null) return [];
  const clinicId = ctx.clinicId;

  return withTenantTx(deps.db, ctx, (tx) => tx
    .select()
    .from(auditLog)
    .where(and(
      eq(auditLog.clinicId, clinicId),
      filters.userId === undefined ? undefined : eq(auditLog.userId, filters.userId),
      filters.patientId === undefined ? undefined : eq(auditLog.patientId, filters.patientId),
      filters.from === undefined ? undefined : gte(auditLog.occurredAt, new Date(filters.from)),
      filters.to === undefined ? undefined : lt(auditLog.occurredAt, new Date(filters.to)),
    ))
    .orderBy(asc(auditLog.occurredAt), asc(auditLog.auditLogId)),
  { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
}
