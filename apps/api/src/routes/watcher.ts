// Watcher routes: feed, assignments, watch sessions, wallet, payouts.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, ReqVars } from '../types.js';
import { ok, fail, pathId, pathSid, type AppContext } from '../lib/http.js';
import { nowSec, uuid, queryOne, queryAll } from '../lib/db.js';
import { sha256Hex } from '../lib/crypto.js';
import { signWatchToken } from '../lib/tokens.js';
import { nextOffer } from '../lib/assign.js';
import { getConfigNum } from '../lib/config.js';
import {
  getSession, validateHeartbeat, completeSession, buildReceipt,
  abandonSession,
  type HeartbeatInput,
} from '../lib/verify.js';
import { recordSignal, checkVelocity, bumpVelocity, asnRisk, trackDevice } from '../lib/fraud.js';
import { postEntries, getBalance, getPendingPayoutCents, getLifetimeEarnedCents, accountIdForUser, PAYOUT_CLEARING_ACCOUNT, LedgerError } from '../lib/ledger.js';
import { getPayoutAdapter, redactDestination, type PayoutMethod, type PayoutDestination } from '../lib/payouts.js';
import { authedUser } from '../middleware.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();
// NOTE: auth is applied path-scoped in index.ts (a global app.use() here would
// leak onto sibling mounts like /v1/_dev/* and /v1/stream/*).

// ---------- Feed & assignments ----------

app.get('/feed/next', async (c: AppContext) => {
  const user = authedUser(c);
  const offer = await nextOffer(c.env.DB, user.id, user.country_code, {
    ua: c.req.header('user-agent'),
    cfCountry: c.get('cf')?.country,
    ip: c.get('ip'),
  });
  if (!offer.assignment) {
    const reasons = {
      empty: 'No videos right now. New videos appear when advertisers launch campaigns in your country.',
      capped: 'You have seen everything available for now. Check back soon.',
      velocity: 'You have reached your viewing limit for now. Take a break — more videos soon.',
    } as const;
    return ok(c, { assignment: null, reason: offer.reason, message: reasons[offer.reason] });
  }
  return ok(c, offer);
});

