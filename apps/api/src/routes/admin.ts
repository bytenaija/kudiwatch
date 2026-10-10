// Admin routes: video review, flagged accounts, payout decisions, campaigns,
// config, audit log. Every mutation → admin_audit_log. Requires admin role.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, ReqVars } from '../types.js';
import { ok, fail, pathId, pathSid, type AppContext } from '../lib/http.js';
import { nowSec, uuid, queryOne, queryAll } from '../lib/db.js';
import { getAllConfig, setConfig, getConfigNum } from '../lib/config.js';
import { postEntries, getBalance, accountIdForUser, PAYOUT_CLEARING_ACCOUNT, LedgerError } from '../lib/ledger.js';
import { getPayoutAdapter, redactDestination, type PayoutMethod } from '../lib/payouts.js';
import { requireAuth, requireRole, authedUser } from '../middleware.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();
app.use(requireAuth(), requireRole('admin'));

async function audit(
  c: AppContext, action: string, targetType: string | null | undefined, targetId: string | null | undefined,
  diff: Record<string, unknown>
): Promise<void> {
  await c.env.DB.prepare(
    `INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, diff, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(uuid(), authedUser(c).id, action, targetType, targetId, JSON.stringify(diff),
    c.get('ip') ?? null, nowSec()).run();
}

// ---------- Video review ----------

app.get('/videos/review-queue', async (c: AppContext) => {
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT v.id, v.advertiser_id, v.duration_s, v.youtube_video_id, v.youtube_title, v.youtube_author,
            v.status, v.created_at, ap.company_name AS advertiser,
            (SELECT COUNT(*) FROM videos WHERE advertiser_id = v.advertiser_id) AS advertiser_video_count
     FROM videos v LEFT JOIN advertiser_profiles ap ON ap.user_id = v.advertiser_id
     WHERE v.status = 'in_review' ORDER BY v.created_at ASC LIMIT 100`);
  return ok(c, { videos: rows });
});

app.post('/videos/:id/review', async (c: AppContext) => {
  const videoId = pathId(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    approve: z.boolean(),
    reason: z.string().max(500).optional(),
    duration_s: z.number().min(1).max(3600).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'approve (true/false) is required.');

  const video = await queryOne<{ id: string; status: string }>(
    c.env.DB, 'SELECT id, status FROM videos WHERE id = ?', videoId);
  if (!video) return fail(c, 'not_found', 'Video not found.', 404);
  if (video.status !== 'in_review') return fail(c, 'bad_state', `Video is ${video.status}.`, 409);
  if (!parsed.data.approve && !parsed.data.reason?.trim()) {
    return fail(c, 'bad_request', 'Give a reason — the advertiser will see it.');
  }

  const now = nowSec();
  const admin = authedUser(c);
  const next = parsed.data.approve ? 'approved' : 'rejected';
  if (parsed.data.approve) {
    // Decision #39: duration is unknown at submit time (YouTube gives us no
    // no-key duration source), so the admin sets it from the embedded preview.
    // The watch-session token embeds this duration — it must be real.
    const minDur = await getConfigNum(c.env.DB, 'min_video_duration_s');
    const maxDur = await getConfigNum(c.env.DB, 'max_video_duration_s');
    const d = parsed.data.duration_s;
    if (!d || d < minDur || d > maxDur) {
      return fail(c, 'bad_duration', `Set the video's length (${minDur}–${maxDur} seconds) to approve — read it off the preview.`, 422);
    }
    await c.env.DB.prepare(
      `UPDATE videos SET status = 'approved', duration_s = ?, rejection_reason = NULL, reviewed_by = ?, reviewed_at = ? WHERE id = ?`
    ).bind(d, admin.id, now, videoId).run();
  } else {
    await c.env.DB.prepare(
      `UPDATE videos SET status = 'rejected', rejection_reason = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`
    ).bind(parsed.data.reason!.trim(), admin.id, now, videoId).run();
  }
  await audit(c, 'video.review', 'video', videoId, { before: { status: 'in_review' }, after: { status: next, reason: parsed.data.reason ?? null } });
  return ok(c, { video: { id: videoId, status: next } });
});

