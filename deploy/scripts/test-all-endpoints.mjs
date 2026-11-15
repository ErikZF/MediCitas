#!/usr/bin/env node
// Comprehensive end-to-end verification of every MediCitas endpoint through the
// Edge Gateway (http://localhost:3000) and Keycloak (http://localhost:8080).
// E2E_RUNTIME selects where the stack runs: 'k8s' (default, kubectl) or 'compose'
// (docker compose, used by `npm run test:all`).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const GATEWAY_URL = (process.env.GATEWAY_URL || 'http://localhost:3000').replace(/\/+$/, '');
const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || 'http://localhost:8080').replace(/\/+$/, '');
const REALM = process.env.REALM_NAME || 'Sistema_Clinico';
const TEST_CLIENT_ID = process.env.KEYCLOAK_TEST_CLIENT_ID || 'integration-tests';
const NAMESPACE = process.env.KUBE_NAMESPACE || 'medicitas';
const RUNTIME = process.env.E2E_RUNTIME || 'k8s';
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Runs a command inside one container of the Compose stack.
function composeExec(service, args, env = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return execFileSync('docker', ['compose', 'exec', '-T', ...envArgs, service, ...args], { encoding: 'utf8', cwd: REPO_ROOT });
}

function loadSecretsPassword() {
  if (process.env.KEYCLOAK_TEST_PASSWORD) return process.env.KEYCLOAK_TEST_PASSWORD;
  try {
    const raw = readFileSync(new URL('../k8s/overlays/local/secrets.env', import.meta.url), 'utf8');
    const match = raw.match(/^KEYCLOAK_TEST_PASSWORD=(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  return 'your_test_password';
}

const TEST_PASSWORD = loadSecretsPassword();
const SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Seeded Clinic 1 (clinic-sj-01) IDs from database/*/seed.sql
const SEED = {
  clinicId: '019a0000-0000-7000-8000-000000000101',
  specialtyId: '019a0000-0000-7000-8000-000000000201',
  serviceId: '019a0000-0000-7000-8000-000000000301',
  professionalId: '019a0000-0000-7000-8000-000000000501', // dr.mora
  professionalAppUserId: '019a0000-0000-7000-8000-000000000404',
  patientId: '019a0000-0000-7000-8000-000000000601',
  conflictPatientId: '019a0000-0000-7000-8000-000000000602',
  startedAppointmentId: '019a0000-0000-7000-8000-000000000804',
};

let passed = 0;

async function step(name, fn) {
  try {
    const result = await fn();
    passed += 1;
    console.log(`PASS [${passed}] ${name}`);
    return result;
  } catch (err) {
    console.error(`FAIL ${name}:`, err);
    process.exit(1);
  }
}

async function http(method, path, { token, body, expectedStatus } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (expectedStatus !== undefined) {
    const allowed = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];
    assert.ok(
      allowed.includes(res.status),
      `${method} ${path} expected HTTP ${allowed.join('/')} but got ${res.status}: ${text}`,
    );
  }
  return { status: res.status, headers: res.headers, body: json, text };
}

async function getToken(username, password = TEST_PASSWORD) {
  const tokenUrl = `${KEYCLOAK_URL}/realms/${encodeURIComponent(REALM)}/protocol/openid-connect/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: TEST_CLIENT_ID,
      username,
      password,
    }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `Token request for ${username} failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  assert.ok(typeof data.access_token === 'string' && data.access_token.length > 0);
  return data.access_token;
}

function addDaysUtc(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`Running full MediCitas E2E endpoint verification against ${GATEWAY_URL} and ${KEYCLOAK_URL} (suffix=${SUFFIX})`);

  // 00 - Health & internal services
  await step('GET / (edge-gateway root)', async () => {
    const res = await http('GET', '/', { expectedStatus: 200 });
    assert.equal(res.text, 'Hello World!');
  });

  await step('GET /health (edge-gateway health)', async () => {
    const res = await http('GET', '/health', { expectedStatus: 200 });
    assert.equal(res.body.status, 'ok');
  });

  await step('Internal ClusterIP /health on all 4 microservices', async () => {
    const probe = `Promise.all([
          'http://clinics-service:3000/health',
          'http://users-service:3000/health',
          'http://appointments-service:3000/health',
          'http://audit-service:3000/health'
        ].map(u => fetch(u).then(async r => ({ status: r.status, body: await r.json() }))))
        .then(r => console.log(JSON.stringify(r)))`;
    let out;
    if (RUNTIME === 'compose') {
      out = composeExec('edge-gateway', ['node', '-e', probe]);
    } else {
      const pod = execFileSync(
        'kubectl',
        ['get', 'pod', '-n', NAMESPACE, '-l', 'app.kubernetes.io/name=edge-gateway', '-o', 'jsonpath={.items[0].metadata.name}'],
        { encoding: 'utf8' },
      ).trim();
      out = execFileSync('kubectl', ['exec', '-n', NAMESPACE, pod, '--', 'node', '-e', probe], { encoding: 'utf8' });
    }
    const results = JSON.parse(out);
    assert.equal(results.length, 4);
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    }
  });

  // Tokens
  const tokens = await step('Keycloak OIDC tokens for seeded roles', async () => ({
    platformAdmin: await getToken('platform.admin'),
    clinicAdmin: await getToken('admin.sj'),
    receptionist: await getToken('reception.sj'),
    professional: await getToken('dr.mora'),
  }));

  await step('Unauthenticated and invalid token guards (401)', async () => {
    await http('GET', '/audit/logs', { expectedStatus: 401 });
    await http('GET', '/services', { token: 'invalid.jwt.token', expectedStatus: 401 });
  });

  // 01 - Clinic onboarding (RF1) & clinic settings
  const bootstrapPassword = `DemoPass!${SUFFIX}`;
  const bootstrapUsername = `k8s.admin.${SUFFIX}`;
  const onboarded = await step('POST /clinics (RF1 onboarding + users bootstrap + Keycloak)', async () => {
    const res = await http('POST', '/clinics', {
      token: tokens.platformAdmin,
      body: {
        name: `K8s Demo Clinic ${SUFFIX}`,
        identifier: `k8s-${SUFFIX.slice(0, 16)}`,
        timeZone: 'America/Costa_Rica',
        administrator: {
          username: bootstrapUsername,
          initialPassword: bootstrapPassword,
        },
      },
      expectedStatus: 201,
    });
    assert.ok(res.body.clinicId);
    assert.ok(res.body.appUserId);
    return res.body;
  });

  await step('GET /clinic/time-zone (seeded clinic) + verify bootstrapped admin exists in Keycloak', async () => {
    const r1 = await http('GET', '/clinic/time-zone', { token: tokens.receptionist, expectedStatus: 200 });
    assert.equal(r1.body.clinicId, SEED.clinicId);
    assert.ok(r1.body.timeZone);

    // Bootstrapped admins are created with a temporary password (UPDATE_PASSWORD required action),
    // so Direct Access Grant returns 400 "Account is not fully set up" rather than "Invalid user credentials".
    const tokenUrl = `${KEYCLOAK_URL}/realms/${encodeURIComponent(REALM)}/protocol/openid-connect/token`;
    const kcRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: TEST_CLIENT_ID,
        username: bootstrapUsername,
        password: bootstrapPassword,
      }),
    });
    const kcBody = await kcRes.json();
    assert.equal(kcRes.status, 400);
    assert.equal(kcBody.error_description, 'Account is not fully set up');
  });

  // 02 - Catalog (RF3 & RF4)
  await step('GET /specialties (RF4 global specialties)', async () => {
    const res = await http('GET', '/specialties', { token: tokens.clinicAdmin, expectedStatus: 200 });
    assert.ok(Array.isArray(res.body) && res.body.length > 0);
  });

  await step('GET /services and GET /services/:serviceId (RF3)', async () => {
    const list = await http('GET', '/services', { token: tokens.clinicAdmin, expectedStatus: 200 });
    assert.ok(Array.isArray(list.body) && list.body.length > 0);
    await http('GET', '/services', { token: tokens.receptionist, expectedStatus: 403 });
    const one = await http('GET', `/services/${SEED.serviceId}`, { token: tokens.receptionist, expectedStatus: 200 });
    assert.equal(one.body.serviceId, SEED.serviceId);
  });

  const demoService = await step('POST / PUT / DELETE /services/:serviceId (RF3 lifecycle)', async () => {
    const created = await http('POST', '/services', {
      token: tokens.clinicAdmin,
      body: { name: `K8s Service ${SUFFIX}`, durationMinutes: 30, specialtyId: SEED.specialtyId },
      expectedStatus: 201,
    });
    const serviceId = created.body.serviceId;
    assert.equal(created.body.isActive, true);

    const updated = await http('PUT', `/services/${serviceId}`, {
      token: tokens.clinicAdmin,
      body: { name: `K8s Service ${SUFFIX} Updated`, durationMinutes: 45, specialtyId: SEED.specialtyId },
      expectedStatus: 200,
    });
    assert.equal(updated.body.durationMinutes, 45);

    // Create a second active service to assign to the demo professional later
    const activeForProf = await http('POST', '/services', {
      token: tokens.clinicAdmin,
      body: { name: `K8s Active Service ${SUFFIX}`, durationMinutes: 30, specialtyId: SEED.specialtyId },
      expectedStatus: 201,
    });

    await http('DELETE', `/services/${serviceId}`, { token: tokens.clinicAdmin, expectedStatus: 204 });
    const afterDelete = await http('GET', `/services/${serviceId}`, { token: tokens.clinicAdmin, expectedStatus: 200 });
    assert.equal(afterDelete.body.isActive, false);

    return activeForProf.body;
  });

  // 03 - Users, professionals & assignments (RF2 & RF4)
  const managedUser = await step('POST /users (RF2 create professional user)', async () => {
    const res = await http('POST', '/users', {
      token: tokens.clinicAdmin,
      body: {
        username: `k8s.prof.${SUFFIX}`,
        initialPassword: `ProfPass!${SUFFIX}`,
        role: 'professional',
      },
      expectedStatus: 201,
    });
    assert.equal(res.body.clinicId, SEED.clinicId);
    assert.equal(res.body.role, 'professional');
    return res.body;
  });

  const demoProf = await step('POST /professionals & GET /professionals/:id (RF4)', async () => {
    const created = await http('POST', '/professionals', {
      token: tokens.clinicAdmin,
      body: {
        appUserId: managedUser.appUserId,
        fullName: `Dr. K8s ${SUFFIX}`,
        specialtyIds: [SEED.specialtyId],
      },
      expectedStatus: 201,
    });
    assert.equal(created.body.isActive, true);
    const readDemo = await http('GET', `/professionals/${created.body.professionalId}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.equal(readDemo.body.professionalId, created.body.professionalId);

    const readSeeded = await http('GET', `/professionals/${SEED.professionalId}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.equal(readSeeded.body.professionalId, SEED.professionalId);
    return created.body;
  });

  await step('PUT /professionals/:professionalId/services/:serviceId (RF4 assignment)', async () => {
    await http('PUT', `/professionals/${demoProf.professionalId}/services/${demoService.serviceId}`, {
      token: tokens.clinicAdmin,
      expectedStatus: 204,
    });
  });

  // 04 - Patients (RF14)
  const demoPatient = await step('GET / POST / PATCH /patients (RF14 + audit outbox)', async () => {
    await http('GET', `/patients/${SEED.patientId}`, { token: tokens.receptionist, expectedStatus: 200 });
    const created = await http('POST', '/patients', {
      token: tokens.receptionist,
      body: {
        identification: `K8S-${SUFFIX.slice(0, 16)}`,
        fullName: `K8s Patient ${SUFFIX}`,
        birthDate: '1992-05-15',
        phone: '+50688880000',
        email: `patient.${SUFFIX}@example.invalid`,
      },
      expectedStatus: 201,
    });
    const patientId = created.body.patientId;
    await http('PATCH', `/patients/${patientId}`, {
      token: tokens.receptionist,
      body: { fullName: `K8s Patient Updated ${SUFFIX}`, email: null },
      expectedStatus: 204,
    });
    const fetched = await http('GET', `/patients/${patientId}`, { token: tokens.receptionist, expectedStatus: 200 });
    assert.equal(fetched.body.patientId, patientId);
    return patientId;
  });

  // 05 - Working hours, blocks & availability (RF5-RF8 + Redis)
  await step('GET & PUT /professionals/:id/working-hours (RF5)', async () => {
    const seededWh = await http('GET', `/professionals/${SEED.professionalId}/working-hours`, {
      token: tokens.professional,
      expectedStatus: 200,
    });
    assert.ok(Array.isArray(seededWh.body.workingHours));

    const updatedWh = await http('PUT', `/professionals/${demoProf.professionalId}/working-hours`, {
      token: tokens.clinicAdmin,
      body: {
        workingHours: [
          { weekday: 1, startTime: '08:00', endTime: '12:00' },
          { weekday: 2, startTime: '08:00', endTime: '12:00' },
          { weekday: 3, startTime: '08:00', endTime: '12:00' },
          { weekday: 4, startTime: '08:00', endTime: '12:00' },
          { weekday: 5, startTime: '08:00', endTime: '12:00' },
        ],
      },
      expectedStatus: 200,
    });
    assert.equal(updatedWh.body.workingHours.length, 5);
  });

  await step('GET & POST /professionals/:id/blocks (RF6)', async () => {
    const rangeFrom = new Date(Date.now() + 1 * 86_400_000).toISOString();
    const rangeTo = new Date(Date.now() + 14 * 86_400_000).toISOString();
    await http('GET', `/professionals/${SEED.professionalId}/blocks?from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });

    const blockStart = new Date(Date.now() + 20 * 86_400_000);
    blockStart.setUTCHours(14, 0, 0, 0);
    const blockEnd = new Date(blockStart.getTime() + 3_600_000);
    const createdBlock = await http('POST', `/professionals/${demoProf.professionalId}/blocks`, {
      token: tokens.clinicAdmin,
      body: { startsAt: blockStart.toISOString(), endsAt: blockEnd.toISOString(), reason: 'K8s E2E block' },
      expectedStatus: 201,
    });
    assert.ok(createdBlock.body.block.scheduleBlockId);
  });

  const { dayFrom, dayTo, slotDay, startsA, replacementStartsA } = await step('GET /availability & GET /availability/professionals/:id (RF7 & RF8 + Redis)', async () => {
    const from = addDaysUtc(1);
    const to = addDaysUtc(14);
    const rf8 = await http('GET', `/availability?serviceId=${SEED.serviceId}&from=${from}&to=${to}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.ok(Array.isArray(rf8.body.professionals) && rf8.body.professionals.length > 0);
    const profAvail = rf8.body.professionals.find((p) => p.professionalId === SEED.professionalId) || rf8.body.professionals[0];
    const dayWithTwoSlots = profAvail.days.find((d) => d.slots.length >= 2);
    assert.ok(dayWithTwoSlots, 'Expected at least one future day with >= 2 free slots');

    const rf7 = await http(
      'GET',
      `/availability/professionals/${profAvail.professionalId}?serviceId=${SEED.serviceId}&date=${dayWithTwoSlots.date}`,
      { token: tokens.receptionist, expectedStatus: 200 },
    );
    assert.ok(rf7.body.slots.length >= 2);

    const redisOut = RUNTIME === 'compose'
      ? composeExec('redis', ['redis-cli', '-p', process.env.REDIS_PORT || '6379', '--scan', '--pattern', 'avail:*'],
        { REDISCLI_AUTH: process.env.REDIS_PASSWORD || '' })
      : execFileSync(
        'kubectl',
        ['exec', '-n', NAMESPACE, 'redis-0', '--', 'sh', '-c', 'redis-cli -p "$REDIS_PORT" keys "avail:*"'],
        { encoding: 'utf8' },
      );
    const redisKeys = redisOut.trim().split('\n').filter((key) => key.startsWith('avail:'));
    assert.ok(redisKeys.length > 0, 'Expected Redis to cache availability keys');

    return {
      dayFrom: from,
      dayTo: to,
      slotDay: dayWithTwoSlots.date,
      startsA: rf7.body.slots[0].startsAt,
      replacementStartsA: rf7.body.slots[1].startsAt,
    };
  });

  // 06 - Booking 201 / 409 / 422 and lifecycle (RF9-RF13)
  const appointmentA = await step('POST /appointments (RF9 201) + Redis cache invalidation', async () => {
    const res = await http('POST', '/appointments', {
      token: tokens.receptionist,
      body: {
        professionalId: SEED.professionalId,
        patientId: SEED.patientId,
        serviceId: SEED.serviceId,
        startsAt: startsA,
      },
      expectedStatus: 201,
    });
    assert.equal(res.body.status, 'booked');
    const fetched = await http('GET', `/appointments/${res.body.appointmentId}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.equal(fetched.body.status, 'booked');

    const rf7After = await http(
      'GET',
      `/availability/professionals/${SEED.professionalId}?serviceId=${SEED.serviceId}&date=${slotDay}`,
      { token: tokens.receptionist, expectedStatus: 200 },
    );
    assert.ok(!rf7After.body.slots.some((s) => s.startsAt === startsA), 'Booked slot must disappear from availability');
    return res.body;
  });

  await step('POST /appointments (409 slot_taken & 422 invalid_request)', async () => {
    const conflict = await http('POST', '/appointments', {
      token: tokens.receptionist,
      body: {
        professionalId: SEED.professionalId,
        patientId: SEED.conflictPatientId,
        serviceId: SEED.serviceId,
        startsAt: startsA,
      },
      expectedStatus: 409,
    });
    assert.equal(conflict.body.code, 'slot_taken');

    const invalid = await http('POST', '/appointments', {
      token: tokens.receptionist,
      body: {
        professionalId: SEED.professionalId,
        patientId: SEED.patientId,
        serviceId: SEED.serviceId,
        startsAt: startsA,
        durationMinutes: 60,
      },
      expectedStatus: 422,
    });
    assert.equal(invalid.body.code, 'invalid_request');
  });

  const replacement = await step('POST /appointments/:id/reschedule (RF10) & /cancel (RF11/RF13)', async () => {
    const resched = await http('POST', `/appointments/${appointmentA.appointmentId}/reschedule`, {
      token: tokens.receptionist,
      body: { startsAt: replacementStartsA },
      expectedStatus: 201,
    });
    assert.equal(resched.body.status, 'booked');
    assert.equal(resched.body.rescheduledFromId, appointmentA.appointmentId);

    const cancelled = await http('POST', `/appointments/${resched.body.appointmentId}/cancel`, {
      token: tokens.receptionist,
      body: { reason: 'K8s E2E cancellation' },
      expectedStatus: 200,
    });
    assert.equal(cancelled.body.status, 'cancelled');

    const repeat = await http('POST', `/appointments/${resched.body.appointmentId}/cancel`, {
      token: tokens.receptionist,
      body: { reason: 'Repeat cancel' },
      expectedStatus: 409,
    });
    assert.equal(repeat.body.code, 'invalid_transition');

    const rf7Released = await http(
      'GET',
      `/availability/professionals/${SEED.professionalId}?serviceId=${SEED.serviceId}&date=${slotDay}`,
      { token: tokens.receptionist, expectedStatus: 200 },
    );
    assert.ok(rf7Released.body.slots.some((s) => s.startsAt === startsA), 'Original slot must reappear after reschedule+cancel');
    return resched.body;
  });

  // 07 - Started appointment outcome & clinical note (RF12 & RF15)
  // An outcome needs an appointment that already started, and the API cannot book in the
  // past, so it comes from the seed: 804 on the first run, then any other started booking
  // of dr.mora (the seed leaves some, and more every day as the calendar moves on).
  const started = await step('Find a started booking of dr.mora (seed)', async () => {
    const seeded = await http('GET', `/appointments/${SEED.startedAppointmentId}`, { token: tokens.professional });
    if (seeded.status === 200 && seeded.body.status === 'booked') return seeded.body;
    for (let back = 0; back <= 45; back += 1) {
      const date = addDaysUtc(-back);
      const agenda = await http('GET', `/agenda/professionals/${SEED.professionalId}?date=${date}`, {
        token: tokens.professional,
        expectedStatus: 200,
      });
      const found = agenda.body.appointments.find((a) => a.status === 'booked' && Date.parse(a.startsAt) <= Date.now());
      if (found) return found;
    }
    throw new Error('No started booking of dr.mora is left in the last 45 days: reload the seed (docker compose down -v && docker compose up -d).');
  });

  await step('POST /appointments/:id/outcome (RF12) & POST/GET/PUT /note (RF15)', async () => {
    const before = await http('GET', `/appointments/${started.appointmentId}`, {
      token: tokens.professional,
      expectedStatus: 200,
    });
    assert.equal(before.body.status, 'booked');

    const attended = await http('POST', `/appointments/${started.appointmentId}/outcome`, {
      token: tokens.professional,
      body: { outcome: 'attended' },
      expectedStatus: 200,
    });
    assert.equal(attended.body.status, 'attended');

    const noteCreated = await http('POST', `/appointments/${started.appointmentId}/note`, {
      token: tokens.professional,
      body: { content: `K8s E2E clinical note ${SUFFIX}` },
      expectedStatus: 201,
    });
    assert.equal(noteCreated.body.appointmentId, started.appointmentId);

    const noteRead = await http('GET', `/appointments/${started.appointmentId}/note`, {
      token: tokens.professional,
      expectedStatus: 200,
    });
    assert.equal(noteRead.body.clinicalNoteId, noteCreated.body.clinicalNoteId);

    const noteUpdated = await http('PUT', `/appointments/${started.appointmentId}/note`, {
      token: tokens.professional,
      body: { content: `K8s E2E clinical note updated ${SUFFIX}` },
      expectedStatus: 200,
    });
    assert.ok(noteUpdated.body.content.includes('updated'));

    // Receptionist cannot read clinical notes
    await http('GET', `/appointments/${started.appointmentId}/note`, {
      token: tokens.receptionist,
      expectedStatus: 403,
    });
  });

  // 08 - Operational queries (RF16, RF20, RF21)
  await step('RF16 patient history, RF20 clinic & professional agenda, RF21 counts', async () => {
    const history = await http('GET', `/patients/${SEED.patientId}/appointments`, {
      token: tokens.professional,
      expectedStatus: 200,
    });
    assert.ok(Array.isArray(history.body) && history.body.length > 0);

    const clinicAgenda = await http('GET', `/agenda?date=${slotDay}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.equal(clinicAgenda.body.date, slotDay);

    const profAgenda = await http('GET', `/agenda/professionals/${SEED.professionalId}?date=${slotDay}`, {
      token: tokens.professional,
      expectedStatus: 200,
    });
    assert.equal(profAgenda.body.professionalId, SEED.professionalId);

    const countsFrom = `${dayFrom}T00:00:00Z`;
    const countsTo = `${dayTo}T23:59:59Z`;
    const counts = await http('GET', `/appointments/counts?from=${encodeURIComponent(countsFrom)}&to=${encodeURIComponent(countsTo)}`, {
      token: tokens.receptionist,
      expectedStatus: 200,
    });
    assert.ok(typeof counts.body.total === 'number');
    assert.ok('booked' in counts.body.counts && 'cancelled' in counts.body.counts);
  });

  // 09 - Audit relay (RF18) & query (RF19)
  await step('GET /audit/logs RBAC + RF18 outbox relay delivery verification', async () => {
    await http('GET', '/audit/logs', { token: tokens.receptionist, expectedStatus: 403 });
    await http('GET', '/audit/logs', { token: tokens.platformAdmin, expectedStatus: 403 });

    const allLogs = await http('GET', '/audit/logs', { token: tokens.clinicAdmin, expectedStatus: 200 });
    assert.ok(Array.isArray(allLogs.body) && allLogs.body.length > 0);

    // Wait up to 8s for RF18 audit-relay to copy new users_db and appointments_db outbox events into logs_db
    let patientEvents = [];
    let noteEvents = [];
    const recentFrom = new Date(Date.now() - 10 * 60_000).toISOString();
    const recentTo = new Date(Date.now() + 60_000).toISOString();

    for (let i = 0; i < 16; i += 1) {
      const pLogs = await http('GET', `/audit/logs?patientId=${demoPatient}`, {
        token: tokens.clinicAdmin,
        expectedStatus: 200,
      });
      patientEvents = pLogs.body;

      const nLogs = await http(
        'GET',
        `/audit/logs?userId=${SEED.professionalAppUserId}&patientId=${started.patientId}&from=${encodeURIComponent(recentFrom)}&to=${encodeURIComponent(recentTo)}`,
        { token: tokens.clinicAdmin, expectedStatus: 200 },
      );
      noteEvents = nLogs.body;

      if (patientEvents.length >= 2 && noteEvents.length >= 3) break;
      await delay(500);
    }

    assert.ok(
      patientEvents.some((e) => e.resource === 'patient_contact' && e.action === 'create')
        && patientEvents.some((e) => e.resource === 'patient_contact' && e.action === 'update'),
      `Expected patient_contact create+update audit events from users_db relay, got: ${JSON.stringify(patientEvents)}`,
    );
    assert.ok(
      noteEvents.some((e) => e.resource === 'clinical_note' && e.action === 'create')
        && noteEvents.some((e) => e.resource === 'clinical_note' && e.action === 'read')
        && noteEvents.some((e) => e.resource === 'clinical_note' && e.action === 'update'),
      `Expected clinical_note create+read+update audit events from appointments_db relay, got: ${JSON.stringify(noteEvents)}`,
    );
  });

  // 90 - User management cleanup (RF2 PUT role + DELETE user)
  await step('PUT /users/:id/role & DELETE /users/:id (RF2)', async () => {
    await http('PUT', `/users/${managedUser.appUserId}/role`, {
      token: tokens.clinicAdmin,
      body: { role: 'receptionist' },
      expectedStatus: 204,
    });
    await http('DELETE', `/users/${managedUser.appUserId}`, {
      token: tokens.clinicAdmin,
      expectedStatus: 204,
    });
  });

  console.log(`\nALL ${passed} END-TO-END ENDPOINT SUITES PASSED!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
