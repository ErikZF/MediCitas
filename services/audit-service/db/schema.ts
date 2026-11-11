import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

// Query mapping only. Tables, constraints and RLS belong to database/logs/init.sql.
export const auditLog = pgTable('audit_log', {
  auditLogId: uuid('audit_log_id').primaryKey(),
  clinicId: uuid('clinic_id').notNull(),
  userId: uuid('app_user_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  action: varchar('action', { length: 16 }).notNull(),
  resource: varchar('resource', { length: 32 }).notNull(),
  resourceId: uuid('resource_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
});
