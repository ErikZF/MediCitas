// An appointment must fit inside one working-hours block, and working hours never cross
// midnight (I3), so no appointment lasts more than a day. appointments_db enforces it too:
// CHECK appointment_within_one_day (duration_minutes <= 1440).
//
// Why it matters: "appointments that overlap [from, to)" is starts_at < to AND ends_at > from,
// and a btree can only use one side of that. Knowing that every appointment started at most
// a day before it ends adds starts_at > from - 1 day, so the index on starts_at is scanned
// between two bounds instead of from the beginning of time (docs/indexes.md).
export const MAX_APPOINTMENT_MS = 24 * 60 * 60 * 1000;
