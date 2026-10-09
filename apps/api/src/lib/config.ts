// Config table reader with typed defaults. Changes apply immediately, no redeploy.
import { queryOne, type DbAdapter } from './db.js';

const DEFAULTS: Record<string, string> = {
  heartbeat_interval_s: '10',
  completion_pct: '90',
  min_payout_cents: '100',
  max_views_per_hour: '10',
  max_views_per_day: '50',
  otp_ttl_s: '600',
  otp_max_attempts: '5',
  otp_lock_s: '3600',
  otp_resend_cooldown_s: '60',
  session_silence_timeout_s: '60',
  claim_ttl_s: '120',
  watch_token_grace_s: '900',
  attention_timeout_s: '15',
  skip_cooldown_s: '86400',
  heartbeat_retention_days: '90',
  payout_mock_failure_rate: '0',
  mock_fee_mpesa_pct: '1.5',
  mock_fee_bank_flat_cents: '30',
  mock_fee_airtime_pct: '0',
  mock_fee_usdt_flat_cents: '100',
  min_video_duration_s: '15',
  max_video_duration_s: '180',
  max_upload_bytes: '209715200',
};

export async function getConfig(db: DbAdapter, key: string): Promise<string> {
  const row = await queryOne<{ value: string }>(db, 'SELECT value FROM config WHERE key = ?', key);
  return row?.value ?? DEFAULTS[key] ?? '';
}

export async function getConfigNum(db: DbAdapter, key: string): Promise<number> {
  const v = await getConfig(db, key);
  const n = Number(v);
  return Number.isFinite(n) ? n : Number(DEFAULTS[key] ?? 0);
}

export async function getAllConfig(db: DbAdapter): Promise<Record<string, string>> {
  const rows = await db.prepare('SELECT key, value FROM config').all<{ key: string; value: string }>();
  const out: Record<string, string> = { ...DEFAULTS };
  for (const r of rows.results) out[r.key] = r.value;
  return out;
}

export async function setConfig(
  db: DbAdapter, key: string, value: string, updatedBy: string | null, updatedAt: number
): Promise<void> {
  await db.prepare(
    `INSERT INTO config (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(key, value, updatedBy, updatedAt).run();
}
