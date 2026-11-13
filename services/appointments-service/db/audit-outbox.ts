// RF18 producer side. The audit log lives in another database (logs_db), so it cannot
// share a transaction with the clinical note. Instead, every read or write of a note
// inserts an event in this database's outbox, inside the same transaction as the read
// or write. The relay (card N10) copies it into audit_log later.
//
//   rollback  -> neither the note change nor the event exists
//   commit    -> both exist; the relay retries until the event reaches audit_log
//
// The relay inserts with audit_log_id = event_id and ON CONFLICT DO NOTHING, so a
// retry after a crash never duplicates a row in the append-only log.

import type { TenantContext, Transaction } from '@medicitas/db';
import { outbox } from './schema.ts';

export const AUDIT_EVENT_TYPE = 'AuditRecorded';

/** Same values as the CHECK constraints of audit_log in logs_db. */
export type AuditAction = 'read' | 'create' | 'update';
export type AuditResource = 'clinical_note' | 'patient_contact';

export interface AuditPayload {
  appUserId: string;
  patientId: string;
  action: AuditAction;
  resource: AuditResource;
  resourceId: string;
  occurredAt: string;
}

/** Queues one audit record. Must run inside the transaction that touched the resource. */
export async function recordAudit(
  tx: Transaction,
  ctx: TenantContext,
  event: { action: AuditAction; resource: AuditResource; resourceId: string; patientId: string; occurredAt: Date },
): Promise<void> {
  const payload: AuditPayload = {
    appUserId: ctx.userId,
    patientId: event.patientId,
    action: event.action,
    resource: event.resource,
    resourceId: event.resourceId,
    occurredAt: event.occurredAt.toISOString(),
  };
  await tx.insert(outbox).values({
    clinicId: ctx.clinicId as string,
    aggregateId: event.resourceId,
    eventType: AUDIT_EVENT_TYPE,
    payload,
  });
}