// ---------- Flagged accounts ----------

app.get('/accounts/flagged', async (c: AppContext) => {
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT u.id, u.phone_e164, u.display_name, u.country_code, u.status, u.created_at,
            (SELECT COUNT(*) FROM fraud_signals fs WHERE fs.user_id = u.id) AS signal_count,
            (SELECT COUNT(*) FROM fraud_signals fs WHERE fs.user_id = u.id AND fs.severity = 'high') AS high_signals,
            (SELECT MAX(fs.created_at) FROM fraud_signals fs WHERE fs.user_id = u.id) AS last_signal_at,
            (SELECT af.action FROM account_flags af WHERE af.user_id = u.id AND af.resolved_at IS NULL ORDER BY af.created_at DESC LIMIT 1) AS open_flag
     FROM users u
     WHERE EXISTS (SELECT 1 FROM fraud_signals fs WHERE fs.user_id = u.id)
        OR EXISTS (SELECT 1 FROM account_flags af WHERE af.user_id = u.id AND af.resolved_at IS NULL)
     ORDER BY high_signals DESC, last_signal_at DESC LIMIT 100`);
  return ok(c, {
    accounts: rows.map((r) => ({
      ...r,
      phone_masked: String(r.phone_e164).replace(/(\+\d{3})\d+(\d{3})$/, '$1•••$2'),
    })),
  });
});

app.get('/accounts/:id/signals', async (c: AppContext) => {
  const rows = await queryAll(
    c.env.DB,
    `SELECT id, signal_type, severity, details, session_id, created_at FROM fraud_signals
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`, pathId(c));
  return ok(c, { signals: rows });
});

app.post('/accounts/:id/flag', async (c: AppContext) => {
  const userId = pathId(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    action: z.enum(['warn', 'suspend', 'ban']),
    reason: z.string().min(3).max(500),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'action (warn/suspend/ban) and reason are required.');

  const target = await queryOne<{ id: string; status: string }>(
    c.env.DB, 'SELECT id, status FROM users WHERE id = ?', userId);
  if (!target) return fail(c, 'not_found', 'Account not found.', 404);

  const now = nowSec();
  const admin = authedUser(c);
  const statusMap = { warn: 'warned', suspend: 'suspended', ban: 'banned' } as const;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO account_flags (id, user_id, action, reason, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(uuid(), userId, parsed.data.action, parsed.data.reason.trim(), admin.id, now),
    c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(statusMap[parsed.data.action], userId),
  ]);
  await audit(c, 'account.flag', 'user', userId,
    { before: { status: target.status }, after: { status: statusMap[parsed.data.action], reason: parsed.data.reason } });
  return ok(c, { account: { id: userId, status: statusMap[parsed.data.action] } });
});

app.post('/accounts/:id/clear', async (c: AppContext) => {
  const userId = pathId(c);
  const now = nowSec();
  const admin = authedUser(c);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE account_flags SET resolved_at = ?, resolved_by = ? WHERE user_id = ? AND resolved_at IS NULL`)
      .bind(now, admin.id, userId),
    c.env.DB.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).bind(userId),
    c.env.DB.prepare(`UPDATE devices SET risk = 'ok' WHERE fingerprint_hash IN (SELECT default_device_fp FROM users WHERE id = ?)`).bind(userId),
  ]);
  await audit(c, 'account.clear', 'user', userId, { after: { status: 'active' } });
  return ok(c, { account: { id: userId, status: 'active' } });
});

// ---------- Payout queue ----------

