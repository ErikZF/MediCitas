#!/usr/bin/env node
// Every test of the repository with one command. Needs Docker and nothing else:
// no database to prepare, no variable to export.
//
//   npm run test:all                  build, unit + integration + race tests, then end-to-end
//   npm run test:all -- --no-e2e      skip the end-to-end stage
//   npm run test:all -- --only-e2e    only the end-to-end stage (same as npm run test:e2e)
//   npm run test:all -- --external    use TEST_DATABASE_URL and TEST_REDIS_URL already set (CI)
//   npm run test:all -- --keep        leave the test containers running afterwards
//
// Stage 1 runs the vitest suites of every workspace against a throwaway PostgreSQL 18
// and Redis (docker-compose.test.yml). Each suite creates its own databases there.
// Stage 2 runs deploy/scripts/test-all-endpoints.mjs through the gateway of the demo
// stack (docker-compose.yml, configured by .env). It first runs `docker compose up -d --build`,
// so the stack always runs the code of this checkout: an older running stack would test old code.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const RESULTS = join(ROOT, 'test-results');
const TEST_COMPOSE = ['compose', '-f', 'docker-compose.test.yml'];
const WORKSPACES = [
  'packages/auth', 'packages/db', 'packages/http',
  'services/edge-gateway', 'services/clinics-service', 'services/users-service',
  'services/appointments-service', 'services/audit-service',
];

const KNOWN = ['--no-e2e', '--only-e2e', '--external', '--keep'];
const args = process.argv.slice(2);
const unknown = args.filter((a) => !KNOWN.includes(a));
if (unknown.length > 0) {
  console.error(`Unknown option(s): ${unknown.join(' ')}. Known: ${KNOWN.join(' ')}`);
  process.exit(2);
}
const flags = {
  suites: !args.includes('--only-e2e'),
  e2e: !args.includes('--no-e2e'),
  external: args.includes('--external'),
  keep: args.includes('--keep'),
};

const banner = (text) => console.log(`\n=== ${text} ${'='.repeat(Math.max(0, 74 - text.length))}\n`);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Through `npm run`, npm_execpath points to npm's own script: calling it with node
// needs no shell, so paths with spaces (common on Windows) need no quoting.
function npm(npmArgs, options = {}) {
  const cli = process.env.npm_execpath;
  if (cli && /\.[cm]?js$/.test(cli)) return run(process.execPath, [cli, ...npmArgs], options);
  const windows = process.platform === 'win32';
  return run(windows ? 'npm.cmd' : 'npm', npmArgs, { shell: windows, ...options });
}

function docker(dockerArgs, options = {}) {
  try {
    return run('docker', dockerArgs, options);
  } catch {
    throw new Error('Docker is not available. Install Docker (Desktop) and start it.');
  }
}

// ---------------------------------------------------------------------------
// Stage 1: unit, integration and race tests of every workspace
// ---------------------------------------------------------------------------
const rows = [];
let startedContainers = false;

function counts(file) {
  try {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    return {
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      skipped: report.numPendingTests + report.numTodoTests,
    };
  } catch {
    return { passed: '?', failed: '?', skipped: '?' };
  }
}

function suites() {
  const env = { ...process.env };
  if (flags.external) {
    if (!env.TEST_DATABASE_URL || !env.TEST_REDIS_URL) {
      throw new Error('--external needs TEST_DATABASE_URL and TEST_REDIS_URL.');
    }
  } else {
    banner('Starting PostgreSQL 18 and Redis for the tests (docker-compose.test.yml)');
    startedContainers = true;
    if (docker([...TEST_COMPOSE, 'up', '-d', '--wait']) !== 0) {
      throw new Error('The test containers did not start. Is Docker running? Are ports 55432 and 56379 free?');
    }
    // 127.0.0.1 and not localhost: on some machines localhost resolves to ::1 first.
    env.TEST_DATABASE_URL = `postgres://test:test_password@127.0.0.1:${env.TEST_POSTGRES_PORT || 55432}/postgres`;
    env.TEST_REDIS_URL = `redis://127.0.0.1:${env.TEST_REDIS_PORT || 56379}`;
  }

  banner('Building the packages and the services');
  if (npm(['run', 'build']) !== 0) throw new Error('The build failed.');

  rmSync(RESULTS, { recursive: true, force: true });
  mkdirSync(RESULTS, { recursive: true });
  for (const workspace of WORKSPACES) {
    banner(workspace);
    const file = join(RESULTS, `${workspace.replace('/', '-')}.json`);
    const code = npm(['test', '-w', workspace, '--', '--reporter=default', '--reporter=json', `--outputFile.json=${file}`], { env });
    rows.push({ name: workspace, ok: code === 0, ...counts(file) });
  }
}

