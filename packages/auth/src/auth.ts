import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";
import { clearVerifiedRoles, getVerifiedRoles, recordVerifiedRoles } from './verified-identity.ts';
import { AuthConfigurationError, readAuthConfig } from './config.ts';

// no se arma al importar el archivo, solo la primera vez que hace falta validar un token de verdad
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedJwksUrl: string | undefined;

function obtenerJwks(url: URL) {
    if (!jwks || cachedJwksUrl !== url.href) {
        jwks = createRemoteJWKSet(
            url
        );
        cachedJwksUrl = url.href;
    }
    return jwks;
}

export const APP_ROLES = ['platform_admin', 'clinic_admin', 'receptionist', 'professional'] as const;
export type AppRole = (typeof APP_ROLES)[number];

export interface TenantContext {
    clinicId: string | null;
    userId: string;
    role: AppRole;
    professionalId?: string | null;
}

export interface UsuarioAutenticado {
    id: string;
    username: string;
    roles: string[];
    clinicId?: string | null;
    userId?: string;
    role?: AppRole;
    professionalId?: string | null;
    tenantContext?: TenantContext;
}

declare module "express-serve-static-core" {
    interface Request {
        usuario?: UsuarioAutenticado;
    }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(val: unknown): val is string {
    return typeof val === 'string' && UUID_REGEX.test(val);
}

export function extractTenantContext(req: Request): TenantContext | null {
    return req.usuario?.tenantContext ?? null;
}


// 401: valida que venga un token y que sea valido de verdad (firma, expiracion, emisor)
export async function requiereToken(req: Request, res: Response, next: NextFunction) {
  clearVerifiedRoles(req);
  delete req.usuario;
  const authHeader = req.headers.authorization;

  // si no viene con "Bearer " ni vale la pena intentar verificarlo
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "falta el token de acceso" });
  }

  const token = authHeader.slice("Bearer ".length);

  try {
    // el issuer tiene que ser el mismo que usa el frontend para pedir el token,
    // no la url interna de docker (esa es solo para buscar las llaves)
    const config = readAuthConfig();
    const { payload } = await jwtVerify(token, obtenerJwks(config.jwksUrl), {
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ['exp', 'sub'],
    });

    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('Invalid token subject.');
    }

    const tokenRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = recordVerifiedRoles(req, tokenRoles === undefined ? [] : tokenRoles);
    if (roles === undefined) {
      throw new Error('Invalid token roles.');
    }

    const clinicIdClaim = payload.clinic_id as string | undefined;
    const userIdClaim = (payload.app_user_id ?? payload.user_id) as string | undefined;
    const professionalIdClaim = payload.professional_id as string | undefined;

    let domainRole: AppRole | undefined;
    if (typeof payload.role === 'string' && (APP_ROLES as readonly string[]).includes(payload.role)) {
      domainRole = payload.role as AppRole;
    } else {
      domainRole = roles.find((r): r is AppRole => (APP_ROLES as readonly string[]).includes(r));
    }

    let tenantContext: TenantContext | undefined;
    if (domainRole && isUuid(userIdClaim)) {
      if (domainRole === 'platform_admin' && (clinicIdClaim === undefined || clinicIdClaim === null || clinicIdClaim === '')) {
        tenantContext = {
          clinicId: null,
          userId: userIdClaim,
          role: 'platform_admin',
        };
      } else if (domainRole === 'professional' && isUuid(clinicIdClaim) && isUuid(professionalIdClaim)) {
        tenantContext = {
          clinicId: clinicIdClaim,
          userId: userIdClaim,
          role: 'professional',
          professionalId: professionalIdClaim,
        };
      } else if ((domainRole === 'clinic_admin' || domainRole === 'receptionist') && isUuid(clinicIdClaim)) {
        tenantContext = {
          clinicId: clinicIdClaim,
          userId: userIdClaim,
          role: domainRole,
        };
      }
    }

    req.usuario = {
      id: payload.sub,
      username: (payload.preferred_username as string) ?? '',
      roles: [...roles],
      clinicId: domainRole === 'platform_admin' ? null : (clinicIdClaim ?? null),
      userId: userIdClaim,
      role: domainRole,
      professionalId: professionalIdClaim ?? null,
      tenantContext,
    };

    next();
  } catch (error) {
    const configurationFailed = error instanceof AuthConfigurationError;
    console.error(JSON.stringify({
      level: 'error',
      event: configurationFailed ? 'auth_configuration_invalid' : 'jwt_verification_failed',
    }));
    if (configurationFailed) {
      return res.status(500).json({ error: 'Authentication unavailable.' });
    }
    return res.status(401).json({ error: "token inválido o expirado" });
  }
}

// 403: el token es valido pero no trae el rol que la ruta exige
export function requiereRol(rol: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const roles = getVerifiedRoles(req);
    if (roles === undefined) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!roles.includes(rol)) {
      return res.status(403).json({ error: `falta el rol '${rol}'` });
    }
    next();
  };
}

// Requiere que el token sea valido y contenga las declaraciones de contexto multitenant (clinic_id, app_user_id, rol)
export async function requiereTenantContext(req: Request, res: Response, next: NextFunction) {
  const proceed = () => {
    const ctx = extractTenantContext(req);
    if (!ctx) {
      return res.status(401).json({ error: 'Tenant context required.' });
    }
    res.locals.tenant = ctx;
    next();
  };

  if (req.usuario) {
    return proceed();
  }
  return requiereToken(req, res, proceed);
}
