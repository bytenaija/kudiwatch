// Fraud layer: signal recording, velocity windows, ASN reputation, device tracking.
// Posture (DECISIONS.md #20): detect + queue for human review; auto-block only
// the unambiguous (datacenter ASN, emulator UA, OTP brute force).
import { nowSec, uuid, type DbAdapter } from './db.js';
import { getConfigNum } from './config.js';

export type SignalSeverity = 'low' | 'medium' | 'high';

export async function recordSignal(
  db: DbAdapter,
  userId: string,
  signalType: string,
  severity: SignalSeverity,
  details: Record<string, unknown> = {},
  sessionId?: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO fraud_signals (id, user_id, session_id, signal_type, severity, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(uuid(), userId, sessionId ?? null, signalType, severity, JSON.stringify(details), nowSec()).run();
}

export async function countRecentSignals(
  db: DbAdapter, userId: string, sinceSec: number, severities?: SignalSeverity[]
): Promise<number> {
  let sql = 'SELECT COUNT(*) AS n FROM fraud_signals WHERE user_id = ? AND created_at >= ?';
  const args: unknown[] = [userId, sinceSec];
  if (severities && severities.length > 0) {
    sql += ` AND severity IN (${severities.map(() => '?').join(',')})`;
    args.push(...severities);
  }
  const row = await db.prepare(sql).bind(...args).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function hasOpenHighSeverity(
  db: DbAdapter, userId: string, sessionId?: string
): Promise<boolean> {
  let sql = `SELECT 1 FROM fraud_signals WHERE user_id = ? AND severity = 'high'`;
  const args: unknown[] = [userId];
  if (sessionId) { sql += ' AND session_id = ?'; args.push(sessionId); }
  sql += ' LIMIT 1';
  const row = await db.prepare(sql).bind(...args).first();
  return !!row;
}

/**
 * Sliding velocity window. Returns {allowed, count, retryAfterSec}.
 * Scope examples: 'user:<id>:completions:3600', 'ip:<ip>:claims:60'.
 */
export async function checkVelocity(
  db: DbAdapter, scope: string, windowSec: number, limit: number
): Promise<{ allowed: boolean; count: number; retryAfterSec: number }> {
  const now = nowSec();
  const windowStart = now - (now % windowSec);
  const row = await db.prepare(
    'SELECT count, window_start FROM velocity_windows WHERE scope = ? AND window_start = ?'
  ).bind(scope, windowStart).first<{ count: number; window_start: number }>();
  const count = row?.count ?? 0;
  if (count >= limit) {
    return { allowed: false, count, retryAfterSec: windowStart + windowSec - now };
  }
  return { allowed: true, count, retryAfterSec: 0 };
}

export async function bumpVelocity(db: DbAdapter, scope: string, windowSec: number): Promise<number> {
  const now = nowSec();
  const windowStart = now - (now % windowSec);
  await db.prepare(
    `INSERT INTO velocity_windows (scope, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(scope, window_start) DO UPDATE SET count = count + 1`
  ).bind(scope, windowStart).run();
  const row = await db.prepare(
    'SELECT count FROM velocity_windows WHERE scope = ? AND window_start = ?'
  ).bind(scope, windowStart).first<{ count: number }>();
  return row?.count ?? 1;
}

/** ASN reputation lookup. Returns 'allow' when unknown (fail open, flag nothing). */
export async function asnRisk(db: DbAdapter, asn: number | undefined): Promise<'allow' | 'review' | 'block' | null> {
  if (asn == null) return null; // no ASN info (local dev) — skip
  const row = await db.prepare('SELECT risk FROM asn_reputation WHERE asn = ?')
    .bind(asn).first<{ risk: string }>();
  if (!row) return 'allow';
  return row.risk as 'allow' | 'review' | 'block';
}

const EMULATOR_UA = /(sdk_|emulator|generic_x86|android\.test|webdriver|headless)/i;

export function isEmulatorUA(ua: string | undefined): boolean {
  if (!ua) return false;
  return EMULATOR_UA.test(ua);
}

/**
 * Record a device sighting; returns {accountCount, blocked} — blocks when the
 * device already hosts > 2 accounts (deepdive §7: blocks the 3rd claim until
 * admin clears). Callers decide whether to hard-block or flag.
 */
export async function trackDevice(
  db: DbAdapter, fingerprintHash: string, userId: string
): Promise<{ accountCount: number; isNewDevice: boolean }> {
  const now = nowSec();
  const row = await db.prepare(
    'SELECT account_count FROM devices WHERE fingerprint_hash = ?'
  ).bind(fingerprintHash).first<{ account_count: number }>();
  if (!row) {
    await db.prepare(
      `INSERT INTO devices (fingerprint_hash, first_seen_at, last_seen_at, account_count, risk)
       VALUES (?, ?, ?, 1, 'unknown')`
    ).bind(fingerprintHash, now, now).run();
    return { accountCount: 1, isNewDevice: true };
  }
  // Count distinct users already tied to this device (via users.default_device_fp).
  const linked = await db.prepare(
    'SELECT COUNT(DISTINCT id) AS n FROM users WHERE default_device_fp = ? AND id != ?'
  ).bind(fingerprintHash, userId).first<{ n: number }>();
  const accountCount = (linked?.n ?? 0) + 1;
  await db.prepare(
    'UPDATE devices SET last_seen_at = ?, account_count = ? WHERE fingerprint_hash = ?'
  ).bind(now, accountCount, fingerprintHash).run();
  return { accountCount, isNewDevice: false };
}

/** Watcher-side velocity: completions in last hour / day. */
export async function watcherVelocity(
  db: DbAdapter, userId: string
): Promise<{ hour: number; day: number; maxHour: number; maxDay: number }> {
  const now = nowSec();
  const maxHour = await getConfigNum(db, 'max_views_per_hour');
  const maxDay = await getConfigNum(db, 'max_views_per_day');
  const h = await db.prepare(
    `SELECT COUNT(*) AS n FROM watch_sessions WHERE user_id = ? AND status = 'completed' AND ended_at >= ?`
  ).bind(userId, now - 3600).first<{ n: number }>();
  const d = await db.prepare(
    `SELECT COUNT(*) AS n FROM watch_sessions WHERE user_id = ? AND status = 'completed' AND ended_at >= ?`
  ).bind(userId, now - 86400).first<{ n: number }>();
  return { hour: h?.n ?? 0, day: d?.n ?? 0, maxHour, maxDay };
}
