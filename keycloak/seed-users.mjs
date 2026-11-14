// Idempotently imports demo domain users from seed-users.json into an existing
// Keycloak realm via the Admin REST Partial Import API.
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_ATTEMPTS = 15;
const RETRY_DELAY_MS = 2000;
const PASSWORD_PLACEHOLDER = '${KEYCLOAK_TEST_PASSWORD}';

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadUsers(seedPassword) {
  const raw = readFileSync(new URL('./seed-users.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.users)) {
    throw new Error('seed-users.json must contain a "users" array.');
  }
  return parsed.users.map((user) => ({
    ...user,
    credentials: Array.isArray(user.credentials)
      ? user.credentials.map((cred) => ({
          ...cred,
          value: cred.value === PASSWORD_PLACEHOLDER ? seedPassword : cred.value,
        }))
      : [],
  }));
}

async function fetchAdminToken(baseUrl, username, password) {
  const tokenUrl = `${baseUrl}/realms/master/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username,
    password,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(tokenUrl, { method: 'POST', body });
      if (response.ok) {
        const data = await response.json();
        if (typeof data.access_token === 'string' && data.access_token.length > 0) {
          return data.access_token;
        }
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Admin token request failed with HTTP ${response.status}`);
      }
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error;
    }
    await delay(RETRY_DELAY_MS);
  }
  throw new Error('Failed to obtain Keycloak admin token.');
}

async function ensureRealmReady(baseUrl, realmName, token) {
  const realmUrl = `${baseUrl}/admin/realms/${encodeURIComponent(realmName)}`;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(realmUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.ok) return;
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(`Realm "${realmName}" not ready (HTTP ${response.status}).`);
    }
    await delay(RETRY_DELAY_MS);
  }
}

async function runPartialImport(baseUrl, realmName, token, users, ifResourceExists) {
  const importUrl = `${baseUrl}/admin/realms/${encodeURIComponent(realmName)}/partialImport`;
  const response = await fetch(importUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ifResourceExists, users }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Partial import failed (HTTP ${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function main() {
  const baseUrl = requiredEnv('KEYCLOAK_INTERNAL_URL').replace(/\/+$/, '');
  const adminUser = requiredEnv('KEYCLOAK_ADMIN_USERNAME');
  const adminPassword = requiredEnv('KEYCLOAK_ADMIN_PASSWORD');
  const realmName = requiredEnv('REALM_NAME');
  const seedPassword = requiredEnv('KEYCLOAK_TEST_PASSWORD');
  const conflictPolicy = process.argv.includes('--overwrite')
    ? 'OVERWRITE'
    : (process.env.KEYCLOAK_SEED_CONFLICT || 'SKIP');

  const users = loadUsers(seedPassword);
  const token = await fetchAdminToken(baseUrl, adminUser, adminPassword);
  await ensureRealmReady(baseUrl, realmName, token);
  const summary = await runPartialImport(baseUrl, realmName, token, users, conflictPolicy);

  console.log(
    JSON.stringify({
      event: 'keycloak_users_seeded',
      realm: realmName,
      ifResourceExists: conflictPolicy,
      added: summary.added ?? 0,
      skipped: summary.skipped ?? 0,
      overwritten: summary.overwritten ?? 0,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
