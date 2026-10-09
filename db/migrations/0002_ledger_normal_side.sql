-- 0002: per-account normal balance side (credit-normal vs debit-normal).
-- Credit-normal: user wallets, campaign escrow, fees, payout clearing (credit adds).
-- Debit-normal: the mock-funding receivable — an asset: the fake processor "owes" us,
-- so a debit increases it. Without this, mock top-ups can't be double-entry clean.

ALTER TABLE ledger_accounts ADD COLUMN normal_side TEXT NOT NULL DEFAULT 'credit'
  CHECK (normal_side IN ('credit', 'debit'));
UPDATE ledger_accounts SET normal_side = 'debit' WHERE id = 'clearing:mock-funding';
