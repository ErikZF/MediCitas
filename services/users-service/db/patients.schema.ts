import { sql } from 'drizzle-orm';
import { date, jsonb, pgTable, primaryKey, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Query mappings only; the users SQL owns constraints, permissions and RLS.
export const patient = pgTable('patient', {
  patientId: uuid('patient_id').notNull().default(sql`gen_uuid_v7()`),
  clinicId: uuid('clinic_id').notNull(),
  identification: varchar('identification', { length: 32 }).notNull(),
  fullName: varchar('full_name', { length: 128 }).notNull(),
  birthDate: date('birth_date', { mode: 'string' }).notNull(),
  phone: varchar('phone', { length: 32 }),
  email: varchar('email', { length: 128 }),
}, (table) => [primaryKey({ columns: [table.clinicId, table.patientId] })]);

export const patientAuditOutbox = pgTable('outbox', {
  eventId: uuid('event_id').notNull().default(sql`gen_uuid_v7()`),
  clinicId: uuid('clinic_id').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.clinicId, table.eventId] })]);