app.post('/assignments/:id/claim', async (c: AppContext) => {
  const user = authedUser(c);
  const db = c.env.DB;
  const assignmentId = pathId(c);
  const now = nowSec();

  const assignment = await queryOne<{
    id: string; campaign_id: string; user_id: string; status: string; claim_deadline: number;
  }>(db, 'SELECT * FROM assignments WHERE id = ?', assignmentId);
  if (!assignment || assignment.user_id !== user.id) return fail(c, 'not_found', 'That video offer was not found.', 404);
  if (assignment.status !== 'offered') return fail(c, 'bad_state', `This offer is ${assignment.status}.`, 409);
  if (assignment.claim_deadline <= now) {
    await db.prepare(`UPDATE assignments SET status = 'expired' WHERE id = ?`).bind(assignmentId).run();
    return fail(c, 'expired', 'This session expired. Start the video again.', 410);
  }

  // One active session per user.
  const active = await queryOne(db, `SELECT id FROM watch_sessions WHERE user_id = ? AND status = 'active'`, user.id);
  if (active) return fail(c, 'session_active', 'Finish your current video first.', 409);

  // Claim velocity: 3 claims/min per user.
  const claimVel = await checkVelocity(db, `user:${user.id}:claims:60`, 60, 3);
  if (!claimVel.allowed) {
    await recordSignal(db, user.id, 'velocity_exceeded', 'medium', { scope: 'claims/min' });
    return fail(c, 'too_fast', 'Too many requests. Slow down a little.', 429);
  }

  const campaign = await queryOne<{
    id: string; video_id: string; status: string; price_per_view_cents: number; title: string;
    budget_cents: number; spent_cents: number; reserved_cents: number;
  }>(db, 'SELECT * FROM campaigns WHERE id = ?', assignment.campaign_id);
  if (!campaign || campaign.status !== 'live') return fail(c, 'unavailable', 'This campaign is no longer live.', 410);
  if (campaign.spent_cents + campaign.reserved_cents + campaign.price_per_view_cents > campaign.budget_cents) {
    return fail(c, 'budget_exhausted', 'This campaign just ran out of budget. Try another video.', 410);
  }

  const video = await queryOne<{ id: string; r2_key: string; duration_s: number; status: string; quiz: string | null }>(
    db, 'SELECT * FROM videos WHERE id = ?', campaign.video_id);
  if (!video || video.status !== 'approved') return fail(c, 'unavailable', 'This video is not available.', 410);

  // ASN gate.
  const asn = c.get('cf')?.asn;
  const risk = await asnRisk(db, asn);
  if (risk === 'block') {
    await recordSignal(db, user.id, 'datacenter_asn', 'high', { asn });
    return fail(c, 'network_blocked', 'Watching is not available on this network.', 403);
  }
  if (risk === 'review') {
    await recordSignal(db, user.id, 'vpn_asn', 'medium', { asn });
  }

  // Device gate: >2 accounts on one device blocks new claims until admin clears.
  // The fingerprint is REQUIRED at claim time (QA finding 6): without it the
  // multi-account gate is trivially bypassed. The PWA always sends X-Device-Fp.
  const fpHeader = c.req.header('x-device-fp');
  if (!fpHeader) {
    await recordSignal(db, user.id, 'missing_device_fp', 'low', {});
    return fail(c, 'device_required', 'A device identifier is required to claim videos.', 403);
  }
  let deviceFp: string | null = null;
  if (fpHeader) {
    deviceFp = await sha256Hex(fpHeader);
    const { accountCount } = await trackDevice(db, deviceFp, user.id);
    const devRow = await queryOne<{ risk: string }>(db, 'SELECT risk FROM devices WHERE fingerprint_hash = ?', deviceFp);
    if (accountCount > 2 || devRow?.risk === 'blocked') {
      await recordSignal(db, user.id, 'multi_account_device', 'high', { accountCount });
      return fail(c, 'device_blocked', 'Too many accounts on this device. Contact support to review.', 403);
    }
  }

  // Reserve budget (memo-only; real money moves only on completion).
  const price = campaign.price_per_view_cents;
  await db.prepare('UPDATE campaigns SET reserved_cents = reserved_cents + ? WHERE id = ?').bind(price, campaign.id).run();
  await bumpVelocity(db, `user:${user.id}:claims:60`, 60);

  const sessionId = uuid();
  const jti = uuid();
  const grace = await getConfigNum(db, 'watch_token_grace_s');
  const watchToken = await signWatchToken(c.env.WATCH_TOKEN_SECRET, {
    jti, sub: user.id, sid: sessionId, vid: video.id, cid: campaign.id, fp: deviceFp ?? 'unknown',
  }, now + Math.ceil(video.duration_s) + grace);

  await db.prepare(
    `INSERT INTO watch_sessions
       (id, assignment_id, user_id, campaign_id, video_id, token_jti, status, started_at,
        duration_s, ip, asn, device_fp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, assignmentId, user.id, campaign.id, video.id, jti, now,
    video.duration_s, c.get('ip') ?? null, asn ?? null, deviceFp, now).run();
  await db.prepare(`UPDATE assignments SET status = 'claimed', claimed_at = ? WHERE id = ?`)
    .bind(now, assignmentId).run();

  // Schedule attention checks server-side (random; never in first/last 5 s).
  const checks = scheduleChecks(video.duration_s, video.quiz);
  for (const chk of checks) {
    await db.prepare(
      `INSERT INTO attention_checks (id, session_id, check_type, scheduled_at_s, payload)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(uuid(), sessionId, chk.type, chk.at, JSON.stringify(chk.payload)).run();
  }
  const checkRows = await queryAll<{ id: string; check_type: string; scheduled_at_s: number }>(
    db, 'SELECT id, check_type, scheduled_at_s FROM attention_checks WHERE session_id = ? ORDER BY scheduled_at_s', sessionId);

  return ok(c, {
    session_id: sessionId,
    watch_token: watchToken,
    expires_at: now + Math.ceil(video.duration_s) + grace,
    stream_url: `/v1/stream/${video.id}`,
    video: { id: video.id, duration_s: video.duration_s },
    campaign: { id: campaign.id, title: campaign.title, price_per_view_cents: campaign.price_per_view_cents },
    checks: checkRows.map((r) => ({ id: r.id, type: r.check_type, scheduled_at_s: r.scheduled_at_s })),
  });
});

