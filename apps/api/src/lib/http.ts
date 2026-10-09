// HTTP helpers: JSON envelope, error codes, cookies.
import type { Context } from 'hono';
import type { Env, ReqVars } from '../types.js';
import { randomTokenHex } from './crypto.js';

export type AppContext = Context<{ Bindings: Env; Variables: ReqVars }>;

export function newRequestId(): string {
  return randomTokenHex(8);
}

export function ok<T>(c: AppContext, data: T, status: 200 | 201 | 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 = 200): Response {
  return c.json({ data }, status);
}

export function fail(
  c: AppContext, code: string, message: string,
  status: 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 = 400
): Response {
  const requestId = c.get('requestId') ?? 'unknown';
  return c.json({ error: { code, message, request_id: requestId } }, status);
}

export function setAuthCookies(
  c: AppContext, access: string, refresh: string | null, refreshMaxAgeSec: number
): void {
  const secure = c.get('isSecure');
  const base = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const cookies = [`kw_at=${access}; Max-Age=900; ${base}`];
  if (refresh) cookies.push(`kw_rt=${refresh}; Max-Age=${refreshMaxAgeSec}; ${base}`);
  // Hono: append multiple Set-Cookie headers
  for (const ck of cookies) c.header('Set-Cookie', ck, { append: true });
}

export function clearAuthCookies(c: AppContext): void {
  const secure = c.get('isSecure');
  const base = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`;
  c.header('Set-Cookie', `kw_at=; ${base}`, { append: true });
  c.header('Set-Cookie', `kw_rt=; ${base}`, { append: true });
}

export function getCookie(c: AppContext, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function maskPhone(e164: string): string {
  // "+234 7•• ••• 210" style masking for admin display
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 6) return '•••';
  return `+${digits.slice(0, 3)} •• ••• ${digits.slice(-3)}`;
}

/** Path params are typed string|undefined by Hono; routes mounted with :id always have it. */
export function pathId(c: AppContext): string {
  return c.req.param('id') as string;
}
export function pathSid(c: AppContext): string {
  return c.req.param('sid') as string;
}
/** Widen audit-style nullable ids. */
export type NullableId = string | null | undefined;
