import type { Request } from 'express';

// Request-local provenance, never exported from the package's public entry point.
const verifiedRoles = new WeakMap<Request, readonly string[]>();

export function clearVerifiedRoles(req: Request): void {
  verifiedRoles.delete(req);
}

export function recordVerifiedRoles(req: Request, roles: unknown): void {
  clearVerifiedRoles(req);
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) return;
  verifiedRoles.set(req, Object.freeze([...roles]));
}

export function getVerifiedRoles(req: Request): readonly string[] | undefined {
  return verifiedRoles.get(req);
}
