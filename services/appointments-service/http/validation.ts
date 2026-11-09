import { z } from 'zod';
import { NotFoundError, ValidationError } from '../domain/errors.ts';

/** Parses request data; a failure is a 422 that never echoes the submitted values. */
export function parseOr422<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || '(body)'))];
    throw new ValidationError(`Invalid fields: ${fields.join(', ')}.`);
  }
  return result.data;
}

const uuid = z.uuid();

/** A malformed id cannot name an existing resource: 404, not 422. */
export function uuidOr404(value: unknown): string {
  const result = uuid.safeParse(value);
  if (!result.success) {
    throw new NotFoundError();
  }
  return result.data;
}
