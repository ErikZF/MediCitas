// Card E14: applies the AgendaChanged events of the outbox to Redis (db/agenda-outbox.ts).
//
// Each pass claims a batch of pending events with FOR UPDATE SKIP LOCKED, so several pods
// can run it without applying the same event twice at the same time, applies them and
// marks them published in the same transaction. If Redis fails, the transaction rolls
// back and the events stay pending for the next pass.
//
// It runs as medicitas_relay, the only role that can read and update the outbox of every
// clinic. It only touches AgendaChanged: AuditRecorded events belong to the audit relay.

import { sql } from 'drizzle-orm';
import type { Database } from '@medicitas/db';
import { logger } from '@medicitas/http';
import { AGENDA_EVENT_TYPE, type AgendaChangedPayload } from '../db/agenda-outbox.ts';
import type { AgendaCache } from './agenda-cache.ts';

const BATCH = 100;

/** One pass. Returns how many events were applied. */
export async function relayAgendaChanges(db: Database, cache: AgendaCache): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE medicitas_relay`);
    const { rows } = await tx.execute<{ event_id: string; clinic_id: string; payload: AgendaChangedPayload }>(sql`
      SELECT event_id, clinic_id, payload FROM outbox
      WHERE event_type = ${AGENDA_EVENT_TYPE} AND published_at IS NULL
      ORDER BY created_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`);
    if (rows.length === 0) return 0;

    for (const { clinic_id: clinicId, payload } of rows) {
      if (payload.dates === null) {
        await cache.applyProfessionalChanged(clinicId, payload.professionalId);
      } else {
        await cache.applyDayChanged(clinicId, payload.professionalId, payload.dates);
      }
    }
    const ids = rows.map((row) => row.event_id);
    await tx.execute(sql`UPDATE outbox SET published_at = now() WHERE event_id IN ${ids}`);
    return rows.length;
  });
}

/** Runs a pass every `intervalMs` until stopped. A failed pass is logged and retried. */
export function startAgendaRelay(db: Database, cache: AgendaCache, intervalMs = 1000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      // Drain the backlog, a batch at a time.
      while ((await relayAgendaChanges(db, cache)) === BATCH) { /* next batch */ }
    } catch {
      logger.error('Agenda relay pass failed; events stay pending.');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
