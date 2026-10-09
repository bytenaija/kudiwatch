// Auth routes: OTP request/verify, refresh, logout, me.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, ReqVars } from '../types.js';
import { ok, fail, setAuthCookies, clearAuthCookies, getCookie, type AppContext } from '../lib/http.js';
import { nowSec, uuid, queryOne } from '../lib/db.js';
import { sha256Hex } from '../lib/crypto.js';
import { signAccessToken, newRefreshToken } from '../lib/tokens.js';
import { requestOtp, verifyOtp, MockSmsAdapter } from '../lib/sms.js';
import { recordSignal, trackDevice, isEmulatorUA } from '../lib/fraud.js';
import { requireAuth, authedUser, loadUser } from '../middleware.js';
import { getBalance, getPendingPayoutCents, accountIdForUser } from '../lib/ledger.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();

const E164 = z.string().regex(/^\+\d{7,15}$/, 'Use international format, e.g. +2348012345678.');

app.post('/otp/request', async (c: AppContext) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ phone_e164: E164 }).safeParse(body);
  if (!parsed.success) {
    // Always 200 — but validate format to avoid junk rows.
    return ok(c, { sent: true, resend_after_s: 60 });
  }
  const sms = new MockSmsAdapter(c.env.DB);
  const res = await requestOtp(c.env.DB, sms, c.env.OTP_PEPPER, parsed.data.phone_e164, c.env.ENV_NAME);
  return ok(c, { sent: true, resend_after_s: res.resendAfterSec, ...(res.devCode ? { dev_code: res.devCode } : {}) });
});

