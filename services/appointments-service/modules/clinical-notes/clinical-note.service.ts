// RF15: the clinical note of an appointment. Only the professional who attended the
// appointment may write or read it; reception and clinic administrators never see it.
//
// Three layers say the same thing, so one mistake does not expose a note:
//   1. permissions   only the professional role has clinical-note:*        -> 403
//   2. this code     the appointment must be theirs (and attended to write) -> 403 / 422
//   3. RLS           clinical_note rows are visible only to their professional_id
//
// RF18: every successful read, create and update queues an audit event in the outbox
// in the same transaction (db/audit-outbox.ts). If the event cannot be stored, the read
// or write fails too: no access to a note goes unrecorded.

import { eq } from 'drizzle-orm';
import { hasPermission, type Permission } from '@medicitas/auth';
import { withTenantTx, type Database, type TenantContext, type Transaction } from '@medicitas/db';
import { recordAudit } from '../../db/audit-outbox.ts';
import { appointment, clinicalNote } from '../../db/schema.ts';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../domain/errors.ts';
import { asApp } from '../booking/booking.service.ts';
import type { ClinicalNoteInput } from './clinical-note.schemas.ts';

export interface ClinicalNoteDeps {
  db: Database;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface ClinicalNoteDto {
  clinicalNoteId: string;
  appointmentId: string;
  professionalId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

type NoteRow = typeof clinicalNote.$inferSelect;
type AppointmentRow = typeof appointment.$inferSelect;

function toDto(row: NoteRow): ClinicalNoteDto {
  return {
    clinicalNoteId: row.clinicalNoteId,
    appointmentId: row.appointmentId,
    professionalId: row.professionalId,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function assertAllowed(ctx: TenantContext, permission: Permission): void {
  if (!hasPermission(ctx.role, permission) || !ctx.professionalId) {
    throw new ForbiddenError();
  }
}

/**
 * The appointment, if it belongs to the professional of the token. A professional sees
 * the whole clinic's agenda (RLS), so someone else's appointment is a 403, while another
 * clinic's appointment is invisible: 404.
 */
async function ownAppointment(tx: Transaction, ctx: TenantContext, appointmentId: string): Promise<AppointmentRow> {
  const [row] = await tx.select().from(appointment).where(eq(appointment.appointmentId, appointmentId)).limit(1);
  if (row === undefined) {
    throw new NotFoundError('Appointment not found.');
  }
  if (row.professionalId !== ctx.professionalId) {
    throw new ForbiddenError();
  }
  return row;
}

/** POST: 201 with the note; 409 note_exists if the appointment already has one. */
export async function createClinicalNote(
  deps: ClinicalNoteDeps,
  ctx: TenantContext,
  appointmentId: string,
  input: ClinicalNoteInput,
): Promise<ClinicalNoteDto> {
  assertAllowed(ctx, 'clinical-note:create');
  const now = deps.now?.() ?? new Date();

  return withTenantTx(deps.db, ctx, async (tx) => {
    const visit = await ownAppointment(tx, ctx, appointmentId);
    // attended is a final status (RF13 trigger), so it cannot change before the COMMIT.
    if (visit.status !== 'attended') {
      throw new ValidationError('Only an attended appointment can have a clinical note.', 'appointment_not_attended');
    }

    // Two concurrent POSTs: the UNIQUE appointment_id lets one insert; the other gets nothing back.
    const [row] = await tx.insert(clinicalNote).values({
      appointmentId,
      clinicId: ctx.clinicId as string,
      professionalId: visit.professionalId,
      content: input.content,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({ target: clinicalNote.appointmentId }).returning();
    if (row === undefined) {
      throw new ConflictError('The appointment already has a clinical note.', 'note_exists');
    }

    await recordAudit(tx, ctx, { action: 'create', resource: 'clinical_note', resourceId: row.clinicalNoteId, patientId: visit.patientId, occurredAt: now });
    return toDto(row);
  }, asApp);
}

/** GET: 200 with the note; 404 if the appointment has none yet. */
export async function readClinicalNote(deps: ClinicalNoteDeps, ctx: TenantContext, appointmentId: string): Promise<ClinicalNoteDto> {
  assertAllowed(ctx, 'clinical-note:read');
  const now = deps.now?.() ?? new Date();

  return withTenantTx(deps.db, ctx, async (tx) => {
    const visit = await ownAppointment(tx, ctx, appointmentId);
    const [row] = await tx.select().from(clinicalNote).where(eq(clinicalNote.appointmentId, appointmentId)).limit(1);
    if (row === undefined) {
      throw new NotFoundError('Clinical note not found.');
    }

    // A read is recorded too (RF18): the transaction is not read-only on purpose.
    await recordAudit(tx, ctx, { action: 'read', resource: 'clinical_note', resourceId: row.clinicalNoteId, patientId: visit.patientId, occurredAt: now });
    return toDto(row);
  }, asApp);
}

/** PUT: 200 with the note; 404 if the appointment has none yet. */
export async function updateClinicalNote(
  deps: ClinicalNoteDeps,
  ctx: TenantContext,
  appointmentId: string,
  input: ClinicalNoteInput,
): Promise<ClinicalNoteDto> {
  assertAllowed(ctx, 'clinical-note:update');
  const now = deps.now?.() ?? new Date();

  return withTenantTx(deps.db, ctx, async (tx) => {
    const visit = await ownAppointment(tx, ctx, appointmentId);
    const [row] = await tx.update(clinicalNote)
      .set({ content: input.content, updatedAt: now })
      .where(eq(clinicalNote.appointmentId, appointmentId))
      .returning();
    if (row === undefined) {
      throw new NotFoundError('Clinical note not found.');
    }

    await recordAudit(tx, ctx, { action: 'update', resource: 'clinical_note', resourceId: row.clinicalNoteId, patientId: visit.patientId, occurredAt: now });
    return toDto(row);
  }, asApp);
}
