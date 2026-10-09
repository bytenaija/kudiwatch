// Double-entry ledger. Invariants, enforced per group:
//   1. SUM(debits) == SUM(credits) for the group.
//   2. No account balance goes negative (guarded inside the atomic batch).
//   3. Idempotent on group_id (re-post returns {deduped:true}).
// Writes go through ONE atomic db.batch(); balance moves use optimistic-lock
// version guards so concurrent posts either serialize or fail with
// 'version_conflict' (caller retries; retry then hits the idempotency path).
import { uuid, type DbAdapter } from './db.js';

export type EntryType =
  | 'EARN_CREDIT' | 'EARN_REVERSAL' | 'PAYOUT_HOLD' | 'PAYOUT_RELEASE' | 'PAYOUT_REFUND'
  | 'ADJUSTMENT' | 'FUND_TOPUP' | 'CAMPAIGN_ESCROW' | 'CAMPAIGN_SPEND' | 'PLATFORM_FEE';

export interface LedgerEntryInput {
  accountId: string;
  side: 'debit' | 'credit';
  amountCents: number;
  entryType: EntryType;
  refType?: string;
  refId?: string;
  memo?: string;
}

export class LedgerError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export function accountIdForUser(userId: string): string { return `user:${userId}`; }
export function accountIdForCampaign(campaignId: string): string { return `campaign:${campaignId}`; }
export const PLATFORM_FEES_ACCOUNT = 'platform:fees';
export const PAYOUT_CLEARING_ACCOUNT = 'clearing:payouts';
/** Sink for completed (mock-sent) payouts: money has left the system. */
export const PAYOUT_SETTLED_ACCOUNT = 'clearing:payouts-settled';

async function ensureAccount(
  db: DbAdapter, accountId: string, ownerType: string, ownerId: string | null, now: number
): Promise<void> {
  const normalSide = accountId === MOCK_FUNDING_ACCOUNT ? 'debit' : 'credit';
  await db.prepare(
    `INSERT OR IGNORE INTO ledger_accounts (id, owner_type, owner_id, currency, balance_cents, version, normal_side, created_at)
     VALUES (?, ?, ?, 'USD', 0, 0, ?, ?)`
  ).bind(accountId, ownerType, ownerId, normalSide, now).run();
}

function ownerOf(accountId: string): { ownerType: string; ownerId: string | null } {
  if (accountId === PLATFORM_FEES_ACCOUNT) return { ownerType: 'platform', ownerId: 'fees' };
  if (accountId === PAYOUT_CLEARING_ACCOUNT) return { ownerType: 'clearing', ownerId: 'payouts' };
  const idx = accountId.indexOf(':');
  const kind = idx < 0 ? accountId : accountId.slice(0, idx);
  const id = idx < 0 ? null : accountId.slice(idx + 1);
  if (kind === 'user') return { ownerType: 'user', ownerId: id };
  if (kind === 'campaign') return { ownerType: 'campaign', ownerId: id };
  if (kind === 'clearing') return { ownerType: 'clearing', ownerId: id };
  if (kind === 'platform') return { ownerType: 'platform', ownerId: id };
  throw new LedgerError('bad_account', `Unknown account id shape: ${accountId}`);
}

/** Mock funding receivable: the fake card processor "owes" us demo money. */
export const MOCK_FUNDING_ACCOUNT = 'clearing:mock-funding';

/**
 * Post a balanced group of entries atomically.
 * Idempotent: if the group is already fully posted, returns {deduped:true}.
 * Throws LedgerError('insufficient_funds' | 'unbalanced' | 'version_conflict' | ...).
 */
