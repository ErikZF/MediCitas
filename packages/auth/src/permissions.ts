// Initial policy: Trello J2 (RF1–RF2), E2 (RF3–RF4), E3 (RF5–RF6), E5 (RF9).
// Resource ownership and tenant isolation must still be enforced by the domain and RLS.
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
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const clinicPermissions = [
  'user:create', 'user:deactivate', 'user:assign-role',
  'service:create', 'service:read', 'service:update', 'service:delete',
  'professional:create', 'schedule:read', 'schedule:manage', 'appointment:book',
] as const satisfies readonly Permission[];

export const ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(['clinic:create'] as const),
  clinic_admin: Object.freeze(clinicPermissions),
  receptionist: Object.freeze(['schedule:read', 'appointment:book'] as const),
  // schedule:manage only permits the professional's own agenda, E3 checks ownership.
  professional: Object.freeze(['schedule:read', 'schedule:manage'] as const),
} satisfies Record<string, readonly Permission[]>);

export type PermissionRole = keyof typeof ROLE_PERMISSIONS;

/** Checks an action grant only. Unknown roles and unlisted actions are denied. */
export function hasPermission(role: string, permission: Permission): boolean {
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) return false;
  const grants: readonly Permission[] = ROLE_PERMISSIONS[role as PermissionRole];
  return grants.includes(permission);
}
