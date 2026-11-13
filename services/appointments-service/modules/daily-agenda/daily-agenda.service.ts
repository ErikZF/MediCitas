import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import { assertTenantContext, MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { appointment } from '../../db/schema.ts';
import { ForbiddenError } from '../../domain/errors.ts';
import { isValidTimeZone } from '../../domain/zoned-time.ts';
import { parseOr422, uuidOr404 } from '../../http/validation.ts';
import { dailyAgendaQuery } from './daily-agenda.schemas.ts';

export class ClinicUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'clinic_unavailable';
  constructor() { super('Clinic calendar settings unavailable.'); }
}

export interface ClinicCalendar {
  getTimeZone(ctx: TenantContext, authorization: string): Promise<string>;
}

export interface DailyAgendaDeps {
  db: Database;
  clinics: ClinicCalendar;
}

/** Also called by the router before parsing a requested professional id. */
export function authorizeDailyAgenda(ctx: TenantContext, professionalId?: string): void {
  assertTenantContext(ctx);
  if (ctx.clinicId === null || !hasPermission(ctx.role, 'appointment:read')
      || (ctx.role === 'professional' && (professionalId === undefined
        || professionalId.toLowerCase() !== ctx.professionalId?.toLowerCase()))) {
    throw new ForbiddenError();
  }
}

export async function getDailyAgenda(
  deps: DailyAgendaDeps, ctx: TenantContext, input: unknown,
  authorization: string, professionalId?: string,
) {
  authorizeDailyAgenda(ctx, professionalId);
  const { date } = parseOr422(dailyAgendaQuery, input);
  const selectedProfessional = professionalId === undefined ? undefined : uuidOr404(professionalId).toLowerCase();
  // Resolve the zone before the appointments transaction; no remote I/O inside it.
  const timeZone = await deps.clinics.getTimeZone(ctx, authorization);
  if (!isValidTimeZone(timeZone)) throw new ClinicUnavailableError();

  // PostgreSQL converts each local midnight separately: DST days can have 23/25
  // hours. Do not add 24 hours to the first instant. All values are parameters.
  const from = sql`(${date}::date::timestamp AT TIME ZONE ${timeZone})`;
  const to = sql`((${date}::date + 1)::timestamp AT TIME ZONE ${timeZone})`;
  const rows = await withTenantTx(deps.db, ctx, (tx) => tx.select({
    appointmentId: appointment.appointmentId,
    professionalId: appointment.professionalId,
    patientId: appointment.patientId,
    serviceId: appointment.serviceId,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    status: appointment.status,
  }).from(appointment).where(and(
    eq(appointment.clinicId, ctx.clinicId!),
    selectedProfessional === undefined ? undefined : eq(appointment.professionalId, selectedProfessional),
    lt(from, to), lt(appointment.startsAt, to), gt(appointment.endsAt, from),
  )).orderBy(asc(appointment.startsAt), asc(appointment.professionalId), asc(appointment.appointmentId)),
  { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });

  return { date, timeZone, professionalId: selectedProfessional ?? null,
    appointments: rows.map((row) => ({ ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt.toISOString() })) };
}
