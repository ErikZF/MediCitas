import { z } from 'zod';
import { PatientError } from './patients.errors.ts';

const fields = {
  identification: z.string().trim().min(1).max(32),
  fullName: z.string().trim().min(1).max(128),
  birthDate: z.iso.date(),
  phone: z.string().trim().min(1).max(32).nullable().optional(),
  email: z.string().trim().min(1).max(128).pipe(z.email()).nullable().optional(),
};
const createBody = z.strictObject(fields);
const updateBody = createBody.partial().refine((value) => Object.values(value).some((v) => v !== undefined));
const uuid = z.uuid().transform((value) => value.toLowerCase());

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new PatientError('invalid_request');
  return result.data;
}

function checkBirthDate(value: { birthDate?: string }, now: Date): void {
  if (value.birthDate !== undefined && value.birthDate > now.toISOString().slice(0, 10)) {
    throw new PatientError('invalid_request');
  }
}

export function parseNewPatient(input: unknown, now: Date) {
  const values = parse(createBody, input);
  checkBirthDate(values, now);
  return values;
}

export function parsePatientUpdate(input: unknown, now: Date) {
  const values = parse(updateBody, input);
  checkBirthDate(values, now);
  return values;
}

/** Same route convention as the existing services: malformed ids are 404. */
export function parsePatientId(input: unknown): string {
  const result = uuid.safeParse(input);
  if (!result.success) throw new PatientError('not_found');
  return result.data;
}
