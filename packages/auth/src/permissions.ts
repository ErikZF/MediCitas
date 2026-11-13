// Initial policy: Trello J2 (RF1–RF2), E2 (RF3–RF4), E3 (RF5–RF6), E5 (RF9).
// Resource ownership and tenant isolation must still be enforced by the domain and RLS.
// Additional confirmed actions: J3 (RF14), E9 (RF15), J4 (RF19), and getAppointment.
// J4 (RF21): clinic-wide counts are granted to clinic_admin and receptionist only.
// E7 (RF10-RF12): reception reschedules and cancels; a professional may record the
// outcome of their own appointments only, which the domain and RLS check.
// E9 (RF15): only professionals touch clinical notes, and only on their own appointments.
export const PERMISSIONS = [
  'clinic:create',
  'user:create',
  'user:deactivate',
  'user:assign-role',
  'service:create',
  'service:read',
  'service:update',
  'service:delete',
  'professional:create',
  'schedule:read',
  'schedule:manage',
  'appointment:book',
  'appointment:read',
  'appointment:count',
  'appointment:reschedule',
  'appointment:cancel',
  'appointment:record-outcome',
  'patient:create',
  'patient:read',
  'patient:update',
  'clinical-note:create',
  'clinical-note:read',
  'clinical-note:update',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const clinicPermissions = [
  'user:create', 'user:deactivate', 'user:assign-role',
  'service:create', 'service:read', 'service:update', 'service:delete',
  'professional:create', 'schedule:read', 'schedule:manage', 'appointment:book',
  'appointment:read', 'appointment:count', 'appointment:reschedule', 'appointment:cancel', 'appointment:record-outcome',
  'patient:create', 'patient:read', 'patient:update', 'audit:read',
] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(['clinic:create'] as const),
  clinic_admin: Object.freeze(clinicPermissions),
  receptionist: Object.freeze([
    'schedule:read', 'appointment:book', 'appointment:read', 'appointment:count',
    'appointment:reschedule', 'appointment:cancel', 'appointment:record-outcome',
    'patient:create', 'patient:read', 'patient:update',
  ] as const),
  // schedule:manage only permits the professional's own agenda, E3 checks ownership.
  professional: Object.freeze([
    'schedule:read', 'schedule:manage', 'appointment:read', 'appointment:record-outcome', 'patient:read',
    'clinical-note:create', 'clinical-note:read', 'clinical-note:update',
  ] as const),
} satisfies Record<string, readonly Permission[]>);

export type PermissionRole = keyof typeof ROLE_PERMISSIONS;

/** Checks an action grant only. Unknown roles and unlisted actions are denied. */
export function hasPermission(role: string, permission: Permission): boolean {
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) return false;
  const grants: readonly Permission[] = ROLE_PERMISSIONS[role as PermissionRole];
  return grants.includes(permission);
}
