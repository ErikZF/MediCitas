import { z } from 'zod';

export type ClinicRole = 'clinic_admin' | 'professional' | 'receptionist';
export interface Assignment { clinicId: string; appUserId: string; role: ClinicRole; professionalId?: string }
export interface IdentityAdmin {
  create(username: string, password: string, assignment: Assignment): Promise<string>;
  assign(sub: string, assignment: Assignment): Promise<void>;
  enabled(sub: string, enabled: boolean): Promise<void>;
  logout(sub: string): Promise<void>;
  remove(sub: string): Promise<void>;
}
const unavailable = () => Object.assign(new Error('Identity provider unavailable'), { status: 503, code: 'identity_unavailable' });
const roleList = z.array(z.object({ id: z.string().min(1), name: z.string() }));
function attributes(a: Assignment) {
  return { app_user_id: [a.appUserId], clinic_id: [a.clinicId], role: [a.role],
    ...(a.professionalId ? { professional_id: [a.professionalId] } : {}) };
}

export function keycloakAdmin(env = process.env): IdentityAdmin {
  async function request(path: string, method: string, status: number, body?: unknown) {
    try {
      const { KEYCLOAK_USER_ADMIN_SECRET: secret, REALM_NAME: realm } = env;
      if (!secret || !realm || secret.includes('${')) throw unavailable();
      const base = new URL(env.KEYCLOAK_INTERNAL_URL ?? '');
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash || base.search) throw unavailable();
      const root = base.href.replace(/\/$/, '');
      const options = { redirect: 'error' as const, signal: AbortSignal.timeout(5000) };
      const token = await fetch(root + '/realms/' + encodeURIComponent(realm) + '/protocol/openid-connect/token', {
        ...options, method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'medicitas-user-admin', client_secret: secret }),
      });
      if (token.status !== 200) throw unavailable();
      const { access_token } = z.object({ access_token: z.string().min(1) }).parse(await token.json());
      const response = await fetch(root + '/admin/realms/' + encodeURIComponent(realm) + path, {
        ...options, method, headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (path === '/users' && response.status === 409) throw Object.assign(new Error('Username already exists'), { status: 409, code: 'username_taken' });
      if (response.status !== status) throw unavailable();
      return response;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'username_taken') throw error;
      throw unavailable();
    }
  }
  const user = (sub: string) => '/users/' + z.uuid().parse(sub);
  async function roles(path: string) {
    try { return roleList.parse(await (await request(path, 'GET', 200)).json()); }
    catch { throw unavailable(); }
  }
  return {
    async create(username, password, a) {
      const response = await request('/users', 'POST', 201, { username, enabled: false, attributes: attributes(a),
        credentials: [{ type: 'password', value: password, temporary: true }] });
      const location = response.headers.get('location');
      const sub = z.uuid().safeParse(location?.split('/').pop());
      if (!sub.success) throw unavailable();
      return sub.data;
    },
    async assign(sub, a) {
      const path = user(sub) + '/role-mappings/realm';
      const current = await roles(path);
      const previous = current.filter(r => ['professional','clinic_admin','receptionist','platform_admin'].includes(r.name) && r.name !== a.role);
      if (previous.length) await request(path, 'DELETE', 204, previous);
      if (!current.some(r => r.name === a.role)) {
        const wanted = (await roles(path + '/available')).find(r => r.name === a.role);
        if (!wanted) throw unavailable();
        await request(path, 'POST', 204, [wanted]);
      }
      await request(user(sub), 'PUT', 204, { attributes: attributes(a) });
    },
    async enabled(sub, enabled) { await request(user(sub), 'PUT', 204, { enabled }); },
    async logout(sub) { await request(user(sub) + '/logout', 'POST', 204); },
    async remove(sub) { await request(user(sub), 'DELETE', 204); },
  };
}
