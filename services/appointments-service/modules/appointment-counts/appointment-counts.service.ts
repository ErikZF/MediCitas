import { and, count, eq, gte, lt } from 'drizzle-orm';
import { assertTenantContext, MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { appointment } from '../../db/schema.ts';
import { ForbiddenError } from '../../domain/errors.ts';
import { parseOr422 } from '../../http/validation.ts';
import { appointmentCountsRange } from './appointment-counts.schemas.ts';

export interface AppointmentCounts {
  counts: {
    booked: number;
    attended: number;
    no_show: number;
    cancelled: number;
    rescheduled: number;
  };
  total: number;
}

/**
 * Internal RF21 query, not an authorization policy or an HTTP endpoint.
 * The future caller must authorize RF21 using the policy agreed by the team.
 * clinicId comes only from the trusted context, the input contains date bounds only.
 */
export async function countAppointmentsByStatus(
  deps: { db: Database },
  ctx: TenantContext,
  input: unknown,
): Promise<AppointmentCounts> {
  assertTenantContext(ctx);
  if (ctx.clinicId === null) {
    throw new ForbiddenError('A clinic context is required for appointment counts.');
  }
  const clinicId = ctx.clinicId;
  const range = parseOr422(appointmentCountsRange, input);

  const rows = await withTenantTx(deps.db, ctx, (tx) => tx
    .select({ status: appointment.status, count: count() })
    .from(appointment)
    .where(and(
      eq(appointment.clinicId, clinicId),
      gte(appointment.startsAt, new Date(range.from)),
      lt(appointment.startsAt, new Date(range.to)),
    ))
    .groupBy(appointment.status),
  { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });

  const result: AppointmentCounts = {
    counts: { booked: 0, attended: 0, no_show: 0, cancelled: 0, rescheduled: 0 },
    total: 0,
  };
  for (const row of rows) {
    // The CHECK on appointment.status defines these five values in init.sql.
    const status = row.status as keyof AppointmentCounts['counts'];
    result.counts[status] = row.count;
    result.total += row.count;
  }
  return result;
}
