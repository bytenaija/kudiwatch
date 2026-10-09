// SMS adapter interface + mock. Real providers (Twilio/Africa's Talking)
// implement SmsAdapter at gate 2; the swap is mechanical.
import { hmacSha256Hex, randomDigits, timingSafeEqual } from './crypto.js';
import { nowSec, uuid, type DbAdapter } from './db.js';
import { getConfigNum } from './config.js';

export interface SmsAdapter {
  readonly name: string;
  sendOtp(phoneE164: string, code: string): Promise<{ ok: boolean; error?: string }>;
}

/** Mock: logs to console + records in dev_last_otp (read via GET /_dev/last-otp). */
export class MockSmsAdapter implements SmsAdapter {
  readonly name = 'mock-sms';
  constructor(private db: DbAdapter) {}
  async sendOtp(phoneE164: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const now = nowSec();
    console.log(`[mock-sms] OTP for ${phoneE164}: ${code}`);
    await this.db.prepare(
      `INSERT INTO dev_last_otp (phone_e164, code, created_at) VALUES (?, ?, ?)
       ON CONFLICT(phone_e164) DO UPDATE SET code = excluded.code, created_at = excluded.created_at`
    ).bind(phoneE164, code, now).run();
    return { ok: true };
  }
}

export async function getLastDevOtp(db: DbAdapter, phoneE164: string): Promise<string | null> {
  const row = await db.prepare('SELECT code FROM dev_last_otp WHERE phone_e164 = ?')
    .bind(phoneE164).first<{ code: string }>();
  return row?.code ?? null;
}

export interface OtpRequestResult {
  ok: boolean;
  resendAfterSec: number;
  /** Only in non-prod: the code, so scripted E2E doesn't need the dev endpoint. */
  devCode?: string;
}

/** Issue a new OTP for a phone number. Always 200 to the caller (no enumeration). */
export async function requestOtp(
  db: DbAdapter, sms: SmsAdapter, pepper: string, phoneE164: string, envName: string
): Promise<OtpRequestResult> {
  const now = nowSec();
  const cooldown = await getConfigNum(db, 'otp_resend_cooldown_s');
  const ttl = await getConfigNum(db, 'otp_ttl_s');

  const last = await db.prepare(
    'SELECT created_at FROM phone_verifications WHERE phone_e164 = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1'
  ).bind(phoneE164).first<{ created_at: number }>();
  if (last && now - last.created_at < cooldown) {
    return { ok: true, resendAfterSec: cooldown - (now - last.created_at) };
  }

  const code = randomDigits(6);
  const otpHash = await hmacSha256Hex(pepper, code);
  await db.prepare(
    `INSERT INTO phone_verifications (id, phone_e164, otp_hash, attempts, expires_at, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).bind(uuid(), phoneE164, otpHash, now + ttl, now).run();
  await sms.sendOtp(phoneE164, code);
  const result: OtpRequestResult = { ok: true, resendAfterSec: cooldown };
  if (envName !== 'prod') result.devCode = code;
  return result;
}

export interface OtpVerifyResult {
  ok: boolean;
  code: 'ok' | 'expired' | 'mismatch' | 'locked' | 'attempts_exceeded';
  attemptsLeft?: number;
}

/** Verify an OTP. 5 wrong attempts → 1 h lock (high-severity signal upstream). */
export async function verifyOtp(
  db: DbAdapter, pepper: string, phoneE164: string, code: string
): Promise<OtpVerifyResult> {
  const now = nowSec();
  const maxAttempts = await getConfigNum(db, 'otp_max_attempts');
  const lockSec = await getConfigNum(db, 'otp_lock_s');

  const row = await db.prepare(
    `SELECT id, otp_hash, attempts, expires_at, locked_until, consumed_at
     FROM phone_verifications WHERE phone_e164 = ? AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`
  ).bind(phoneE164).first<{
    id: string; otp_hash: string; attempts: number; expires_at: number;
    locked_until: number | null; consumed_at: number | null;
  }>();
  if (!row) return { ok: false, code: 'mismatch', attemptsLeft: maxAttempts - 1 };
  if (row.locked_until && row.locked_until > now) return { ok: false, code: 'locked' };
  if (row.expires_at <= now) return { ok: false, code: 'expired' };

  const expected = await hmacSha256Hex(pepper, code);
  if (!timingSafeEqual(expected, row.otp_hash)) {
    const attempts = row.attempts + 1;
    const lockedUntil = attempts >= maxAttempts ? now + lockSec : null;
    await db.prepare('UPDATE phone_verifications SET attempts = ?, locked_until = ? WHERE id = ?')
      .bind(attempts, lockedUntil, row.id).run();
    if (lockedUntil) return { ok: false, code: 'attempts_exceeded' };
    return { ok: false, code: 'mismatch', attemptsLeft: Math.max(0, maxAttempts - attempts) };
  }
  await db.prepare('UPDATE phone_verifications SET consumed_at = ? WHERE id = ?')
    .bind(now, row.id).run();
  return { ok: true, code: 'ok' };
}
