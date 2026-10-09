// Unit tests: ledger invariants + heartbeat interval math (pure logic, no server).
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteAdapter } from '../src/local/sqlite.js';
import { postEntries, getBalance, LedgerError, type LedgerEntryInput } from '../src/lib/ledger.js';
import { unionInterval, intervalsLength, parseIntervals } from '../src/lib/verify.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');

function freshDb(): SqliteAdapter {
  const db = new SqliteAdapter(new DatabaseSync(':memory:'));
  return db;
}

async function migrated(): Promise<SqliteAdapter> {
  const db = freshDb();
  const { readdirSync } = await import('node:fs');
  const files = readdirSync(resolve(ROOT, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db.exec(readFileSync(resolve(ROOT, 'db/migrations', f), 'utf8'));
  return db;
}

describe('ledger', () => {
  let db: SqliteAdapter;
  beforeEach(async () => { db = await migrated(); });

  it('posts a balanced group and updates balances', async () => {
    // Seed the campaign account with escrow first.
    await postEntries(db, 'seed-escrow', [
      { accountId: 'clearing:mock-funding', side: 'debit', amountCents: 1000, entryType: 'FUND_TOPUP' },
      { accountId: 'campaign:c1', side: 'credit', amountCents: 1000, entryType: 'CAMPAIGN_ESCROW' },
    ]);
    await postEntries(db, 'earn:s1', [
      { accountId: 'campaign:c1', side: 'debit', amountCents: 2, entryType: 'EARN_CREDIT', refType: 'watch_session', refId: 's1' },
      { accountId: 'user:u1', side: 'credit', amountCents: 2, entryType: 'EARN_CREDIT', refType: 'watch_session', refId: 's1' },
    ]);
    expect(await getBalance(db, 'user:u1')).toBe(2);
    expect(await getBalance(db, 'campaign:c1')).toBe(998);
    expect(await getBalance(db, 'clearing:mock-funding')).toBe(1000); // debit-normal asset
  });

  it('rejects unbalanced groups', async () => {
    await expect(postEntries(db, 'bad', [
      { accountId: 'user:u1', side: 'credit', amountCents: 5, entryType: 'ADJUSTMENT' },
      { accountId: 'campaign:c1', side: 'debit', amountCents: 4, entryType: 'ADJUSTMENT' },
    ])).rejects.toMatchObject({ code: 'unbalanced' });
  });

  it('fails closed on insufficient funds (no negative balances)', async () => {
    await expect(postEntries(db, 'overdraw', [
      { accountId: 'user:u1', side: 'debit', amountCents: 1, entryType: 'PAYOUT_HOLD' },
      { accountId: 'clearing:payouts', side: 'credit', amountCents: 1, entryType: 'PAYOUT_HOLD' },
    ])).rejects.toMatchObject({ code: 'insufficient_funds' });
    expect(await getBalance(db, 'user:u1')).toBe(0);
  });

  it('is idempotent on group_id (double-post returns deduped)', async () => {
    const entries: LedgerEntryInput[] = [
      { accountId: 'clearing:mock-funding', side: 'debit', amountCents: 100, entryType: 'FUND_TOPUP' },
      { accountId: 'user:u1', side: 'credit', amountCents: 100, entryType: 'FUND_TOPUP' },
    ];
    const r1 = await postEntries(db, 'idem-1', entries);
    const r2 = await postEntries(db, 'idem-1', entries);
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    expect(await getBalance(db, 'user:u1')).toBe(100); // credited exactly once
  });

  it('property: random balanced batches always balance per group', async () => {
    // Seed funds.
    const seedEntries: LedgerEntryInput[] = [
      { accountId: 'clearing:mock-funding', side: 'debit', amountCents: 1_000_000, entryType: 'FUND_TOPUP' },
      { accountId: 'campaign:c1', side: 'credit', amountCents: 1_000_000, entryType: 'CAMPAIGN_ESCROW' },
    ];
    await postEntries(db, 'seed', seedEntries);
    for (let i = 0; i < 50; i++) {
      const amt = 1 + Math.floor(Math.random() * 50);
      const gid = `prop-${i}`;
      await postEntries(db, gid, [
        { accountId: 'campaign:c1', side: 'debit' as const, amountCents: amt, entryType: 'EARN_CREDIT' as const },
        { accountId: `user:u${i % 7}`, side: 'credit' as const, amountCents: amt, entryType: 'EARN_CREDIT' as const },
      ]);
      // Invariant: sum over the group is zero (debits == credits).
      const rows = await db.prepare(
        `SELECT side, SUM(amount_cents) AS t FROM ledger_entries WHERE group_id = ? GROUP BY side`
      ).bind(gid).all<{ side: string; t: number }>();
      const bySide = Object.fromEntries(rows.results.map((r) => [r.side, r.t]));
      expect(bySide.debit).toBe(bySide.credit);
    }
    // Global invariant: no negative balances anywhere.
    const negs = await db.prepare(
      'SELECT COUNT(*) AS n FROM ledger_accounts WHERE balance_cents < 0'
    ).first<{ n: number }>();
    expect(negs?.n).toBe(0);
  });

  it('payout hold → refund round-trips the watcher balance', async () => {
    await postEntries(db, 'seed2', [
      { accountId: 'clearing:mock-funding', side: 'debit', amountCents: 500, entryType: 'FUND_TOPUP' },
      { accountId: 'campaign:c1', side: 'credit', amountCents: 500, entryType: 'CAMPAIGN_ESCROW' },
    ]);
    await postEntries(db, 'earn', [
      { accountId: 'campaign:c1', side: 'debit', amountCents: 500, entryType: 'EARN_CREDIT' },
      { accountId: 'user:u1', side: 'credit', amountCents: 500, entryType: 'EARN_CREDIT' },
    ]);
    await postEntries(db, 'hold', [
      { accountId: 'user:u1', side: 'debit', amountCents: 200, entryType: 'PAYOUT_HOLD' },
      { accountId: 'clearing:payouts', side: 'credit', amountCents: 200, entryType: 'PAYOUT_HOLD' },
    ]);
    expect(await getBalance(db, 'user:u1')).toBe(300);
    await postEntries(db, 'refund', [
      { accountId: 'clearing:payouts', side: 'debit', amountCents: 200, entryType: 'PAYOUT_REFUND' },
      { accountId: 'user:u1', side: 'credit', amountCents: 200, entryType: 'PAYOUT_REFUND' },
    ]);
    expect(await getBalance(db, 'user:u1')).toBe(500);
    expect(await getBalance(db, 'clearing:payouts')).toBe(0);
  });
});

describe('interval math', () => {
  it('unions overlapping intervals', () => {
    expect(unionInterval([[0, 10]], 5, 15)).toEqual([[0, 15]]);
    expect(unionInterval([[0, 10]], 20, 25)).toEqual([[0, 10], [20, 25]]);
    expect(unionInterval([[0, 10], [20, 30]], 8, 22)).toEqual([[0, 30]]);
    expect(unionInterval([], 3, 7)).toEqual([[3, 7]]);
  });
  it('measures union length', () => {
    expect(intervalsLength([[0, 10], [20, 30]])).toBe(20);
    expect(intervalsLength([])).toBe(0);
  });
  it('parses stored JSON defensively', () => {
    expect(parseIntervals('[]')).toEqual([]);
    expect(parseIntervals('garbage')).toEqual([]);
    expect(parseIntervals('[[0,10],[20,30]]')).toEqual([[0, 10], [20, 30]]);
  });
  it('90% rule: 27s of a 30s video passes, 26s fails', () => {
    const need = 30 * 0.9;
    expect(intervalsLength([[0, 27]]) >= need).toBe(true);
    expect(intervalsLength([[0, 26]]) >= need).toBe(false);
  });
});
