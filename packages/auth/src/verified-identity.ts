import type { Request } from 'express';

// Request-local provenance, never exported from the package's public entry point.
const verifiedRoles = new WeakMap<Request, readonly string[]>();

export function clearVerifiedRoles(req: Request): void {
  verifiedRoles.delete(req);
}

export function recordVerifiedRoles(req: Request, roles: unknown): readonly string[] | undefined {
  clearVerifiedRoles(req);
  if (!Array.isArray(roles) || !roles.every((role) => typeof role === 'string')) return;
  const snapshot = Object.freeze([...roles]);
  verifiedRoles.set(req, snapshot);
  return snapshot;
}

export function getVerifiedRoles(req: Request): readonly string[] | undefined {
  return verifiedRoles.get(req);
}
