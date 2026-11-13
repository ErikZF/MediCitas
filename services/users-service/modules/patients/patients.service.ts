import { and, eq } from 'drizzle-orm';
import { hasPermission } from '@medicitas/auth';
import {
  assertTenantContext, findPgError, MEDICITAS_APP_ROLE, withTenantTx,
  type Database, type TenantContext, type Transaction,
} from '@medicitas/db';
import { patient, patientAuditOutbox } from '../../db/patients.schema.ts';
import { PatientError } from './patients.errors.ts';
import { parseNewPatient, parsePatientId, parsePatientUpdate } from './patients.schemas.ts';

export interface PatientsDeps {
  db: Database;
  now?: () => Date;
}

type PatientPermission = 'patient:create' | 'patient:read' | 'patient:update';

export function assertPatientAccess(ctx: TenantContext, permission: PatientPermission): void {
  assertTenantContext(ctx);
  if (ctx.clinicId === null || !hasPermission(ctx.role, permission)) throw new PatientError('forbidden');
}

const asApp = {
  dbRoles: MEDICITAS_APP_ROLE,
  constraintErrors: {
    patient_clinic_id_identification_key: {
      status: 409, code: 'duplicate_identification', message: 'Identification already registered in this clinic.',
    },
  },
};

/** Same AuditRecorded envelope as appointments; contact values never enter it. */
async function enqueueContactAudit(
  tx: Transaction, ctx: TenantContext, patientId: string, action: 'create' | 'update', now: Date,
): Promise<void> {
  const values = {
    clinicId: ctx.clinicId!, aggregateId: patientId, eventType: 'AuditRecorded',
    payload: {
      appUserId: ctx.userId, patientId, action, resource: 'patient_contact',
      resourceId: patientId, occurredAt: now.toISOString(),
    },
  };
  try {
    // Catch only this enqueue statement, never patient writes or COMMIT.
    await tx.insert(patientAuditOutbox).values(values);
  } catch (error) {
    const pg = findPgError(error);
    // Missing queue / denied queue INSERT are availability failures. Data errors,
    // duplicate events, deadlocks, connection failures and programming errors keep
    // the existing DB translation/retry behavior instead of becoming audit_unavailable.
    const deniedInsert = pg?.code === '42501' && 'routine' in pg && pg.routine === 'aclcheck_error';
    if (pg?.code === '42P01' || deniedInsert) throw new PatientError('audit_unavailable');
    throw error;
  }
}

export async function createPatient(deps: PatientsDeps, ctx: TenantContext, input: unknown): Promise<{ patientId: string }> {
  assertPatientAccess(ctx, 'patient:create');
  const now = deps.now?.() ?? new Date();
  const values = parseNewPatient(input, now);
  return withTenantTx(deps.db, ctx, async (tx) => {
    const [created] = await tx.insert(patient).values({
      ...values, phone: values.phone ?? null, email: values.email ?? null, clinicId: ctx.clinicId!,
    }).returning({ patientId: patient.patientId });
    // Registration creates the contact record even when its values are initially null.
    await enqueueContactAudit(tx, ctx, created!.patientId, 'create', now);
    return created!;
  }, asApp);
}

export async function updatePatient(deps: PatientsDeps, ctx: TenantContext, id: unknown, input: unknown): Promise<void> {
  assertPatientAccess(ctx, 'patient:update');
  const patientId = parsePatientId(id);
  const now = deps.now?.() ?? new Date();
  const values = parsePatientUpdate(input, now);
  await withTenantTx(deps.db, ctx, async (tx) => {
    const [updated] = await tx.update(patient).set(values)
      .where(and(eq(patient.patientId, patientId), eq(patient.clinicId, ctx.clinicId!)))
      .returning({ patientId: patient.patientId });
    if (!updated) throw new PatientError('not_found');
    if (values.phone !== undefined || values.email !== undefined) {
      await enqueueContactAudit(tx, ctx, patientId, 'update', now);
    }
  }, asApp);
}

/** Existence only: projects no contact columns, needs no RF18 contact-read event. */
export async function getPatientMembership(deps: PatientsDeps, ctx: TenantContext, id: unknown): Promise<{ patientId: string }> {
  assertPatientAccess(ctx, 'patient:read');
  const patientId = parsePatientId(id);
  return withTenantTx(deps.db, ctx, async (tx) => {
    const [found] = await tx.select({ patientId: patient.patientId }).from(patient)
      .where(and(eq(patient.patientId, patientId), eq(patient.clinicId, ctx.clinicId!))).limit(1);
    if (!found) throw new PatientError('not_found');
    return found;
  }, { dbRoles: MEDICITAS_APP_ROLE, accessMode: 'read only' });
}