function scheduleChecks(durationS: number, quizRaw: string | null): Array<{ type: 'tap' | 'quiz'; at: number; payload: Record<string, unknown> }> {
  const out: Array<{ type: 'tap' | 'quiz'; at: number; payload: Record<string, unknown> }> = [];
  const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
  let quiz: { q: string; choices: string[]; answer_idx: number } | null = null;
  try { quiz = quizRaw ? JSON.parse(quizRaw) : null; } catch { quiz = null; }

  if (durationS >= 60) {
    const n = quiz ? 1 : (Math.random() < 0.5 ? 1 : 2);
    for (let i = 0; i < n; i++) out.push({ type: 'tap', at: Math.round(rand(5, durationS - 5) * 10) / 10, payload: {} });
  } else if (durationS >= 30) {
    out.push({ type: 'tap', at: Math.round(rand(5, durationS - 5) * 10) / 10, payload: {} });
  }
  if (quiz && Array.isArray(quiz.choices) && quiz.choices.length === 4) {
    out.push({
      type: 'quiz',
      at: Math.round(rand(durationS * 0.7, durationS * 0.85) * 10) / 10,
      payload: { q: quiz.q, choices: quiz.choices, answer_idx: quiz.answer_idx },
    });
  }
  return out;
}

app.post('/assignments/:id/skip', async (c: AppContext) => {
  const user = authedUser(c);
  const assignmentId = pathId(c);
  const assignment = await queryOne<{ user_id: string; status: string }>(
    c.env.DB, 'SELECT user_id, status FROM assignments WHERE id = ?', assignmentId);
  if (!assignment || assignment.user_id !== user.id) return fail(c, 'not_found', 'Offer not found.', 404);
  if (assignment.status !== 'offered') return fail(c, 'bad_state', 'Only pending offers can be skipped.', 409);
  await c.env.DB.prepare(`UPDATE assignments SET status = 'skipped' WHERE id = ?`).bind(assignmentId).run();
  return ok(c, { ok: true, note: 'Skipped — it can return after 24 hours.' });
});

// ---------- Watch session ----------

function ownSessionError(c: AppContext, session: { user_id: string } | null): Response | null {
  if (!session) return fail(c, 'not_found', 'Watch session not found.', 404);
  if (session.user_id !== authedUser(c).id) return fail(c, 'forbidden', 'Not your session.', 403);
  return null;
}

