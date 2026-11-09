//Total by now: 58 tests
import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '../src/permissions.ts';

// Expected policy is independent of the production matrix.
const policy: Record<string, readonly Permission[]> = {
  platform_admin: ['clinic:create'],
  clinic_admin: [
    'user:create', 'user:deactivate', 'user:assign-role',
    'service:create', 'service:read', 'service:update', 'service:delete',
    'professional:create', 'schedule:read', 'schedule:manage', 'appointment:book',
  ],
  receptionist: ['schedule:read', 'appointment:book'],
  professional: ['schedule:read', 'schedule:manage'],
};

describe('initial permission policy', () => {
  test('covers exactly the confirmed roles and actions', () => {
    assert.deepEqual(Object.keys(ROLE_PERMISSIONS).sort(), Object.keys(policy).sort());
    assert.deepEqual([...PERMISSIONS].sort(), [...new Set(Object.values(policy).flat())].sort());
  });

  for (const [role, expected] of Object.entries(policy)) {
    for (const permission of PERMISSIONS) {
      test(`${role} ${expected.includes(permission) ? 'may' : 'may not'} ${permission}`, () => {
        assert.equal(hasPermission(role, permission), expected.includes(permission));
      });
    }
  }

  test.each(['', 'user', 'admin', 'CLINIC_ADMIN', 'toString', 'constructor', '__proto__'])('denies unknown role %j', (role) => {
    for (const permission of PERMISSIONS) assert.equal(hasPermission(role, permission), false);
  });

  test('denies unlisted actions even for administrators', () => {
    for (const role of Object.keys(policy)) {
      assert.equal(hasPermission(role, 'unknown:action' as Permission), false);
    }
  });

  test('exported grants cannot be changed by a consumer', () => {
    assert.equal(Reflect.set(ROLE_PERMISSIONS.clinic_admin, 0, 'clinic:create'), false);
    assert.equal(hasPermission('clinic_admin', 'clinic:create'), false);
  });
});
