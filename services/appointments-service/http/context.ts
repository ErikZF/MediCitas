import type { Request, RequestHandler, Response } from 'express';
import type { TenantContext } from '@medicitas/db';

/**
 * Builds the tenant context of a request. In production it reads the verified token
 * claims (clinic_id, app_user_id, professional_id; cards N3 and J1); tests inject their own.
 * Returns null when the request carries no usable identity.
 */
export type ContextResolver = (req: Request) => TenantContext | null;

/** 401 when the request has no identity; otherwise stores the context for the handlers. */
export function requireTenantContext(resolve: ContextResolver): RequestHandler {
  return (req, res, next) => {
    const ctx = resolve(req);
    if (ctx === null) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    res.locals.tenant = ctx;
    next();
  };
}

export function tenantOf(res: Response): TenantContext {
  const ctx = res.locals.tenant as TenantContext | undefined;
  if (ctx === undefined) {
    throw new Error('requireTenantContext must run before this handler.');
  }
  return ctx;
}
