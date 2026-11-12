import { Redis } from 'ioredis';
import { RedisAgendaCache, type AgendaCache } from './agenda-cache.ts';

/**
 * A Redis client tuned to fail fast: a cache that waits is worse than no cache.
 * Commands time out quickly and are not queued while disconnected, so the circuit
 * breaker sees the failure and availability falls back to PostgreSQL.
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    commandTimeout: 250,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // Without a listener a lost connection would crash the process; reconnection is automatic.
  client.on('error', () => {});
  return client;
}

/** CACHE_ENABLED=false or no REDIS_URL: no cache, every read goes to PostgreSQL. */
export function agendaCacheFromEnv(env: NodeJS.ProcessEnv = process.env): AgendaCache | undefined {
  if (env.CACHE_ENABLED === 'false' || !env.REDIS_URL) return undefined;
  return new RedisAgendaCache(createRedisClient(env.REDIS_URL), {
    ttlSeconds: env.CACHE_TTL_SECONDS ? Number(env.CACHE_TTL_SECONDS) : undefined,
  });
}
