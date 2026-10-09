// Watch-verification engine: heartbeat continuity validation (§5.3) and
// completion/crediting (§5.5). The client is NEVER trusted for position,
// visibility, or rate — the server re-derives credit from heartbeat evidence.
import { nowSec, uuid, type DbAdapter } from './db.js';
import { getConfigNum } from './config.js';
import { postEntries, accountIdForUser, accountIdForCampaign, LedgerError } from './ledger.js';
import { recordSignal, hasOpenHighSeverity, bumpVelocity } from './fraud.js';

export interface HeartbeatInput {
  seq: number;
  position_s: number;
  visible: boolean;
  playback_rate: number;
  client_ts: number;
  buffering_s?: number;
}

export interface HeartbeatResult {
  ok: boolean;
  reject_code?: string;
  server_ts: number;
  watched_pct: number;
  /** Merged verified intervals, for the player's verified-segments bar. */
  intervals: Array<[number, number]>;
}

export interface SessionRow {
  id: string; assignment_id: string; user_id: string; campaign_id: string; video_id: string;
  status: string; duration_s: number; watched_intervals: string; watched_pct: number;
  last_seq: number; last_position_s: number; last_hb_ts: number | null;
  total_buffering_s: number; started_at: number; ended_at: number | null;
  device_fp: string | null; attention_score: number | null;
  credit_group_id: string | null; failure_reason: string | null;
}

export async function getSession(db: DbAdapter, sid: string): Promise<SessionRow | null> {
  const row = await db.prepare('SELECT * FROM watch_sessions WHERE id = ?').bind(sid)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    id: String(row.id), assignment_id: String(row.assignment_id),
    user_id: String(row.user_id), campaign_id: String(row.campaign_id),
    video_id: String(row.video_id), status: String(row.status),
    duration_s: Number(row.duration_s), watched_intervals: String(row.watched_intervals ?? '[]'),
    watched_pct: Number(row.watched_pct ?? 0), last_seq: Number(row.last_seq ?? 0),
    last_position_s: Number(row.last_position_s ?? 0),
    last_hb_ts: row.last_hb_ts == null ? null : Number(row.last_hb_ts),
    total_buffering_s: Number(row.total_buffering_s ?? 0),
    started_at: Number(row.started_at),
    ended_at: row.ended_at == null ? null : Number(row.ended_at),
    device_fp: str(row.device_fp),
    attention_score: row.attention_score == null ? null : Number(row.attention_score),
    credit_group_id: str(row.credit_group_id),
    failure_reason: str(row.failure_reason),
  };
}

type Interval = [number, number];

export function parseIntervals(raw: string): Interval[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is Interval => Array.isArray(x) && x.length === 2).map(([a, b]) => [Number(a), Number(b)]);
  } catch { return []; }
}

