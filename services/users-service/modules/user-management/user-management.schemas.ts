import { z } from 'zod';
import { UserManagementError } from './user-management.errors.ts';

const clinicRole = z.enum(['clinic_admin', 'receptionist', 'professional']);
const newUser = z.strictObject({
  initialPassword: z.string().min(12).max(256), username: z.string().trim().min(3).max(128),
  role: clinicRole,
});
const roleChange = z.strictObject({ role: clinicRole });
const userId = z.uuid().transform((value) => value.toLowerCase());

export function parseNewClinicUser(input: unknown) {
  const result = newUser.safeParse(input);
  if (!result.success) throw new UserManagementError('invalid_request');
  return result.data;
}

export function parseClinicUserRole(input: unknown) {
  const result = roleChange.safeParse(input);
  if (!result.success) throw new UserManagementError('invalid_request');
  return result.data;
}

export function parseManagedUserId(input: unknown): string {
  const result = userId.safeParse(input);
  if (!result.success) throw new UserManagementError('not_found');
  return result.data;
}
