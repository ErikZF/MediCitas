// RF18, delivery side (card I4). Clinical-note reads and writes (appointments_db) and
// patient contact writes (users_db) each queue an AuditRecorded event in their own
// database's outbox, in the same transaction as the access. This relay copies those
// events into audit_log in logs_db.
//
// One pass, per source database:
//   1. claim pending events          FOR UPDATE SKIP LOCKED, as medicitas_relay
//   2. insert them into audit_log    audit_log_id = event_id, ON CONFLICT DO NOTHING
//   3. mark them published           same transaction as step 1
//
// Steps 1 and 3 share a transaction in the source database; step 2 commits in logs_db
// in between. If the relay dies after step 2, the events are still pending and the next
// pass inserts them again: the event id as primary key turns that into a no-op, so the
// append-only log never gets a duplicate (and could not delete one).

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@medicitas/db';
import { logger } from '@medicitas/http';

export interface RelaySource {
  name: string;
  db: Database;
}

const BATCH = 100;

/** The envelope both producers write (appointments db/audit-outbox.ts, users patients). */
const auditEvent = z.object({
  appUserId: z.uuid(),
  patientId: z.uuid(),
  action: z.enum(['read', 'create', 'update']),
  resource: z.enum(['clinical_note', 'patient_contact']),
  resourceId: z.uuid(),
  occurredAt: z.iso.datetime({ offset: true }),
});

type PendingRow = { event_id: string; clinic_id: string; payload: unknown };

/** One pass over one source. Returns how many events reached audit_log. */
export async function relayAuditEvents(source: RelaySource, logs: Database): Promise<number> {
  return source.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE medicitas_relay`);
    const { rows } = await tx.execute<PendingRow>(sql`
      SELECT event_id, clinic_id, payload FROM outbox
      WHERE event_type = 'AuditRecorded' AND published_at IS NULL
      ORDER BY created_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`);

    const valid = rows.flatMap((row) => {
      const parsed = auditEvent.safeParse(row.payload);
      if (!parsed.success) {
        // Left pending for a person to inspect; it never blocks the valid ones.
        logger.error(`Malformed audit event left pending in ${source.name}.`);
        return [];
      }
      return [{ eventId: row.event_id, clinicId: row.clinic_id, ...parsed.data }];
    });
    if (valid.length === 0) return 0;

    // audit_log accepts rows of the clinic in the session context only (RLS), so each
    // clinic's events go in with that clinic's context, as medicitas_app (INSERT only).
    const byClinic = new Map<string, typeof valid>();
    for (const event of valid) byClinic.set(event.clinicId, [...(byClinic.get(event.clinicId) ?? []), event]);
    await logs.transaction(async (logTx) => {
      for (const [clinicId, events] of byClinic) {
        await logTx.execute(sql`SELECT app_set_session_context(${clinicId}::uuid, ${events[0]!.appUserId}::uuid, 'clinic_admin', NULL, true)`);
        await logTx.execute(sql`SET LOCAL ROLE medicitas_app`);
        await logTx.execute(sql`
          INSERT INTO audit_log (audit_log_id, clinic_id, app_user_id, patient_id, action, resource, resource_id, occurred_at)
          VALUES ${sql.join(events.map((e) => sql`(${e.eventId}::uuid, ${e.clinicId}::uuid, ${e.appUserId}::uuid,
            ${e.patientId}::uuid, ${e.action}, ${e.resource}, ${e.resourceId}::uuid, ${e.occurredAt}::timestamptz)`), sql`, `)}
          ON CONFLICT (clinic_id, audit_log_id) DO NOTHING`);
        await logTx.execute(sql`RESET ROLE`);
      }
    });

    await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE event_id IN ${valid.map((e) => e.eventId)}`);
    return valid.length;
  });
}

/** Runs a pass over every source each `intervalMs`; a failed pass is retried on the next tick. */
export function startAuditRelay(sources: readonly RelaySource[], logs: Database, intervalMs = 1000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    for (const source of sources) {
      try {
        while ((await relayAuditEvents(source, logs)) === BATCH) { /* drain the backlog */ }
      } catch {
        logger.error(`Audit relay pass failed for ${source.name}; events stay pending.`);
      }
    }
    running = false;
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
