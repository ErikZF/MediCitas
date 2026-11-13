import { z } from 'zod';
import { CatalogError } from './service-catalog.errors.ts';

// PUT replaces only these three attributes; neither POST nor PUT accepts isActive.
const serviceInput = z.strictObject({
  name: z.string().trim().min(1).max(128),
  durationMinutes: z.int().min(1).max(2_147_483_647),
  specialtyId: z.uuid(),
});

export function parseServiceInput(input: unknown) {
  const parsed = serviceInput.safeParse(input);
  if (!parsed.success) throw new CatalogError(422);
  return parsed.data;
}

export function parseServiceId(input: unknown): string {
  const parsed = z.uuid().safeParse(input);
  if (!parsed.success) throw new CatalogError(404);
  return parsed.data;
}
