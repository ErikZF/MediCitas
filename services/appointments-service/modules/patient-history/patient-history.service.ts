import { and, desc, eq } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import { assertTenantContext, isUuid, MEDICITAS_APP_ROLE, withTenantTx, type Database, type TenantContext } from '@medicitas/db';
import { appointment } from '../../db/schema.ts';
import { ForbiddenError, ValidationError } from '../../domain/errors.ts';

export interface PatientHistoryAppointment {
  appointmentId: string;
  professionalId: string;
  serviceId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  /** The previous appointment remains a separate entry in the history. */
  rescheduledFromId: string | null;
}

/**
 * Internal RF16 query: current appointment states, including future appointments.
 * RF16 permits professionals to read the patient's history within their clinic;
 * the own-appointment restriction applies to clinical notes, which are not read here.
 * The caller supplies a trusted context; clinicId never comes from the requested id.
 */
export async function getPatientAppointmentHistory(
  deps: { db: Database },
  ctx: TenantContext,
  patientId: unknown,
): Promise<PatientHistoryAppointment[]> {
  assertTenantContext(ctx);
  if (!hasPermission(ctx.role, 'appointment:read') || ctx.clinicId === null) {
    throw new ForbiddenError();
  }
  if (!isUuid(patientId)) {
    throw new ValidationError('patientId must be a UUID.');
  }
  const clinicId = ctx.clinicId;

  const rows = await withTenantTx(deps.db, ctx, (tx) => tx
    .select({
      appointmentId: appointment.appointmentId,
      professionalId: appointment.professionalId,
      serviceId: appointment.serviceId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      rescheduledFromId: appointment.rescheduledFromId,
    })
    .from(appointment)
    .where(and(eq(appointment.clinicId, clinicId), eq(appointment.patientId, patientId)))
    .orderBy(desc(appointment.startsAt), desc(appointment.appointmentId)),
  { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });

  return rows.map((row) => ({
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  }));
}
