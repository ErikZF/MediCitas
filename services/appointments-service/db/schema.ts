// Drizzle view of appointments_db, used only to build typed queries.
// The source of truth is database/appointments/init.sql: tables, EXCLUDE constraints,
// triggers and RLS policies live there, not here.

import { integer, jsonb, pgTable, primaryKey, smallint, text, time, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const workingHours = pgTable('working_hours', {
  workingHoursId: uuid('working_hours_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  weekday: smallint('weekday').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
});

export const scheduleBlock = pgTable('schedule_block', {
  scheduleBlockId: uuid('schedule_block_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  startsAt: timestamptz('starts_at').notNull(),
  endsAt: timestamptz('ends_at').notNull(),
  reason: varchar('reason', { length: 256 }),
});

export const professionalService = pgTable('professional_service', {
  professionalId: uuid('professional_id').notNull(),
  serviceId: uuid('service_id').notNull(),
  clinicId: uuid('clinic_id').notNull(),
  specialtyId: uuid('specialty_id').notNull(),
}, (table) => [primaryKey({ columns: [table.professionalId, table.serviceId] })]);

export const appointment = pgTable('appointment', {
  appointmentId: uuid('appointment_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  serviceId: uuid('service_id').notNull(),
  startsAt: timestamptz('starts_at').notNull(),
  endsAt: timestamptz('ends_at').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('booked'),
  cancelReason: varchar('cancel_reason', { length: 256 }),
  cancelledBy: uuid('cancelled_by'),
  rescheduledFromId: uuid('rescheduled_from_id'),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const clinicalNote = pgTable('clinical_note', {
  clinicalNoteId: uuid('clinical_note_id').primaryKey().defaultRandom(),
  appointmentId: uuid('appointment_id').notNull(),
  clinicId: uuid('clinic_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  content: text('content').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const outbox = pgTable('outbox', {
  eventId: uuid('event_id').primaryKey().defaultRandom(),
  clinicId: uuid('clinic_id').notNull(),
  aggregateId: uuid('aggregate_id').notNull(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  publishedAt: timestamptz('published_at'),
});