app.post('/otp/verify', async (c: AppContext) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    phone_e164: E164,
    code: z.string().regex(/^\d{6}$/),
    display_name: z.string().min(1).max(60).optional(),
    country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
    device: z.object({
      fingerprint: z.string().min(8).max(128),
      user_agent: z.string().max(512).optional(),
      platform: z.string().max(64).optional(),
    }).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Enter the 6-digit code we sent you.');

  const { phone_e164, code, device } = parsed.data;
  const res = await verifyOtp(c.env.DB, c.env.OTP_PEPPER, phone_e164, code);
  if (!res.ok) {
    if (res.code === 'locked' || res.code === 'attempts_exceeded') {
      const u = await queryOne<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE phone_e164 = ?', phone_e164);
      if (u) await recordSignal(c.env.DB, u.id, 'otp_bruteforce', 'high', { phone_e164 });
      return fail(c, 'otp_locked', 'Too many tries. Wait 1 hour, then request a new code.', 429);
    }
    if (res.code === 'expired') return fail(c, 'otp_expired', 'That code expired. Request a new one.');
    const left = res.attemptsLeft ?? 4;
    return fail(c, 'otp_mismatch', `That code didn't match. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 401);
  }

  const now = nowSec();
  const ua = device?.user_agent ?? c.req.header('user-agent') ?? '';
  const existingId = (await queryOne<{ id: string }>(
    c.env.DB, 'SELECT id FROM users WHERE phone_e164 = ?', phone_e164
  ))?.id;
  let user = existingId ? await loadUser(c.env.DB, existingId) : null;
  const isNewUser = !user;

  if (!user) {
    const id = uuid();
    const name = (parsed.data.display_name ?? '').trim() || 'Watcher';
    const cc = (parsed.data.country_code ?? '').toUpperCase() || 'NG';
    await c.env.DB.prepare(
      `INSERT INTO users (id, phone_e164, phone_verified_at, country_code, display_name, roles, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, '["watcher"]', 'active', ?, ?)`
    ).bind(id, phone_e164, now, cc, name, now, now).run();
    user = (await loadUser(c.env.DB, id))!;
  } else {
    await c.env.DB.prepare('UPDATE users SET last_seen_at = ?, phone_verified_at = ? WHERE id = ?')
      .bind(now, now, user.id).run();
    if (user.status === 'banned') return fail(c, 'account_banned', 'This account was closed for breaking the fair-watch rules.', 403);
  }

  // Device fingerprint tracking (multi-account detection).
  if (device?.fingerprint) {
    const fpHash = await sha256Hex(device.fingerprint);
    const { accountCount } = await trackDevice(c.env.DB, fpHash, user.id);
    await c.env.DB.prepare('UPDATE users SET default_device_fp = ? WHERE id = ?').bind(fpHash, user.id).run();
    if (isEmulatorUA(ua)) {
      await recordSignal(c.env.DB, user.id, 'emulator_ua', 'medium', { ua: ua.slice(0, 200) });
    }
    if (accountCount > 2) {
      await recordSignal(c.env.DB, user.id, 'multi_account_device', 'high', { accountCount });
      await c.env.DB.prepare(`UPDATE devices SET risk = 'review' WHERE fingerprint_hash = ?`).bind(fpHash).run();
    }
  }

  // Issue session: access JWT (bound to the session row → logout is immediate)
  // + rotating opaque refresh.
  const { token: refresh, hash } = newRefreshToken();
  const refreshHash = await hash;
  const refreshExp = now + 30 * 86400;
  const sessionId = uuid();
  await c.env.DB.prepare(
    `INSERT INTO auth_sessions (id, user_id, refresh_hash, created_at, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, user.id, refreshHash, now, refreshExp, c.get('ip') ?? null, ua.slice(0, 300)).run();
  const access = await signAccessToken(c.env.JWT_SECRET, { sub: user.id, roles: user.roles, sid: sessionId });

  setAuthCookies(c, access, refresh, 30 * 86400);
  return ok(c, {
    new_user: isNewUser,
    user: { id: user.id, display_name: user.display_name, roles: user.roles, country_code: user.country_code },
  });
});

app.post('/refresh', async (c: AppContext) => {
  const rt = getCookie(c, 'kw_rt');
  if (!rt) return fail(c, 'unauthorized', 'Sign in to continue.', 401);
  const hash = await sha256Hex(rt);
  const now = nowSec();
  const sess = await queryOne<{ id: string; user_id: string; expires_at: number; revoked_at: number | null }>(
    c.env.DB, 'SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE refresh_hash = ?', hash
  );
  if (!sess || sess.revoked_at || sess.expires_at <= now) {
    return fail(c, 'unauthorized', 'Session expired. Sign in again.', 401);
  }
  const user = await loadUser(c.env.DB, sess.user_id);
  if (!user) return fail(c, 'unauthorized', 'Account not found.', 401);

  // Rotate.
  const { token: next, hash: nextHashP } = newRefreshToken();
  const nextHash = await nextHashP;
  const nextSessionId = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').bind(now, sess.id),
    c.env.DB.prepare(
      `INSERT INTO auth_sessions (id, user_id, refresh_hash, created_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(nextSessionId, user.id, nextHash, now, now + 30 * 86400, c.get('ip') ?? null, (c.req.header('user-agent') ?? '').slice(0, 300)),
  ]);
  const access = await signAccessToken(c.env.JWT_SECRET, { sub: user.id, roles: user.roles, sid: nextSessionId });
  setAuthCookies(c, access, next, 30 * 86400);
  return ok(c, { ok: true });
});

app.post('/logout', requireAuth(), async (c: AppContext) => {
  const rt = getCookie(c, 'kw_rt');
  if (rt) {
    const hash = await sha256Hex(rt);
    await c.env.DB.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE refresh_hash = ?')
      .bind(nowSec(), hash).run();
  }
  clearAuthCookies(c);
  return ok(c, { ok: true });
});

export const meApp = new Hono<{ Bindings: Env; Variables: ReqVars }>();

meApp.get('/me', requireAuth(), async (c: AppContext) => {
  const user = authedUser(c);
  const balance = await getBalance(c.env.DB, accountIdForUser(user.id));
  const pending = await getPendingPayoutCents(c.env.DB, user.id);
  return ok(c, {
    user: { id: user.id, display_name: user.display_name, roles: user.roles, country_code: user.country_code, status: user.status },
    wallet: { balance_cents: balance, pending_payout_cents: pending },
  });
});

meApp.patch('/me', requireAuth(), async (c: AppContext) => {
  const user = authedUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    display_name: z.string().min(1).max(60).optional(),
    country_code: z.string().regex(/^[A-Z]{2}$/).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Nothing to update.');
  const sets: string[] = [];
  const args: unknown[] = [];
  if (parsed.data.display_name) { sets.push('display_name = ?'); args.push(parsed.data.display_name.trim()); }
  if (parsed.data.country_code) { sets.push('country_code = ?'); args.push(parsed.data.country_code); }
  if (sets.length === 0) return fail(c, 'bad_request', 'Nothing to update.');
  args.push(user.id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...args).run();
  const updated = await loadUser(c.env.DB, user.id);
  return ok(c, { user: { id: updated!.id, display_name: updated!.display_name, roles: updated!.roles, country_code: updated!.country_code } });
});

export default app;
