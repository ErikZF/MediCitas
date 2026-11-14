import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ClinicRegistrationInputError, parseClinicRegistration } from '../../modules/clinic-registration/clinic-registration.schemas.ts';

test('RF1 requires the first administrator, a valid zone and owner-controlled fields', () => {
  const input = { name: ' Clínica Uno ', identifier: ' UNO ', timeZone: 'America/Costa_Rica', administrator: { initialPassword: 'temporary-test-only', username: ' admin.uno ' } };
  assert.deepEqual(parseClinicRegistration(input), {
    ...input, name: 'Clínica Uno', identifier: 'UNO', administrator: { initialPassword: 'temporary-test-only', username: 'admin.uno' },
  });
  const { administrator: _administrator, ...clinicOnly } = input;
  for (const invalid of [
    clinicOnly, { ...input, administrator: {} }, { ...input, timeZone: 'Unknown/Zone' },
    { ...input, timeZone: '+01:00' }, { ...input, clinicId: 'supplied-by-client' },
    { ...input, administrator: { username: 'admin', role: 'platform_admin' } },
    { ...input, name: '' }, { ...input, identifier: 'x'.repeat(33) },
  ]) assert.throws(() => parseClinicRegistration(invalid), ClinicRegistrationInputError);
});
