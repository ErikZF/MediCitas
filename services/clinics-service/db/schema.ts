import { boolean, integer, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';

// Query mappings only; constraints and RLS remain in database/clinics/init.sql.
export const clinic = pgTable('clinic', {
  clinicId: uuid('clinic_id').primaryKey(),
  identifier: varchar('identifier', { length: 32 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  isActive: boolean('is_active').notNull(),
  bootstrapAdminId: uuid('bootstrap_admin_id'),
  bootstrapUsername: varchar('bootstrap_username', { length: 128 }),
  timeZone: text('time_zone').notNull(),
});

export const specialty = pgTable('specialty', {
  specialtyId: uuid('specialty_id').primaryKey(),
  name: varchar('name', { length: 128 }).notNull(),
});

export const service = pgTable('service', {
  serviceId: uuid('service_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  specialtyId: uuid('specialty_id').notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});
