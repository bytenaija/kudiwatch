// Cron tasks (expiry, payout processing, retention). Runs via:
//   - Workers: the `scheduled` handler (see index.ts)
//   - Local: setInterval in apps/api/src/local/server.ts + POST /_dev/cron
//   - Manual: `npm run cron`
import { nowSec, uuid, queryAll, queryOne } from './db.js';
import { getConfigNum } from './config.js';
import type { Env } from '../types.js';
import { postEntries, accountIdForUser, PAYOUT_CLEARING_ACCOUNT, PAYOUT_SETTLED_ACCOUNT, LedgerError } from './ledger.js';
import { getPayoutAdapter, redactDestination, type PayoutMethod, type PayoutDestination } from './payouts.js';
import { abandonSession, getSession } from './verify.js';
import { recordSignal } from './fraud.js';

export interface CronReport {
  expired_offers: number;
  expired_sessions: number;
  payouts_processed: number;
  payouts_completed: number;
  payouts_failed: number;
  heartbeats_purged: number;
}

export async function runCrons(env: Env): Promise<CronReport> {
  const db = env.DB;
  const report: CronReport = {
    expired_offers: 0, expired_sessions: 0, payouts_processed: 0,
    payouts_completed: 0, payouts_failed: 0, heartbeats_purged: 0,
  };
  const now = nowSec();

  // 1. Stale offers → expired.
  {
    const rows = await queryAll<{ id: string }>(
      db, `SELECT id FROM assignments WHERE status = 'offered' AND claim_deadline <= ?`, now);
    for (const r of rows) {
      await db.prepare(`UPDATE assignments SET status = 'expired' WHERE id = ? AND status = 'offered'`).bind(r.id).run();
      report.expired_offers++;
    }
  }

  // 2. Silent active sessions (no heartbeat for session_silence_timeout_s) → expired, release reservation.
  {
    const silence = await getConfigNum(db, 'session_silence_timeout_s');
    const rows = await queryAll<{ id: string }>(
      db,
      `SELECT ws.id FROM watch_sessions ws
       WHERE ws.status = 'active'
         AND (ws.last_hb_ts IS NULL AND ws.started_at <= ? OR ws.last_hb_ts <= ?)`,
      now - silence, now - silence);
    for (const r of rows) {
      const sess = await getSession(db, r.id);
      if (!sess) continue;
      await abandonSession(db, sess, 'expired', 'silence_timeout');
      await recordSignal(db, sess.user_id, 'session_silence', 'low', { session_id: r.id });
      report.expired_sessions++;
    }
  }

  // 3. Payouts: approved → processing → adapter → completed/failed (+auto-refund).
  {
    const rows = await queryAll<{
      id: string; user_id: string; amount_cents: number; method: string; destination: string;
    }>(db, `SELECT id, user_id, amount_cents, method, destination FROM payouts WHERE status = 'approved' ORDER BY created_at ASC LIMIT 20`);
    for (const p of rows) {
      report.payouts_processed++;
      await db.prepare(`UPDATE payouts SET status = 'processing' WHERE id = ? AND status = 'approved'`).bind(p.id).run();
      const method = p.method as PayoutMethod;
      const adapter = getPayoutAdapter(db, method);
      const destination = JSON.parse(p.destination) as PayoutDestination;
      const redacted = redactDestination(destination);
      let result;
      try {
        result = await adapter.execute({ payoutId: p.id, amountCents: p.amount_cents, destination });
      } catch (err) {
        result = { ok: false as const, error: `adapter_threw: ${(err as Error).message}`, retryable: true };
      }
      await db.prepare(
        `INSERT INTO payout_attempts (id, payout_id, adapter, request, response, ok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(uuid(), p.id, `mock-${method}`,
        JSON.stringify({ payoutId: p.id, amountCents: p.amount_cents, destination: redacted }),
        JSON.stringify(result), result.ok ? 1 : 0, now).run();

      if (result.ok) {
        // Money left the system (mock): move the held amount from the payout
        // clearing account to the settled sink. Watcher balance unchanged.
        await postEntries(db, `payout-release:${p.id}`, [
          { accountId: PAYOUT_CLEARING_ACCOUNT, side: 'debit', amountCents: p.amount_cents, entryType: 'PAYOUT_RELEASE', refType: 'payout', refId: p.id, memo: `Sent via mock-${method} txRef=${result.txRef}` },
          { accountId: PAYOUT_SETTLED_ACCOUNT, side: 'credit', amountCents: p.amount_cents, entryType: 'PAYOUT_RELEASE', refType: 'payout', refId: p.id, memo: `Sent via mock-${method} txRef=${result.txRef}` },
        ], now);
        await db.prepare(`UPDATE payouts SET status = 'completed', completed_at = ? WHERE id = ?`).bind(now, p.id).run();
        report.payouts_completed++;
      } else if (result.retryable) {
        // Leave in processing for the next cron pass (bounded retries: 3 attempts).
        const attempts = await queryOne<{ n: number }>(
          db, 'SELECT COUNT(*) AS n FROM payout_attempts WHERE payout_id = ?', p.id);
        if ((attempts?.n ?? 0) >= 3) {
          await refundPayout(db, p, 'adapter_failed', result.error);
          report.payouts_failed++;
        } else {
          await db.prepare(`UPDATE payouts SET status = 'approved' WHERE id = ? AND status = 'processing'`).bind(p.id).run();
        }
      } else {
        await refundPayout(db, p, 'adapter_failed', result.error);
        report.payouts_failed++;
      }
    }
  }

  // 4. Heartbeat retention purge.
  {
    const days = await getConfigNum(db, 'heartbeat_retention_days');
    const res = await db.prepare('DELETE FROM heartbeats WHERE server_ts < ?').bind(now - days * 86400).run();
    report.heartbeats_purged = res.changes;
  }

  return report;
}

async function refundPayout(
  db: Env['DB'], p: { id: string; user_id: string; amount_cents: number }, reason: string, detail?: string
): Promise<void> {
  const now = nowSec();
  try {
    await postEntries(db, `payout-refund:${p.id}`, [
      { accountId: PAYOUT_CLEARING_ACCOUNT, side: 'debit', amountCents: p.amount_cents, entryType: 'PAYOUT_REFUND', refType: 'payout', refId: p.id, memo: `Auto-refund: ${reason}` },
      { accountId: accountIdForUser(p.user_id), side: 'credit', amountCents: p.amount_cents, entryType: 'PAYOUT_REFUND', refType: 'payout', refId: p.id, memo: `Auto-refund: ${reason}` },
    ], now);
    await db.prepare(`UPDATE payouts SET status = 'refunded', decision_note = ? WHERE id = ?`)
      .bind(`${reason}${detail ? `: ${detail}` : ''}`, p.id).run();
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err;
    await db.prepare(`UPDATE payouts SET status = 'failed', decision_note = ? WHERE id = ?`)
      .bind(`refund_failed: ${err.code}`, p.id).run();
  }
}
