// Auth middleware: verifies kw_at access JWT, loads user, enforces roles/status.
import type { MiddlewareHandler } from 'hono';
import { verifyAccessToken } from './lib/tokens.js';
import { getCookie, fail, type AppContext } from './lib/http.js';
import { queryOne } from './lib/db.js';
import type { AuthedUser } from './types.js';

export async function loadUser(db: AppContext['env']['DB'], userId: string): Promise<AuthedUser | null> {
  const row = await queryOne<Record<string, unknown>>(
    db, 'SELECT id, phone_e164, country_code, display_name, roles, status FROM users WHERE id = ?', userId
  );
  if (!row) return null;
  return {
    id: String(row.id),
    phone_e164: String(row.phone_e164),
    country_code: String(row.country_code),
    display_name: String(row.display_name),
    roles: JSON.parse(String(row.roles)) as string[],
    status: String(row.status),
  };
}

export function requireAuth(): MiddlewareHandler {
  return async (c, next) => {
    const token = getCookie(c, 'kw_at');
    if (!token) return fail(c, 'unauthorized', 'Sign in to continue.', 401);
    const claims = await verifyAccessToken(c.env.JWT_SECRET, token);
    if (!claims) return fail(c, 'unauthorized', 'Session expired. Sign in again.', 401);
    // Session-bound tokens: logout/revocation takes effect immediately (threat #9).
    const sess = await queryOne<{ revoked_at: number | null; expires_at: number; created_at: number }>(
      c.env.DB, 'SELECT revoked_at, expires_at, created_at FROM auth_sessions WHERE id = ?', claims.sid);
    if (!sess || sess.revoked_at || sess.expires_at <= Math.floor(Date.now() / 1000)) {
      return fail(c, 'unauthorized', 'Session expired. Sign in again.', 401);
    }
    c.set('sessionCreatedAt', sess.created_at);
    const user = await loadUser(c.env.DB, claims.sub);
    if (!user) return fail(c, 'unauthorized', 'Account not found.', 401);
    if (user.status === 'suspended') return fail(c, 'account_suspended', 'Your account is paused while we review it. Payouts are on hold — your balance is safe.', 403);
    if (user.status === 'banned') return fail(c, 'account_banned', 'This account was closed for breaking the fair-watch rules.', 403);
    c.set('userId', user.id);
    c.set('userRoles', user.roles);
    (c as unknown as { _authedUser: AuthedUser })._authedUser = user;
    await next();
  };
}

export function authedUser(c: AppContext): AuthedUser {
  return (c as unknown as { _authedUser: AuthedUser })._authedUser;
}

export function requireRole(role: 'advertiser' | 'admin'): MiddlewareHandler {
  return async (c, next) => {
    const roles = c.get('userRoles') ?? [];
    if (!roles.includes(role)) return fail(c, 'forbidden', `This needs the ${role} role.`, 403);
    await next();
  };
}
