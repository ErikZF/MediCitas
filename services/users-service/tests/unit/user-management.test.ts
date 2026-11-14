import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseNewClinicUser, parseClinicUserRole } from '../../modules/user-management/user-management.schemas.ts';

test('RF2 rejects ownership, identity and platform role from public input', () => {
  const input = { username:'reception', initialPassword:'test-password-only', role:'receptionist' };
  assert.deepEqual(parseNewClinicUser(input),input);
  for (const extra of [{clinicId:crypto.randomUUID()},{appUserId:crypto.randomUUID()},{keycloakSub:'other'},{role:'platform_admin'}]) {
    assert.throws(()=>parseNewClinicUser({...input,...extra}),{status:422});
  }
  assert.throws(()=>parseClinicUserRole({role:'platform_admin'}),{status:422});
});
