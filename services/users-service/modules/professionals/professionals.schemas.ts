import { z } from 'zod';
import { ProfessionalError } from './professionals.errors.ts';

const uuid = z.uuid().transform((value) => value.toLowerCase());

const professionalInput = z.strictObject({
  appUserId: uuid,
  fullName: z.string().trim().min(1).max(128),
  specialtyIds: z.array(uuid).min(1)
    .refine((ids) => new Set(ids).size === ids.length),
});

export function parseProfessionalInput(input: unknown) {
  const parsed = professionalInput.safeParse(input);
  if (!parsed.success) throw new ProfessionalError('invalid_request');
  return { ...parsed.data, specialtyIds: [...parsed.data.specialtyIds].sort() };
}
