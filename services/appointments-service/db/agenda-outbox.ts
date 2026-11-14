// Card E14: the agenda changes recorded in the outbox, as a backstop for the cache.
//
// Every write that changes an agenda already invalidates Redis right after its COMMIT and
// before answering, which is what makes I8 immediate. But that call happens outside the
// transaction: if the process dies between the COMMIT and the INCR, the invalidation is
// lost and Redis serves the old day until its TTL (10 minutes).
//
// So the same transaction also inserts an AgendaChanged event. The relay
// (cache/agenda-relay.ts) applies it again and marks it published. Invalidating twice is
// harmless (one extra cache miss); invalidating zero times is what this prevents.

import type { TenantContext, Transaction } from '@medicitas/db';
import { outbox } from './schema.ts';

export const AGENDA_EVENT_TYPE = 'AgendaChanged';

export interface AgendaChangedPayload {
  professionalId: string;
  /** Calendar dates in the clinic's zone; null means every day (working hours or blocks changed). */
  dates: string[] | null;
}

/** Must run inside the transaction that changed the agenda. */
export async function recordAgendaChange(
  tx: Transaction,
  ctx: TenantContext,
  professionalId: string,
  dates: readonly string[] | null,
): Promise<void> {
  const payload: AgendaChangedPayload = { professionalId, dates: dates === null ? null : [...new Set(dates)] };
  await tx.insert(outbox).values({
    clinicId: ctx.clinicId as string,
    aggregateId: professionalId,
    eventType: AGENDA_EVENT_TYPE,
    payload,
  });
}
