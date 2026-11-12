import type { Request, RequestHandler, Response } from 'express';
import type { TenantContext } from '@medicitas/db';

// Production must resolve an already verified identity (N3/J1), never client headers.
// Tests inject a resolver; this interface is not an authentication implementation.
export type ContextResolver = (req: Request) => TenantContext | null;

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
  if (ctx === undefined) throw new Error('requireTenantContext must run before this handler.');
  return ctx;
}
