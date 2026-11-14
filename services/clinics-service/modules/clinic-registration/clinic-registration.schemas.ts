import { z } from 'zod';

function isTimeZone(value: string): boolean {
  // Intl also accepts numeric offsets on newer Node versions; RF1 needs a zone.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const registration = z.strictObject({
  name: z.string().trim().min(1).max(128),
  identifier: z.string().trim().min(1).max(32),
  timeZone: z.string().trim().min(1).refine(isTimeZone),
  administrator: z.strictObject({ initialPassword: z.string().min(12).max(256), username: z.string().trim().min(3).max(128) }),
});

export class ClinicRegistrationInputError extends Error {
  readonly status = 422;
  readonly code = 'invalid_request';

  constructor() {
    super('invalid_request');
    this.name = 'ClinicRegistrationInputError';
  }
}

export function parseClinicRegistration(input: unknown) {
  const result = registration.safeParse(input);
  if (!result.success) throw new ClinicRegistrationInputError();
  return result.data;
}