export async function postEntries(
  db: DbAdapter, groupId: string, entries: LedgerEntryInput[], now = Math.floor(Date.now() / 1000)
): Promise<{ ok: true; deduped: boolean }> {
  if (entries.length === 0) throw new LedgerError('empty_group', 'Cannot post an empty entry group');
  let debits = 0, credits = 0;
  for (const e of entries) {
    if (!Number.isInteger(e.amountCents) || e.amountCents <= 0) {
      throw new LedgerError('bad_amount', `amountCents must be a positive integer (got ${e.amountCents})`);
    }
    if (e.side === 'debit') debits += e.amountCents; else credits += e.amountCents;
  }
  if (debits !== credits) {
    throw new LedgerError('unbalanced', `Group ${groupId} unbalanced: debits=${debits} credits=${credits}`);
  }

  // Idempotency: the whole group already posted?
  const existing = await db.prepare(
    'SELECT COUNT(*) AS n FROM ledger_entries WHERE group_id = ?'
  ).bind(groupId).first<{ n: number }>();
  const n = existing?.n ?? 0;
  if (n === entries.length) return { ok: true, deduped: true };
  if (n > 0) {
    throw new LedgerError('partial_group', `Group ${groupId} partially posted (${n}/${entries.length}) — refusing`);
  }

  const accountIds = [...new Set(entries.map((e) => e.accountId))];
  for (const aid of accountIds) {
    const { ownerType, ownerId } = ownerOf(aid);
    await ensureAccount(db, aid, ownerType, ownerId, now);
  }
  const balances = new Map<string, { balance_cents: number; version: number; normal_side: string }>();
  for (const aid of accountIds) {
    const row = await db.prepare(
      'SELECT balance_cents, version, normal_side FROM ledger_accounts WHERE id = ?'
    ).bind(aid).first<{ balance_cents: number; version: number; normal_side: string }>();
    if (!row) throw new LedgerError('missing_account', `Account vanished: ${aid}`);
    balances.set(aid, row);
  }

  // Signed deltas respect each account's normal side:
  // a credit adds to a credit-normal account and subtracts from a debit-normal one.
  const deltas = new Map<string, number>();
  for (const e of entries) {
    const normal = balances.get(e.accountId)!.normal_side;
    const sign = e.side === normal ? 1 : -1;
    deltas.set(e.accountId, (deltas.get(e.accountId) ?? 0) + sign * e.amountCents);
  }
  // Fast fail-closed negative check (the SQL guard below is the real enforcer).
  for (const [aid, d] of deltas) {
    if (balances.get(aid)!.balance_cents + d < 0) {
      throw new LedgerError('insufficient_funds', `Account ${aid} has insufficient funds`);
    }
  }

  const stmts: ReturnType<DbAdapter['prepare']>[] = [];
  for (const e of entries) {
    // Plain INSERT: a duplicate group racing us violates UNIQUE(group_id,account_id,side)
    // and fails the whole atomic batch; the retry then takes the idempotent path.
    stmts.push(db.prepare(
      `INSERT INTO ledger_entries
         (id, group_id, account_id, side, amount_cents, entry_type, ref_type, ref_id, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(uuid(), groupId, e.accountId, e.side, e.amountCents, e.entryType,
      e.refType ?? null, e.refId ?? null, e.memo ?? null, now));
  }
  for (const [aid, d] of deltas) {
    const { version } = balances.get(aid)!;
    stmts.push(db.prepare(
      `UPDATE ledger_accounts
       SET balance_cents = balance_cents + ?, version = version + 1
       WHERE id = ? AND version = ? AND balance_cents + ? >= 0`
    ).bind(d, aid, version, d));
  }

  let results;
  try {
    results = await db.batch(stmts);
  } catch (err) {
    // Unique-violation (racing duplicate post) or any other batch failure.
    // Re-check idempotency: if the winner posted, we report deduped.
    const recheck = await db.prepare(
      'SELECT COUNT(*) AS n FROM ledger_entries WHERE group_id = ?'
    ).bind(groupId).first<{ n: number }>();
    if ((recheck?.n ?? 0) === entries.length) return { ok: true, deduped: true };
    throw new LedgerError('version_conflict', `Group ${groupId}: concurrent write conflict — retry`);
  }
  if (results.some((r) => !r.success || r.changes !== 1)) {
    // Guard clause tripped (version moved or would go negative): batch was atomic,
    // so nothing landed. Re-check idempotency before reporting conflict.
    const recheck = await db.prepare(
      'SELECT COUNT(*) AS n FROM ledger_entries WHERE group_id = ?'
    ).bind(groupId).first<{ n: number }>();
    if ((recheck?.n ?? 0) === entries.length) return { ok: true, deduped: true };
    throw new LedgerError('version_conflict', `Group ${groupId}: concurrent write conflict — retry`);
  }
  return { ok: true, deduped: false };
}

export async function getBalance(db: DbAdapter, accountId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT balance_cents FROM ledger_accounts WHERE id = ?'
  ).bind(accountId).first<{ balance_cents: number }>();
  return row?.balance_cents ?? 0;
}

/** Money currently held in payout review = holds minus refunds on the user account. */
export async function getPendingPayoutCents(db: DbAdapter, userId: string): Promise<number> {
  const rows = await db.prepare(
    `SELECT side, amount_cents FROM ledger_entries
     WHERE account_id = ? AND entry_type IN ('PAYOUT_HOLD','PAYOUT_REFUND')`
  ).bind(accountIdForUser(userId)).all<{ side: string; amount_cents: number }>();
  let pending = 0;
  for (const r of rows.results) {
    if (r.side === 'debit') pending += r.amount_cents;
    else pending -= r.amount_cents;
  }
  return Math.max(0, pending);
}

export async function getLifetimeEarnedCents(db: DbAdapter, userId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(amount_cents),0) AS total FROM ledger_entries
     WHERE account_id = ? AND side = 'credit' AND entry_type = 'EARN_CREDIT'`
  ).bind(accountIdForUser(userId)).first<{ total: number }>();
  return row?.total ?? 0;
}
