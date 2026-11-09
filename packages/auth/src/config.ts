export class AuthConfigurationError extends Error {
  constructor() {
    super('Invalid authentication configuration.');
    this.name = 'AuthConfigurationError';
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AuthConfigurationError();
  return value;
}

function httpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new AuthConfigurationError();
    }
    return url;
  } catch {
    throw new AuthConfigurationError();
  }
}

export function readAuthConfig() {
  const issuer = required('KEYCLOAK_ISSUER');
  httpUrl(issuer);
  const audience = required('KEYCLOAK_AUDIENCE');
  const baseUrl = httpUrl(required('KEYCLOAK_INTERNAL_URL')).href.replace(/\/$/, '');
  const realm = required('REALM_NAME');
  const jwksUrl = new URL(`${baseUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`);
  return { issuer, audience, jwksUrl };
}
