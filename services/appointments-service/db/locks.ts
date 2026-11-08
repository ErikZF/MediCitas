import { sql } from 'drizzle-orm';
import type { Transaction } from '@medicitas/db';

// Serializes changes to one professional's agenda (invariant I3).
//
// appointments_db has no professional row to lock (professionals live in users_db),
// so the lock is a transaction-level advisory lock keyed by the professional id.
// It is released on COMMIT or ROLLBACK, which keeps it safe behind PgBouncer in
// transaction mode (session advisory locks are not).
//
//   - Changing working hours or blocks takes it in exclusive mode.
//   - Booking takes it in shared mode (card E5): many bookings run in parallel,
//     but none overlaps with a schedule change. The EXCLUDE constraint still decides
//     which of two simultaneous bookings wins.
export async function lockProfessionalAgenda(
  tx: Transaction,
  professionalId: string,
  mode: 'exclusive' | 'shared',
): Promise<void> {
  if (mode === 'exclusive') {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${professionalId}, 0))`);
  } else {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${professionalId}, 0))`);
  }
}