/** Merge [a,b] into a sorted interval list, coalescing overlaps. */
export function unionInterval(intervals: Interval[], a: number, b: number): Interval[] {
  let lo = Math.min(a, b), hi = Math.max(a, b);
  const out: Interval[] = [];
  let merged = false;
  for (const [s, e] of [...intervals, [lo, hi] as Interval].sort((x, y) => x[0] - y[0])) {
    if (!merged && s === lo && e === hi) { merged = true; }
    const last = out[out.length - 1];
    if (last && s <= last[1] + 0.001) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function intervalsLength(intervals: Interval[]): number {
  return intervals.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0);
}

async function logHeartbeat(
  db: DbAdapter, sessionId: string, input: HeartbeatInput, serverTs: number,
  accepted: boolean, rejectCode?: string
): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO heartbeats
       (session_id, seq, client_ts, server_ts, position_s, visible, playback_rate, buffering_s, accepted, reject_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(sessionId, input.seq, Math.floor(input.client_ts), serverTs, input.position_s,
    input.visible ? 1 : 0, input.playback_rate, input.buffering_s ?? 0,
    accepted ? 1 : 0, rejectCode ?? null).run();
}

async function countMediumSignals(db: DbAdapter, sessionId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM fraud_signals WHERE session_id = ? AND severity = 'medium'`
  ).bind(sessionId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Validate one heartbeat (§5.3). Rejected beats are still logged.
 * On the 3rd medium-severity signal in a session, the session is invalidated.
 */
export async function validateHeartbeat(
  db: DbAdapter, session: SessionRow, input: HeartbeatInput
): Promise<HeartbeatResult> {
  const serverTs = nowSec();
  const intervals = parseIntervals(session.watched_intervals);

  const reject = async (code: string, signal?: { type: string; severity: 'low' | 'medium' | 'high'; details?: Record<string, unknown> }) => {
    await logHeartbeat(db, session.id, input, serverTs, false, code);
    if (signal) {
      await recordSignal(db, session.user_id, signal.type, signal.severity, signal.details ?? {}, session.id);
      if (signal.severity === 'medium' && (await countMediumSignals(db, session.id)) >= 3) {
        await invalidateSession(db, session.id, 'fraud_pattern');
      }
    }
    return { ok: false as const, reject_code: code, server_ts: serverTs, watched_pct: session.watched_pct, intervals };
  };

  // 1. Sequence chain: strictly increasing from last_seq+1.
  if (!Number.isInteger(input.seq) || input.seq < 1) {
    return reject('bad_seq', { type: 'seq_gap', severity: 'low', details: { seq: input.seq } });
  }
  if (input.seq <= session.last_seq) {
    return reject('dup_seq', { type: 'seq_gap', severity: 'low', details: { seq: input.seq, last: session.last_seq } });
  }
  if (input.seq > session.last_seq + 1) {
    return reject('seq_gap', { type: 'seq_gap', severity: 'medium', details: { seq: input.seq, last: session.last_seq } });
  }

  // 2. Visibility: zero credit for hidden intervals.
  if (!input.visible) {
    const advanced = input.position_s > session.last_position_s + 0.5;
    await logHeartbeat(db, session.id, input, serverTs, false, 'hidden');
    if (advanced) {
      await recordSignal(db, session.user_id, 'hidden_playback', 'medium',
        { position_s: input.position_s, last: session.last_position_s }, session.id);
    }
    // Update bookkeeping so the chain doesn't break when the tab returns.
    await db.prepare(
      'UPDATE watch_sessions SET last_seq = ?, last_position_s = ?, last_hb_ts = ? WHERE id = ?'
    ).bind(input.seq, input.position_s, serverTs, session.id).run();
    return { ok: false, reject_code: 'hidden', server_ts: serverTs, watched_pct: session.watched_pct, intervals };
  }

  // 3. Rate lock: exactly 1.0.
  if (input.playback_rate !== 1) {
    return reject('bad_rate', { type: 'rate_change', severity: 'medium', details: { rate: input.playback_rate } });
  }

  // 4. Position continuity: [last-1.0, last + elapsed*1.25 + 2.0 + buffering].
  const elapsed = session.last_hb_ts == null ? 10 : Math.max(0, serverTs - session.last_hb_ts);
  const buffering = Math.max(0, Math.min(120, input.buffering_s ?? 0));
  const lo = session.last_position_s - 1.0;
  const hi = session.last_position_s + elapsed * 1.25 + 2.0 + buffering;
  if (!(input.position_s >= lo && input.position_s <= hi) || !Number.isFinite(input.position_s)) {
    return reject('jump', {
      type: 'position_jump', severity: 'high',
      details: { position_s: input.position_s, last: session.last_position_s, elapsed, window: [lo, hi] },
    });
  }

  // 5. Beat frequency: >1 heartbeat per 5 s per session → reject (scripted over-beat).
  if (session.last_hb_ts != null && serverTs - session.last_hb_ts < 5 && session.last_seq > 0) {
    return reject('too_fast', { type: 'uniform_heartbeats', severity: 'low', details: { gap_s: serverTs - session.last_hb_ts } });
  }

  // Accept: merge interval [min(last,pos), max(last,pos)], clamp to [0, duration].
  const a = Math.max(0, Math.min(session.last_position_s, input.position_s));
  const b = Math.min(session.duration_s, Math.max(session.last_position_s, input.position_s));
  const merged = unionInterval(intervals, a, b);
  const watchedLen = intervalsLength(merged);
  const pct = Math.min(100, (watchedLen / session.duration_s) * 100);

  await logHeartbeat(db, session.id, input, serverTs, true);
  await db.prepare(
    `UPDATE watch_sessions
     SET last_seq = ?, last_position_s = ?, last_hb_ts = ?,
         watched_intervals = ?, watched_pct = ?,
         total_buffering_s = total_buffering_s + ?
     WHERE id = ?`
  ).bind(input.seq, input.position_s, serverTs, JSON.stringify(merged), pct, buffering, session.id).run();

  // Uniform-beat detection: stddev of inter-arrival < 300 ms over >= 10 beats → metronome bot.
  const recent = await db.prepare(
    `SELECT server_ts FROM heartbeats WHERE session_id = ? AND accepted = 1 ORDER BY seq DESC LIMIT 11`
  ).bind(session.id).all<{ server_ts: number }>();
  if (recent.results.length >= 11) {
    const ts = recent.results.map((r) => r.server_ts).reverse();
    const gaps: number[] = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i]! - ts[i - 1]!);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
    if (Math.sqrt(variance) < 0.3) {
      await recordSignal(db, session.user_id, 'uniform_heartbeats', 'medium',
        { stddev_s: Math.sqrt(variance), beats: gaps.length + 1 }, session.id);
    }
  }

  return { ok: true, server_ts: serverTs, watched_pct: pct, intervals: merged };
}

export async function invalidateSession(db: DbAdapter, sessionId: string, reason: string): Promise<void> {
  const session = await getSession(db, sessionId);
  if (!session) return;
  await abandonSession(db, session, 'invalidated', reason);
}

/**
 * Settle a session that left 'active' without completing: mark the session,
 * release the campaign budget reservation, and free the assignment
 * (status → 'expired') so the campaign can be re-offered — abandoned or
 * failed watches must NOT consume the per-user cap (DECISIONS.md #27).
 */
export async function abandonSession(
  db: DbAdapter, session: SessionRow,
  status: 'expired' | 'failed' | 'invalidated', failureReason: string
): Promise<void> {
  const now = nowSec();
  await db.prepare(
    `UPDATE watch_sessions SET status = ?, ended_at = ?, failure_reason = ? WHERE id = ? AND status = 'active'`
  ).bind(status, now, failureReason, session.id).run();
  const camp = await db.prepare('SELECT price_per_view_cents FROM campaigns WHERE id = ?')
    .bind(session.campaign_id).first<{ price_per_view_cents: number }>();
  await releaseReservation(db, session.campaign_id, camp?.price_per_view_cents ?? 0);
  await db.prepare(`UPDATE assignments SET status = 'expired' WHERE id = ?`).bind(session.assignment_id).run();
}

/** Release a campaign's reserved budget by an exact amount. */
export async function releaseReservation(db: DbAdapter, campaignId: string, amountCents: number): Promise<void> {
  await db.prepare(
    'UPDATE campaigns SET reserved_cents = MAX(0, reserved_cents - ?) WHERE id = ?'
  ).bind(amountCents, campaignId).run();
}

export interface CompletionResult {
  status: 'completed' | 'failed';
  credited_cents?: number;
  reason?: string;
  receipt?: Record<string, unknown>;
}

/**
 * POST /watch/:sid/complete. Idempotent: re-POST returns the same receipt.
 * Requirements: watched_pct >= completion_pct, all due attention checks passed,
 * no open high-severity signals, wall-clock bound.
 */
export async function completeSession(db: DbAdapter, sid: string): Promise<CompletionResult> {
  const session = await getSession(db, sid);
  if (!session) return { status: 'failed', reason: 'not_found' };
  if (session.status === 'completed') {
    return { status: 'completed', credited_cents: await creditedFor(db, session), receipt: await buildReceipt(db, session) };
  }
  if (session.status !== 'active') {
    return { status: 'failed', reason: session.failure_reason ?? session.status };
  }

  const now = nowSec();
  const completionPct = await getConfigNum(db, 'completion_pct');
  const grace = await getConfigNum(db, 'watch_token_grace_s');

  const intervals = parseIntervals(session.watched_intervals);
  const pct = Math.min(100, (intervalsLength(intervals) / session.duration_s) * 100);

  const fail = async (reason: string, signal?: { type: string; severity: 'low' | 'medium' | 'high' }) => {
    await db.prepare(
      `UPDATE watch_sessions SET status = 'failed', ended_at = ?, failure_reason = ?, watched_pct = ? WHERE id = ? AND status = 'active'`
    ).bind(now, reason, pct, sid).run();
    if (signal) await recordSignal(db, session.user_id, signal.type, signal.severity, { session_id: sid }, sid);
    await bumpVelocity(db, `user:${session.user_id}:completions:86400`, 86400);
    return { status: 'failed' as const, reason };
  };

  // Attention: every presented check must have passed.
  const checks = await db.prepare(
    'SELECT id, check_type, presented_at, passed FROM attention_checks WHERE session_id = ?'
  ).bind(sid).all<{ id: string; check_type: string; presented_at: number | null; passed: number | null }>();
  const presented = checks.results.filter((c) => c.presented_at != null);
  if (presented.some((c) => c.passed !== 1)) {
    return fail('attention_failed', { type: 'check_failed', severity: 'medium' });
  }
  // Checks that became due (position passed) but were never presented → fail.
  const dueUnpresented = await db.prepare(
    `SELECT COUNT(*) AS n FROM attention_checks
     WHERE session_id = ? AND presented_at IS NULL AND scheduled_at_s <= ?`
  ).bind(sid, session.last_position_s).first<{ n: number }>();
  if ((dueUnpresented?.n ?? 0) > 0) {
    return fail('attention_missed', { type: 'check_failed', severity: 'medium' });
  }

  if (pct < completionPct) return fail('under_watched');
  if (await hasOpenHighSeverity(db, session.user_id, sid)) {
    return fail('fraud_hold', { type: 'completion_blocked', severity: 'high' });
  }
  const wallMax = session.duration_s + grace + session.total_buffering_s;
  if (now - session.started_at > wallMax) {
    return fail('clock_anomaly', { type: 'impossible_travel', severity: 'medium' });
  }

  // All good — credit atomically. Fetch campaign price.
  const campaign = await db.prepare(
    'SELECT price_per_view_cents, advertiser_cpc_cents FROM campaigns WHERE id = ?'
  ).bind(session.campaign_id).first<{ price_per_view_cents: number; advertiser_cpc_cents: number }>();
  if (!campaign) return fail('campaign_gone');
  const price = campaign.price_per_view_cents;
  const groupId = `earn:${sid}`;

  // Attention score: tap=0.5 weight, quiz=1.0, over checks the watcher faced.
  const presentedChecks = checks.results.filter((c) => c.presented_at != null);
  const weight = (t: string) => (t === 'quiz' ? 1 : 0.5);
  const wAll = presentedChecks.reduce((s, c) => s + weight(c.check_type), 0);
  const wPassed = presentedChecks.filter((c) => c.passed === 1).reduce((s, c) => s + weight(c.check_type), 0);
  const attentionScore = wAll > 0 ? Math.min(1, wPassed / wAll) : 1;

  // Ledger post FIRST (idempotent on groupId — losers of a completion race
  // dedupe here safely), then a GUARDED status flip so exactly one caller
  // applies the campaign spend / assignment / daily aggregates.
  try {
    await postEntries(db, groupId, [
      { accountId: accountIdForCampaign(session.campaign_id), side: 'debit', amountCents: price, entryType: 'EARN_CREDIT', refType: 'watch_session', refId: sid, memo: `View credit (${pct.toFixed(1)}% watched)` },
      { accountId: accountIdForUser(session.user_id), side: 'credit', amountCents: price, entryType: 'EARN_CREDIT', refType: 'watch_session', refId: sid, memo: `View credit (${pct.toFixed(1)}% watched)` },
    ], now);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'insufficient_funds') {
      return fail('campaign_insolvent');
    }
    throw err;
  }

  // Guarded flip first: exactly one concurrent caller wins (changes === 1).
  // Only the winner applies campaign spend + assignment. Losers skip straight
  // to the receipt — no double credit (idempotent group_id), no double spend.
  // (Crash between flip and spend would under-count pacing by one view; the
  // ledger remains the source of truth. See docs/DECISIONS.md #33.)
  const flip = await db.prepare(
    `UPDATE watch_sessions SET status='completed', ended_at=?, watched_pct=?, attention_score=?, credit_group_id=?
     WHERE id=? AND status='active'`
  ).bind(now, pct, attentionScore, groupId, sid).run();

  if (flip.changes === 1) {
    const assignment = await db.prepare('SELECT id FROM assignments WHERE id = ?')
      .bind(session.assignment_id).first<{ id: string }>();
    const stmts = [
      db.prepare(`UPDATE campaigns SET spent_cents = spent_cents + ?, reserved_cents = MAX(0, reserved_cents - ?) WHERE id = ?`)
        .bind(price, price, session.campaign_id),
    ];
    if (assignment) {
      stmts.push(db.prepare(`UPDATE assignments SET status='completed', completed_at=? WHERE id=?`).bind(now, session.assignment_id));
    }
    await db.batch(stmts);
    const day = new Date(now * 1000).toISOString().slice(0, 10);
    await db.prepare(
      `INSERT INTO campaign_daily_spend (campaign_id, day, spent_cents, views) VALUES (?, ?, ?, 1)
       ON CONFLICT(campaign_id, day) DO UPDATE SET spent_cents = spent_cents + ?, views = views + 1`
    ).bind(session.campaign_id, day, price, price).run();
    await bumpVelocity(db, `user:${session.user_id}:completions:3600`, 3600);
    await bumpVelocity(db, `user:${session.user_id}:completions:86400`, 86400);
  }
  // Losers of the race (flip.changes === 0): side effects already applied by the
  // winner — just return the current receipt. Idempotent by construction.

  const done = (await getSession(db, sid))!;
  return { status: 'completed', credited_cents: price, receipt: await buildReceipt(db, done) };
}

async function creditedFor(db: DbAdapter, session: SessionRow): Promise<number> {
  if (!session.credit_group_id) return 0;
  const row = await db.prepare(
    `SELECT amount_cents FROM ledger_entries WHERE group_id = ? AND side = 'credit' LIMIT 1`
  ).bind(session.credit_group_id).first<{ amount_cents: number }>();
  return row?.amount_cents ?? 0;
}

export async function buildReceipt(db: DbAdapter, session: SessionRow): Promise<Record<string, unknown>> {
  const campaign = await db.prepare('SELECT id, title, advertiser_id FROM campaigns WHERE id = ?')
    .bind(session.campaign_id).first<{ id: string; title: string; advertiser_id: string }>();
  const advertiser = campaign ? await db.prepare(
    'SELECT company_name FROM advertiser_profiles WHERE user_id = ?'
  ).bind(campaign.advertiser_id).first<{ company_name: string }>() : null;
  const checks = await db.prepare(
    'SELECT check_type, passed FROM attention_checks WHERE session_id = ?'
  ).bind(session.id).all<{ check_type: string; passed: number | null }>();
  const user = await db.prepare('SELECT country_code FROM users WHERE id = ?')
    .bind(session.user_id).first<{ country_code: string }>();
  const passed = checks.results.filter((c) => c.passed === 1).length;
  return {
    session_id: session.id,
    campaign: campaign ? { id: campaign.id, title: campaign.title, advertiser: advertiser?.company_name ?? 'Unknown' } : null,
    video_id: session.video_id,
    watched_pct: Math.round(session.watched_pct * 10) / 10,
    attention_score: session.attention_score == null ? null : Math.round(session.attention_score * 100),
    checks_passed: passed,
    checks_total: checks.results.length,
    credited_cents: await creditedFor(db, session),
    country: user?.country_code ?? null,
    device_fp: session.device_fp ? session.device_fp.slice(0, 12) + '…' : null,
    completed_at: session.ended_at,
  };
}
