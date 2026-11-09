import type { RequestHandler } from 'express';
import { hasPermission, type Permission } from './permissions.ts';
import { getVerifiedRoles } from './verified-identity.ts';

/** Requires requiereToken first, resource ownership remains a domain concern. */
export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    const roles = getVerifiedRoles(req);
    if (roles === undefined) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!roles.some((role) => hasPermission(role, permission))) {
      res.status(403).json({ error: 'Permission denied.' });
      return;
    }
    next();
  };
}
