import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Request, Response, NextFunction } from "express";
import { clearVerifiedRoles, recordVerifiedRoles } from './verified-identity.ts';
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

export interface UsuarioAutenticado {
    id: string;
    username: string;
    roles: string[];
}

declare module "express-serve-static-core" {
    interface Request {
        usuario?: UsuarioAutenticado;
    }
}


// 401: valida que venga un token y que sea valido de verdad (firma, expiracion, emisor)
export async function requiereToken(req: Request, res: Response, next: NextFunction) {
  clearVerifiedRoles(req);
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

    req.usuario = {
      id: payload.sub,
      username: payload.preferred_username as string,
      roles: (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [],
    };

    const tokenRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    recordVerifiedRoles(req, tokenRoles === undefined ? [] : tokenRoles);
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
    if (!req.usuario?.roles.includes(rol)) {
      return res.status(403).json({ error: `falta el rol '${rol}'` });
    }
    next();
  };
}
