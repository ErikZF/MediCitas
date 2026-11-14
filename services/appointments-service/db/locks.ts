import { sql } from 'drizzle-orm';
import type { Transaction } from '@medicitas/db';

// Transaction-level advisory locks that order the writers of an agenda. They are
// released on COMMIT or ROLLBACK, which keeps them safe behind PgBouncer in
// transaction mode (session advisory locks are not). appointments_db has no row to
// lock for a professional or a patient (they live in users_db), hence advisory locks.
//
// Why bookings take them exclusively. The EXCLUDE constraints are what guarantee I1
// and I2, but when two transactions insert overlapping rows at the same moment, each
// one finds the other's uncommitted row and waits for it: PostgreSQL sees a deadlock,
// waits deadlock_timeout (1 s) and aborts one with 40P01. Under load (fifty bookings of
// the same slot) those deadlocks cascade for seconds. With these locks, the second
// writer waits *before* inserting, then finds the first row already committed and gets
// 23P01 (409 slot_taken / patient_overlap) at once. The constraint still decides; the
// locks only make sure it never has to decide between two uncommitted rows.
//
//   professional  booking, rescheduling, working hours and blocks (I1, I3)
//   patient       booking and rescheduling (I2, which crosses professionals)
//
// Every transaction takes its locks in one global order (all professionals, then the
// patient, each sorted), so two writers can never wait for each other in a cycle.

export interface AgendaLocks {
  professionals: readonly string[];
  patient?: string;
}

export async function lockAgendas(tx: Transaction, locks: AgendaLocks): Promise<void> {
  const keys = [
    ...[...new Set(locks.professionals)].sort().map((id) => `professional:${id}`),
    ...(locks.patient === undefined ? [] : [`patient:${locks.patient}`]),
  ];
  for (const key of keys) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/** Schedule changes (working hours, blocks): only the professional's agenda. */
export async function lockProfessionalAgenda(tx: Transaction, professionalId: string): Promise<void> {
  await lockAgendas(tx, { professionals: [professionalId] });
}
