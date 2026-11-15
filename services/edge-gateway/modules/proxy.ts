import http from 'node:http';
import https from 'node:https';
import type { Request, RequestHandler, Response } from 'express';
import { logger } from '@medicitas/http';

// The single public entry point (card I3). It does not decide anything: it picks the
// service that owns the path and forwards the request as it came, Authorization
// included. Every service verifies the token itself (RF17), so a request that skipped
// the gateway would be checked just the same.

export type ServiceName = 'clinics' | 'users' | 'appointments' | 'audit';
export type Upstreams = Partial<Record<ServiceName, URL>>;

const ENV: Record<ServiceName, string> = {
  clinics: 'CLINICS_SERVICE_URL',
  users: 'USERS_SERVICE_URL',
  appointments: 'APPOINTMENTS_SERVICE_URL',
  audit: 'AUDIT_SERVICE_URL',
};

/**
 * Public path -> owning service, first match wins. Two prefixes are shared, so the more
 * specific rule goes first: a professional's schedule and a patient's appointment history
 * live in appointments-service, the profiles themselves in users-service.
 */
const ROUTES: ReadonlyArray<{ pattern: RegExp; service: ServiceName }> = [
  { pattern: /^\/professionals\/[^/]+\/(working-hours|blocks|services)(\/|$)/, service: 'appointments' },
  { pattern: /^\/patients\/[^/]+\/appointments(\/|$)/, service: 'appointments' },
  { pattern: /^\/(appointments|availability|agenda)(\/|$)/, service: 'appointments' },
  { pattern: /^\/(professionals|patients|users)(\/|$)/, service: 'users' },
  { pattern: /^\/(clinics|clinic|services|specialties)(\/|$)/, service: 'clinics' },
  { pattern: /^\/audit(\/|$)/, service: 'audit' },
];

export function serviceFor(path: string): ServiceName | undefined {
  return ROUTES.find((route) => route.pattern.test(path))?.service;
}

/** Reads the four service URLs. A missing one only disables its routes (503). */
export function readUpstreams(env: NodeJS.ProcessEnv = process.env): Upstreams {
  const upstreams: Upstreams = {};
  for (const [service, name] of Object.entries(ENV) as Array<[ServiceName, string]>) {
    const value = env[name];
    if (!value) continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
    }
    upstreams[service] = url;
  }
  return upstreams;
}

// Hop-by-hop headers belong to one connection and are never forwarded (RFC 9110, 7.6.1).
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host',
  // Only tests inject a context; nothing from outside may carry one inward.
  'x-test-context',
]);

function forwardHeaders(req: Request): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  const previous = req.headers['x-forwarded-for'];
  headers['x-forwarded-for'] = [previous, req.socket.remoteAddress].filter(Boolean).join(', ');
  headers['x-forwarded-proto'] = req.protocol;
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;
  return headers;
}

function fail(res: Response, status: 502 | 503 | 504, code: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (status === 503) res.set('Retry-After', '1');
  res.status(status).json({ error: 'Service unavailable.', code });
}

/** Forwards every request whose path belongs to a service; the rest falls through. */
export function createProxy(upstreams: Upstreams, timeoutMs = 15_000): RequestHandler {
  return (req, res, next) => {
    const service = serviceFor(req.path);
    if (service === undefined) {
      next();
      return;
    }
    const base = upstreams[service];
    if (base === undefined) {
      fail(res, 503, 'upstream_not_configured');
      return;
    }

    // Keep the path and the query exactly as received, under the service's base path.
    const target = new URL(base.pathname.replace(/\/$/, '') + req.originalUrl, base);
    const client = target.protocol === 'https:' ? https : http;
    const upstream = client.request(target, { method: req.method, headers: forwardHeaders(req), timeout: timeoutMs });

    upstream.on('response', (reply) => {
      const headers: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(reply.headers)) {
        if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
      }
      res.writeHead(reply.statusCode ?? 502, headers);
      reply.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(Object.assign(new Error('Upstream timeout.'), { code: 'ETIMEDOUT' })));
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      // Never the target URL or the error text: they describe the internal network.
      logger.error(`Upstream ${service} unavailable.`);
      fail(res, error.code === 'ETIMEDOUT' ? 504 : 502, error.code === 'ETIMEDOUT' ? 'upstream_timeout' : 'upstream_unavailable');
    });
    // The client gave up: stop the upstream request too.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });

    req.pipe(upstream);
  };
}