app.post('/watch/:sid/heartbeat', async (c: AppContext) => {
  const sid = pathSid(c);
  const session = await getSession(c.env.DB, sid);
  const err = ownSessionError(c, session);
  if (err) return err;
  const s = session!;
  if (s.status !== 'active') {
    return ok(c, { ok: false, reject_code: 'session_' + s.status, server_ts: nowSec(), watched_pct: s.watched_pct, intervals: [] });
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    seq: z.number().int().min(1),
    position_s: z.number().min(0),
    visible: z.boolean(),
    playback_rate: z.number(),
    client_ts: z.number(),
    buffering_s: z.number().min(0).max(600).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Bad heartbeat payload.');

  // Overdue attention check → invalidate before processing the beat.
  const overdue = await queryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM attention_checks WHERE session_id = ? AND presented_at IS NOT NULL AND responded_at IS NULL AND due_at < ? LIMIT 1`,
    sid, nowSec());
  if (overdue) {
    await abandonSession(c.env.DB, s, 'failed', 'attention_timeout');
    await recordSignal(c.env.DB, s.user_id, 'check_failed', 'medium', { check_id: overdue.id }, sid);
    return ok(c, { ok: false, reject_code: 'attention_timeout', server_ts: nowSec(), watched_pct: s.watched_pct, intervals: [] });
  }

  const input: HeartbeatInput = {
    seq: parsed.data.seq,
    position_s: parsed.data.position_s,
    visible: parsed.data.visible,
    playback_rate: parsed.data.playback_rate,
    client_ts: parsed.data.client_ts,
    buffering_s: parsed.data.buffering_s ?? 0,
  };
  const res = await validateHeartbeat(c.env.DB, s, input);
  return ok(c, res);
});

app.post('/watch/:sid/attention', async (c: AppContext) => {
  const sid = pathSid(c);
  const session = await getSession(c.env.DB, sid);
  const err = ownSessionError(c, session);
  if (err) return err;
  const s = session!;
  if (s.status !== 'active') return fail(c, 'bad_state', 'This watch is no longer active.', 409);

  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    check_id: z.string().uuid(),
    response: z.object({ choice_idx: z.number().int().min(0).max(3).optional() }).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Bad attention payload.');

  const db = c.env.DB;
  const now = nowSec();
  const timeout = await getConfigNum(db, 'attention_timeout_s');
  const check = await queryOne<{
    id: string; session_id: string; check_type: string; scheduled_at_s: number;
    presented_at: number | null; due_at: number | null; responded_at: number | null;
    passed: number | null; payload: string;
  }>(db, 'SELECT * FROM attention_checks WHERE id = ? AND session_id = ?', parsed.data.check_id, sid);
  if (!check) return fail(c, 'not_found', 'Check not found.', 404);
  if (check.responded_at != null) return fail(c, 'bad_state', 'Already answered.', 409);

  // Present step: client reached the scheduled time → arm the 15 s window.
  if (check.presented_at == null) {
    if (s.last_position_s < check.scheduled_at_s - 2) {
      return fail(c, 'too_early', 'Check is not due yet.', 409);
    }
    await db.prepare('UPDATE attention_checks SET presented_at = ?, due_at = ? WHERE id = ?')
      .bind(now, now + timeout, check.id).run();
    const payload = JSON.parse(check.payload || '{}');
    if (check.check_type === 'quiz') delete payload.answer_idx; // never send the answer
    return ok(c, { presented: true, type: check.check_type, due_in_s: timeout, payload });
  }

  // Answer step.
  if (now > (check.due_at ?? 0)) {
    await db.prepare('UPDATE attention_checks SET responded_at = ?, passed = 0 WHERE id = ?').bind(now, check.id).run();
    await abandonSession(db, s, 'failed', 'attention_timeout');
    await recordSignal(db, s.user_id, 'check_failed', 'medium', { check_id: check.id, reason: 'timeout' }, sid);
    return ok(c, { passed: false, reason: 'timeout' });
  }

  let passed = true;
  if (check.check_type === 'quiz') {
    const payload = JSON.parse(check.payload || '{}');
    const choice = parsed.data.response?.choice_idx;
    passed = choice === payload.answer_idx;
  }
  await db.prepare('UPDATE attention_checks SET responded_at = ?, passed = ? WHERE id = ?')
    .bind(now, passed ? 1 : 0, check.id).run();
  if (!passed) {
    await abandonSession(db, s, 'failed', 'attention_failed');
    await recordSignal(db, s.user_id, 'check_failed', 'medium', { check_id: check.id, reason: 'wrong_answer' }, sid);
    return ok(c, { passed: false, reason: 'wrong_answer' });
  }
  return ok(c, { passed: true });
});

app.post('/watch/:sid/complete', async (c: AppContext) => {
  const sid = pathSid(c);
  const session = await getSession(c.env.DB, sid);
  const err = ownSessionError(c, session);
  if (err) return err;
  const res = await completeSession(c.env.DB, sid);
  if (res.status === 'completed') {
    return ok(c, { status: 'completed', credited_cents: res.credited_cents, receipt: res.receipt });
  }
  const messages: Record<string, string> = {
    under_watched: 'Not enough of the video was verified as watched (need 90%).',
    attention_failed: "This watch didn't count — the attention check wasn't passed.",
    attention_missed: "This watch didn't count — an attention check was missed.",
    fraud_hold: "This watch is on hold while we review it.",
    clock_anomaly: "This watch didn't count — something was off with the timing.",
    campaign_insolvent: "This campaign ran out of budget before your watch finished.",
    campaign_gone: "This campaign is gone.",
    not_found: 'Watch session not found.',
  };
  // Failed watches do NOT consume the per-user cap: mark the assignment expired
  // so the campaign can be re-offered (the "second chance" — DECISIONS.md #27).
  const sess = await getSession(c.env.DB, sid);
  if (sess && (res.reason === 'under_watched' || res.reason === 'attention_failed' || res.reason === 'attention_missed' || res.reason === 'attention_timeout')) {
    await c.env.DB.prepare(`UPDATE assignments SET status = 'expired' WHERE id = ?`).bind(sess.assignment_id).run();
  }
  return ok(c, { status: 'failed', reason: res.reason, message: messages[res.reason ?? ''] ?? 'This watch did not count.' });
});

app.get('/watch/:sid/receipt', async (c: AppContext) => {
  const sid = pathSid(c);
  const session = await getSession(c.env.DB, sid);
  const err = ownSessionError(c, session);
  if (err) return err;
  return ok(c, { receipt: await buildReceipt(c.env.DB, session!) });
});

// ---------- Wallet ----------

app.get('/wallet', async (c: AppContext) => {
  const user = authedUser(c);
  const balance = await getBalance(c.env.DB, accountIdForUser(user.id));
  const pending = await getPendingPayoutCents(c.env.DB, user.id);
  const lifetime = await getLifetimeEarnedCents(c.env.DB, user.id);
  const views = await queryOne<{ n: number }>(
    c.env.DB, `SELECT COUNT(*) AS n FROM watch_sessions WHERE user_id = ? AND status = 'completed'`, user.id);
  const startOfDay = Math.floor(nowSec() / 86400) * 86400;
  const viewsToday = await queryOne<{ n: number }>(
    c.env.DB, `SELECT COUNT(*) AS n FROM watch_sessions WHERE user_id = ? AND status = 'completed' AND ended_at >= ?`, user.id, startOfDay);
  const maxDay = await getConfigNum(c.env.DB, 'max_views_per_day');
  const avgAtt = await queryOne<{ a: number | null }>(
    c.env.DB, `SELECT AVG(attention_score) AS a FROM watch_sessions WHERE user_id = ? AND status = 'completed'`, user.id);
  return ok(c, {
    balance_cents: balance,
    pending_payout_cents: pending,
    lifetime_earned_cents: lifetime,
    views_completed: views?.n ?? 0,
    views_today: viewsToday?.n ?? 0,
    max_views_per_day: maxDay,
    avg_attention_pct: avgAtt?.a == null ? null : Math.round(avgAtt.a * 100),
  });
});

app.get('/wallet/ledger', async (c: AppContext) => {
  const user = authedUser(c);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const cursor = c.req.query('cursor');
  let sql = `SELECT id, group_id, side, amount_cents, entry_type, ref_type, ref_id, memo, created_at
             FROM ledger_entries WHERE account_id = ?`;
  const args: unknown[] = [accountIdForUser(user.id)];
  if (cursor) {
    try {
      const [ts, id] = Buffer.from(cursor, 'base64').toString().split('|');
      sql += ' AND (created_at < ? OR (created_at = ? AND id < ?))';
      args.push(Number(ts), Number(ts), id);
    } catch { /* ignore bad cursor */ }
  }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
  args.push(limit + 1);
  const rows = await c.env.DB.prepare(sql).bind(...args).all<Record<string, unknown>>();
  const items = rows.results.slice(0, limit);
  const next = rows.results.length > limit
    ? Buffer.from(`${items[items.length - 1]!.created_at}|${items[items.length - 1]!.id}`).toString('base64')
    : null;
  return ok(c, { entries: items, next_cursor: next });
});

// ---------- Payouts ----------

const PAYOUT_METHODS = ['mpesa', 'bank', 'airtime', 'usdt'] as const;

app.post('/payouts', async (c: AppContext) => {
  const user = authedUser(c);
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    method: z.enum(PAYOUT_METHODS),
    destination: z.record(z.string(), z.unknown()),
    amount_cents: z.number().int().min(1),
    idempotency_key: z.string().uuid(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Check the payout details and try again.');

  const { method, amount_cents, idempotency_key } = parsed.data;
  const minPayout = await getConfigNum(db, 'min_payout_cents');
  if (amount_cents < minPayout) {
    return fail(c, 'below_minimum', `Minimum payout is $${(minPayout / 100).toFixed(2)}.`, 422);
  }

  const adapter = getPayoutAdapter(db, method as PayoutMethod);
  const destCheck = adapter.validateDestination(parsed.data.destination);
  if (!destCheck.ok) return fail(c, 'bad_destination', destCheck.error ?? 'Invalid destination.', 422);
  const destination: PayoutDestination = destCheck.normalized!;
  const destinationHash = await sha256Hex(JSON.stringify(destination));

  // Idempotency: same key → return existing payout. Scoped to the requesting
  // user: a client-chosen UUID must never collide across users (QA 2026-10-09:
  // user B replaying user A's key was handed A's payout id + status).
  const existing = await queryOne<{ id: string; status: string }>(
    db, 'SELECT id, status FROM payouts WHERE idempotency_key = ? AND user_id = ?', idempotency_key, user.id);
  if (existing) {
    return ok(c, { payout: { id: existing.id, status: existing.status }, deduped: true });
  }

  const quote = await adapter.quote(amount_cents);
  const feeCents = quote.feeCents;
  if (feeCents >= amount_cents) return fail(c, 'fee_too_high', 'The fee would eat the whole payout. Request a larger amount.', 422);

  const now = nowSec();
  const payoutId = uuid();
  const holdGroup = `payout-hold:${payoutId}`;
  try {
    await postEntries(db, holdGroup, [
      { accountId: accountIdForUser(user.id), side: 'debit', amountCents: amount_cents, entryType: 'PAYOUT_HOLD', refType: 'payout', refId: payoutId, memo: `Payout hold (${method})` },
      { accountId: PAYOUT_CLEARING_ACCOUNT, side: 'credit', amountCents: amount_cents, entryType: 'PAYOUT_HOLD', refType: 'payout', refId: payoutId, memo: `Payout hold (${method})` },
    ], now);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'insufficient_funds') {
      return fail(c, 'insufficient_funds', "That's more than your available balance.", 422);
    }
    throw err;
  }

  await db.prepare(
    `INSERT INTO payouts (id, user_id, amount_cents, method, destination, destination_hash,
      idempotency_key, fee_cents, fx_rate, status, hold_group_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)`
  ).bind(payoutId, user.id, amount_cents, method, JSON.stringify(destination), destinationHash,
    idempotency_key, feeCents, quote.fxRate, holdGroup, now).run();

  // Payout-dup fraud: same destination on ≥2 users → hold both, admin review.
  const dup = await queryOne<{ n: number }>(
    db, 'SELECT COUNT(DISTINCT user_id) AS n FROM payouts WHERE destination_hash = ?', destinationHash);
  if ((dup?.n ?? 0) >= 2) {
    await recordSignal(db, user.id, 'payout_destination_reuse', 'high', { payout_id: payoutId });
  }

  return ok(c, {
    payout: { id: payoutId, status: 'pending_review', amount_cents, fee_cents: feeCents, method },
    note: 'A person reviews every payout before money moves.',
  }, 201);
});

app.get('/payouts', async (c: AppContext) => {
  const user = authedUser(c);
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, amount_cents, method, destination, fee_cents, status, created_at, completed_at
     FROM payouts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, user.id);
  return ok(c, {
    payouts: rows.map((r) => ({
      ...r,
      destination: redactDestination(JSON.parse(String(r.destination)) as PayoutDestination),
    })),
  });
});

app.get('/payouts/:id', async (c: AppContext) => {
  const user = authedUser(c);
  const row = await queryOne<Record<string, unknown>>(
    c.env.DB, 'SELECT * FROM payouts WHERE id = ? AND user_id = ?', pathId(c), user.id);
  if (!row) return fail(c, 'not_found', 'Payout not found.', 404);
  const attempts = await queryAll<Record<string, unknown>>(
    c.env.DB, 'SELECT adapter, response, ok, created_at FROM payout_attempts WHERE payout_id = ? ORDER BY created_at', String(row.id));
  return ok(c, {
    payout: { ...row, destination: redactDestination(JSON.parse(String(row.destination)) as PayoutDestination) },
    attempts,
  });
});

export default app;
