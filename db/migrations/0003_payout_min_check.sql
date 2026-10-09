-- 0003: relax payouts.amount_cents CHECK from >= 100 to > 0.
-- The $1.00 minimum is a TUNABLE product rule enforced in app code via
-- config.min_payout_cents (admin UI included); the table keeps only the
-- positivity invariant so tests/QA can lower the min without a schema change.
PRAGMA foreign_keys=OFF;

CREATE TABLE payouts_new (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  currency        TEXT NOT NULL DEFAULT 'USD',
  method          TEXT NOT NULL CHECK (method IN ('mpesa','bank','airtime','usdt')),
  destination     TEXT NOT NULL,
  destination_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  fee_cents       INTEGER NOT NULL DEFAULT 0,
  fx_rate         REAL,
  status          TEXT NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review','approved','processing','completed','failed','rejected','refunded')),
  hold_group_id   TEXT,
  reviewed_by     TEXT REFERENCES users(id),
  decided_at      INTEGER,
  decision_note   TEXT,
  completed_at    INTEGER,
  created_at      INTEGER NOT NULL
);

INSERT INTO payouts_new
  (id, user_id, amount_cents, currency, method, destination, destination_hash,
   idempotency_key, fee_cents, fx_rate, status, hold_group_id, reviewed_by,
   decided_at, decision_note, completed_at, created_at)
SELECT
  id, user_id, amount_cents, currency, method, destination, destination_hash,
  idempotency_key, fee_cents, fx_rate, status, hold_group_id, reviewed_by,
  decided_at, decision_note, completed_at, created_at
FROM payouts;

DROP TABLE payouts;
ALTER TABLE payouts_new RENAME TO payouts;
CREATE INDEX idx_payouts_status ON payouts(status, created_at);
CREATE INDEX idx_payouts_user ON payouts(user_id, created_at);

PRAGMA foreign_keys=ON;
