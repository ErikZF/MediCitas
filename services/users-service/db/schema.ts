import { boolean, pgTable, text, uuid, varchar } from 'drizzle-orm/pg-core';

// Query mappings only. Schema, constraints and RLS remain in database/users/init.sql.
export const appUser = pgTable('app_user', {
  appUserId: uuid('app_user_id').primaryKey(),
  keycloakSub: text('keycloak_sub').notNull(),
  clinicId: uuid('clinic_id'),
  roleCode: varchar('role_code', { length: 32 }).notNull(),
  isActive: boolean('is_active').notNull(),
});

export const professional = pgTable('professional', {
  professionalId: uuid('professional_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  appUserId: uuid('app_user_id').notNull(),
  fullName: varchar('full_name', { length: 128 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const professionalSpecialty = pgTable('professional_specialty', {
  professionalId: uuid('professional_id').notNull(),
  specialtyId: uuid('specialty_id').notNull(),
  clinicId: uuid('clinic_id').notNull(),
});