// ---------------------------------------------------------------------------
// Stage 2: end-to-end through the gateway of the Compose stack
// ---------------------------------------------------------------------------
async function stackReady(gateway, keycloak) {
  try {
    const health = await fetch(`${gateway}/health`, { signal: AbortSignal.timeout(3000) });
    if (!health.ok) return false;
    // Keycloak is up and the seed job already imported the demo users.
    const token = await fetch(`${keycloak}/realms/${encodeURIComponent(process.env.REALM_NAME)}/protocol/openid-connect/token`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.KEYCLOAK_TEST_CLIENT_ID,
        username: 'reception.sj',
        password: process.env.KEYCLOAK_TEST_PASSWORD,
      }),
    });
    return token.ok;
  } catch {
    return false;
  }
}

async function e2e() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) {
    throw new Error('The end-to-end stage uses the demo stack: copy .env.example to .env first (see the README).');
  }
  process.loadEnvFile(envFile);
  const gateway = `http://localhost:${process.env.API_PORT || 3000}`;
  const keycloak = `http://localhost:${process.env.KEYCLOAK_PORT || 8080}`;

  // Rebuilds only what changed and recreates only the containers whose image changed;
  // the databases and their data stay.
  banner('Bringing the demo stack up to date (docker compose up -d --build)');
  if (docker(['compose', 'up', '-d', '--build']) !== 0) throw new Error('docker compose up failed.');
  const deadline = Date.now() + 10 * 60_000;
  process.stdout.write('Waiting for the gateway, Keycloak and the user seed');
  while (!(await stackReady(gateway, keycloak))) {
    if (Date.now() > deadline) throw new Error('The stack was not ready after 10 minutes: docker compose ps -a');
    process.stdout.write('.');
    await delay(5000);
  }
  process.stdout.write(' ready\n');

  banner(`End-to-end through ${gateway}`);
  const code = run(process.execPath, ['deploy/scripts/test-all-endpoints.mjs'], {
    env: { ...process.env, E2E_RUNTIME: 'compose', GATEWAY_URL: gateway, KEYCLOAK_URL: keycloak },
  });
  rows.push({ name: 'end-to-end (Compose stack)', ok: code === 0, passed: code === 0 ? 'all' : '', failed: code === 0 ? 0 : 'yes', skipped: 0 });
}

// ---------------------------------------------------------------------------
let error = null;
try {
  if (flags.suites) suites();
  if (flags.e2e) await e2e();
} catch (e) {
  error = e;
} finally {
  if (startedContainers && !flags.keep) {
    banner('Removing the test containers');
    docker([...TEST_COMPOSE, 'down', '-v', '--remove-orphans']);
  }
}

if (rows.length > 0) {
  banner('Summary');
  const pad = (v, n) => String(v).padStart(n);
  console.log(`${'Suite'.padEnd(34)}${pad('passed', 8)}${pad('failed', 8)}${pad('skipped', 9)}`);
  for (const r of rows) console.log(`${r.name.padEnd(34)}${pad(r.passed, 8)}${pad(r.failed, 8)}${pad(r.skipped, 9)}${r.ok ? '' : '   <- FAILED'}`);
  const total = rows.filter((r) => typeof r.passed === 'number').reduce((acc, r) => acc + r.passed, 0);
  console.log(`\n${total} tests passed in the workspace suites. Reports: test-results/`);
}
if (error) console.error(`\n${error.message}`);
const failed = Boolean(error) || rows.some((r) => !r.ok);
console.log(!failed ? '\nALL TESTS PASSED' : rows.some((r) => !r.ok) ? '\nSOME TESTS FAILED' : '\nTHE TESTS COULD NOT RUN');
process.exit(failed ? 1 : 0);
