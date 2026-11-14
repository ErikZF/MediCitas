import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, primaryKey, text, uuid, varchar } from 'drizzle-orm/pg-core';

// Query mappings only; constraints and RLS remain in database/clinics/init.sql.
export const clinic = pgTable('clinic', {
  clinicId: uuid('clinic_id').primaryKey().default(sql`gen_uuid_v7()`),
  identifier: varchar('identifier', { length: 32 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  isActive: boolean('is_active').notNull(),
  bootstrapAdminId: uuid('bootstrap_admin_id'),
  bootstrapUsername: varchar('bootstrap_username', { length: 128 }),
  timeZone: text('time_zone').notNull(),
});

export const specialty = pgTable('specialty', {
  specialtyId: uuid('specialty_id').primaryKey().default(sql`gen_uuid_v7()`),
  name: varchar('name', { length: 128 }).notNull(),
});

export const service = pgTable('service', {
  serviceId: uuid('service_id').notNull().default(sql`gen_uuid_v7()`),
  clinicId: uuid('clinic_id').notNull(),
  specialtyId: uuid('specialty_id').notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  isActive: boolean('is_active').notNull().default(true),
}, (table) => [primaryKey({ columns: [table.clinicId, table.serviceId] })]);
