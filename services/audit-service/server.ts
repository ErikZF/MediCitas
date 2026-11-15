import { createDatabase, readDbConfig } from '@medicitas/db';
import { logger, startServer } from '@medicitas/http';
import { createApp } from './app.ts';
import { startAuditRelay, type RelaySource } from './modules/audit-relay/audit-relay.ts';

try {
  const { db } = createDatabase(readDbConfig('DB_LOGS', 'audit-service'));
  // RF18: copy the AuditRecorded events of each producer's outbox into audit_log.
  // A source without configuration is simply not relayed (for example in local runs).
  const sources: RelaySource[] = [];
  for (const [name, prefix] of [['appointments', 'DB_APPOINTMENTS'], ['users', 'DB_USERS']] as const) {
    if (process.env[`${prefix}_HOST`]) {
      sources.push({ name, db: createDatabase(readDbConfig(prefix, 'audit-relay')).db });
    }
  }
  if (sources.length > 0) startAuditRelay(sources, db);
  // No context override: createApp requires a verified Bearer token for RF19.
  startServer(createApp({ auditQuery: { db } }));
} catch {
  logger.error('Audit database configuration is invalid.');
  process.exitCode = 1;
}