app.get('/payouts/queue', async (c: AppContext) => {
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.user_id, p.amount_cents, p.method, p.destination, p.fee_cents, p.status, p.created_at,
            u.display_name, u.country_code, u.created_at AS account_created_at,
            (SELECT COUNT(*) FROM watch_sessions ws WHERE ws.user_id = p.user_id AND ws.status = 'completed') AS completions,
            (SELECT COUNT(*) FROM fraud_signals fs WHERE fs.user_id = p.user_id) AS signals,
            (SELECT COUNT(*) FROM fraud_signals fs WHERE fs.user_id = p.user_id AND fs.severity = 'high') AS high_signals
     FROM payouts p JOIN users u ON u.id = p.user_id
     WHERE p.status = 'pending_review' ORDER BY p.created_at ASC LIMIT 100`);
  return ok(c, {
    payouts: rows.map((r) => ({
      ...r,
      destination: redactDestination(JSON.parse(String(r.destination))),
      account_age_days: Math.floor((nowSec() - Number(r.account_created_at)) / 86400),
    })),
  });
});

app.post('/payouts/:id/decision', async (c: AppContext) => {
  const payoutId = pathId(c);
  // Deepdive §7: payout decisions need a fresh session (re-auth if older than 12 h).
  const sessionAge = nowSec() - (c.get('sessionCreatedAt') ?? 0);
  if (sessionAge > 12 * 3600) {
    return fail(c, 'reauth_required', 'For payout decisions, sign in again — this session is older than 12 hours.', 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    approve: z.boolean(),
    note: z.string().max(500).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'approve (true/false) is required.');
  if (!parsed.data.approve && !parsed.data.note?.trim()) {
    return fail(c, 'bad_request', 'Give a reason — the watcher will see it.');
  }

  const payout = await queryOne<{
    id: string; user_id: string; amount_cents: number; status: string; hold_group_id: string | null;
  }>(c.env.DB, 'SELECT * FROM payouts WHERE id = ?', payoutId);
  if (!payout) return fail(c, 'not_found', 'Payout not found.', 404);
  if (payout.status !== 'pending_review') return fail(c, 'bad_state', `Payout is ${payout.status}.`, 409);

  const now = nowSec();
  const admin = authedUser(c);
  if (parsed.data.approve) {
    await c.env.DB.prepare(
      `UPDATE payouts SET status = 'approved', reviewed_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`
    ).bind(admin.id, now, parsed.data.note?.trim() ?? null, payoutId).run();
    await audit(c, 'payout.decide', 'payout', payoutId,
      { before: { status: 'pending_review' }, after: { status: 'approved', note: parsed.data.note ?? null } });
    return ok(c, { payout: { id: payoutId, status: 'approved' }, note: 'A worker will send it shortly (mock adapter).' });
  }

  // Reject → refund the hold to the watcher.
  const refundGroup = `payout-refund:${payoutId}`;
  try {
    await postEntries(c.env.DB, refundGroup, [
      { accountId: PAYOUT_CLEARING_ACCOUNT, side: 'debit', amountCents: payout.amount_cents, entryType: 'PAYOUT_REFUND', refType: 'payout', refId: payoutId, memo: 'Rejected payout refunded' },
      { accountId: accountIdForUser(payout.user_id), side: 'credit', amountCents: payout.amount_cents, entryType: 'PAYOUT_REFUND', refType: 'payout', refId: payoutId, memo: 'Rejected payout refunded' },
    ], now);
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    return fail(c, 'ledger_error', 'Could not refund — contact engineering.', 500);
  }
  await c.env.DB.prepare(
    `UPDATE payouts SET status = 'rejected', reviewed_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`
  ).bind(admin.id, now, parsed.data.note!.trim(), payoutId).run();
  await audit(c, 'payout.decide', 'payout', payoutId,
    { before: { status: 'pending_review' }, after: { status: 'rejected', note: parsed.data.note } });
  return ok(c, { payout: { id: payoutId, status: 'rejected' } });
});

app.get('/payouts', async (c: AppContext) => {
  const status = c.req.query('status');
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT p.id, p.user_id, p.amount_cents, p.method, p.destination, p.fee_cents, p.status,
            p.created_at, p.completed_at, u.display_name
     FROM payouts p JOIN users u ON u.id = p.user_id
     ${status ? 'WHERE p.status = ?' : ''} ORDER BY p.created_at DESC LIMIT 100`,
    ...(status ? [status] : []));
  return ok(c, {
    payouts: rows.map((r) => ({ ...r, destination: redactDestination(JSON.parse(String(r.destination))) })),
  });
});

