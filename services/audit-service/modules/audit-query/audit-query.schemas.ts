import { z } from 'zod';

// Match the monorepo's Date mapping: require an offset and at most milliseconds.
const instant = z.iso.datetime({ offset: true }).refine(
  (value) => Number.isFinite(Date.parse(value)) && !/\.\d{4}/.test(value),
);

export const auditQueryFilters = z.strictObject({
  userId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  from: instant.optional(),
  to: instant.optional(),
}).refine(
  ({ from, to }) => from === undefined || to === undefined || Date.parse(from) < Date.parse(to),
  { path: ['to'] },
);

export class AuditQueryValidationError extends Error {
  readonly status = 422;
  readonly code = 'invalid_request';

  constructor() {
    super('Invalid audit query filters.');
    this.name = 'AuditQueryValidationError';
  }
}