// ---------- Campaigns (fraud watch) ----------

app.get('/campaigns', async (c: AppContext) => {
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT c.*, ap.company_name AS advertiser,
            (SELECT COUNT(*) FROM watch_sessions ws WHERE ws.campaign_id = c.id) AS views,
            (SELECT COUNT(*) FROM watch_sessions ws WHERE ws.campaign_id = c.id AND ws.status = 'completed') AS completions
     FROM campaigns c LEFT JOIN advertiser_profiles ap ON ap.user_id = c.advertiser_id
     ORDER BY c.created_at DESC LIMIT 100`);
  return ok(c, { campaigns: rows });
});

// ---------- Config ----------

app.get('/config', async (c: AppContext) => {
  return ok(c, { config: await getAllConfig(c.env.DB), note: 'Changes apply immediately — no redeploy.' });
});

app.put('/config', async (c: AppContext) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ key: z.string().min(1).max(80), value: z.string().max(2000) }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'key and value are required.');
  const before = await getAllConfig(c.env.DB);
  const now = nowSec();
  await setConfig(c.env.DB, parsed.data.key, parsed.data.value, authedUser(c).id, now);
  await audit(c, 'config.set', 'config', parsed.data.key,
    { before: { [parsed.data.key]: before[parsed.data.key] ?? null }, after: { [parsed.data.key]: parsed.data.value } });
  return ok(c, { ok: true, key: parsed.data.key, value: parsed.data.value });
});

// ---------- Audit log ----------

app.get('/audit-log', async (c: AppContext) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const cursor = c.req.query('cursor');
  let sql = `SELECT a.id, a.admin_id, a.action, a.target_type, a.target_id, a.diff, a.ip, a.created_at,
                    u.display_name AS admin_name
             FROM admin_audit_log a LEFT JOIN users u ON u.id = a.admin_id`;
  const args: unknown[] = [];
  if (cursor) {
    try {
      const [ts, id] = Buffer.from(cursor, 'base64').toString().split('|');
      sql += ' WHERE (a.created_at < ? OR (a.created_at = ? AND a.id < ?))';
      args.push(Number(ts), Number(ts), id);
    } catch { /* ignore */ }
  }
  sql += ' ORDER BY a.created_at DESC, a.id DESC LIMIT ?';
  args.push(limit + 1);
  const rows = await c.env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  const items = rows.results.slice(0, limit);
  const next = rows.results.length > limit
    ? Buffer.from(`${items[items.length - 1]!.created_at}|${items[items.length - 1]!.id}`).toString('base64')
    : null;
  return ok(c, { entries: items.map((e) => ({ ...e, diff: JSON.parse(String(e.diff || '{}')) })), next_cursor: next });
});

// ---------- Admin grant (bootstrap only: existing admin grants) ----------

app.post('/accounts/:id/grant-admin', async (c: AppContext) => {
  const userId = pathId(c);
  const target = await queryOne<{ id: string; roles: string }>(
    c.env.DB, 'SELECT id, roles FROM users WHERE id = ?', userId);
  if (!target) return fail(c, 'not_found', 'Account not found.', 404);
  const roles = JSON.parse(target.roles) as string[];
  if (!roles.includes('admin')) roles.push('admin');
  await c.env.DB.prepare('UPDATE users SET roles = ? WHERE id = ?').bind(JSON.stringify(roles), userId).run();
  await audit(c, 'account.grant_admin', 'user', userId, { after: { roles } });
  return ok(c, { account: { id: userId, roles } });
});

export default app;
