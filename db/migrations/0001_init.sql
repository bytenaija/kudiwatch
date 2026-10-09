-- KudiWatch D1 schema — 0001_init.sql
-- Money = INTEGER USD cents. Timestamps = INTEGER unix seconds (UTC).
-- ids = TEXT (crypto.randomUUID()).
-- Applies cleanly to D1 AND local SQLite (node:sqlite).

PRAGMA journal_mode=WAL;

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  phone_e164       TEXT NOT NULL UNIQUE,
  phone_verified_at INTEGER NOT NULL,
  country_code     TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  roles            TEXT NOT NULL DEFAULT '["watcher"]',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','warned','suspended','banned')),
  default_device_fp TEXT,
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE phone_verifications (
  id           TEXT PRIMARY KEY,
  phone_e164   TEXT NOT NULL,
  otp_hash     TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  locked_until INTEGER,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_pv_phone ON phone_verifications(phone_e164);

CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  refresh_hash TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_as_user ON auth_sessions(user_id);

CREATE TABLE devices (
  fingerprint_hash TEXT PRIMARY KEY,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  account_count    INTEGER NOT NULL DEFAULT 1,
  risk             TEXT NOT NULL DEFAULT 'unknown' CHECK (risk IN ('unknown','ok','review','blocked')),
  notes            TEXT
);

CREATE TABLE advertiser_profiles (
  user_id      TEXT PRIMARY KEY REFERENCES users(id),
  company_name TEXT NOT NULL,
  contact_email TEXT,
  created_at   INTEGER NOT NULL
);

CREATE TABLE videos (
  id             TEXT PRIMARY KEY,
  advertiser_id  TEXT NOT NULL REFERENCES users(id),
  r2_key         TEXT NOT NULL UNIQUE,
  sha256         TEXT NOT NULL,
  duration_s     REAL NOT NULL,
  width          INTEGER, height INTEGER,
  size_bytes     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'uploaded'
                 CHECK (status IN ('uploaded','in_review','approved','rejected','archived')),
  rejection_reason TEXT,
  quiz           TEXT,
  reviewed_by    TEXT REFERENCES users(id),
  reviewed_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_videos_status ON videos(status);

CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  advertiser_id       TEXT NOT NULL REFERENCES users(id),
  video_id            TEXT NOT NULL REFERENCES videos(id),
  title               TEXT NOT NULL,
  price_per_view_cents INTEGER NOT NULL,
  advertiser_cpc_cents INTEGER NOT NULL,
  budget_cents        INTEGER NOT NULL,
  spent_cents         INTEGER NOT NULL DEFAULT 0,
  reserved_cents      INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_review','live','paused','exhausted','ended')),
  targeting           TEXT NOT NULL DEFAULT '{}',
  daily_cap           INTEGER NOT NULL DEFAULT 1000,
  per_user_cap        INTEGER NOT NULL DEFAULT 1,
  starts_at           INTEGER, ends_at INTEGER,
  priority            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_status ON campaigns(status);

CREATE TABLE campaign_daily_spend (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  day         TEXT NOT NULL,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

CREATE TABLE assignments (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'offered'
               CHECK (status IN ('offered','claimed','completed','expired','skipped')),
  offered_at   INTEGER NOT NULL,
  claim_deadline INTEGER NOT NULL,
  claimed_at   INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_assign_user ON assignments(user_id, status);
CREATE INDEX idx_assign_campaign_user ON assignments(campaign_id, user_id, status);

CREATE TABLE watch_sessions (
  id              TEXT PRIMARY KEY,
  assignment_id   TEXT NOT NULL UNIQUE REFERENCES assignments(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  video_id        TEXT NOT NULL REFERENCES videos(id),
  token_jti       TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','failed','expired','invalidated')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_s      REAL NOT NULL,
  watched_intervals TEXT NOT NULL DEFAULT '[]',
  watched_pct     REAL NOT NULL DEFAULT 0,
  attention_score REAL,
  credit_group_id TEXT,
  failure_reason  TEXT,
  ip              TEXT, asn INTEGER,
  device_fp       TEXT,
  -- Implementation bookkeeping (not in the deepdive's column list; speeds up
  -- heartbeat validation to a single-row read+update). See docs/DECISIONS.md.
  last_seq        INTEGER NOT NULL DEFAULT 0,
  last_position_s REAL NOT NULL DEFAULT 0,
  last_hb_ts      INTEGER,
  total_buffering_s REAL NOT NULL DEFAULT 0,
  bytes_served    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_ws_user ON watch_sessions(user_id, status);
CREATE INDEX idx_ws_status ON watch_sessions(status);

CREATE TABLE heartbeats (
  session_id  TEXT NOT NULL REFERENCES watch_sessions(id),
  seq         INTEGER NOT NULL,
  client_ts   INTEGER NOT NULL,
  server_ts   INTEGER NOT NULL,
  position_s  REAL NOT NULL,
  visible     INTEGER NOT NULL,
  playback_rate REAL NOT NULL,
  buffering_s REAL NOT NULL DEFAULT 0,
  accepted    INTEGER NOT NULL,
  reject_code TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE attention_checks (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES watch_sessions(id),
  check_type  TEXT NOT NULL CHECK (check_type IN ('tap','quiz')),
  scheduled_at_s REAL NOT NULL,
  presented_at INTEGER,
  due_at      INTEGER,
  responded_at INTEGER,
  passed      INTEGER,
  payload     TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_ac_session ON attention_checks(session_id);

CREATE TABLE ledger_accounts (
  id         TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','campaign','platform','clearing')),
  owner_id   TEXT,
  currency   TEXT NOT NULL DEFAULT 'USD',
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  version    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE ledger_entries (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  account_id  TEXT NOT NULL REFERENCES ledger_accounts(id),
  side        TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  entry_type  TEXT NOT NULL CHECK (entry_type IN (
    'EARN_CREDIT','EARN_REVERSAL','PAYOUT_HOLD','PAYOUT_RELEASE','PAYOUT_REFUND',
    'ADJUSTMENT','FUND_TOPUP','CAMPAIGN_ESCROW','CAMPAIGN_SPEND','PLATFORM_FEE')),
  ref_type    TEXT, ref_id TEXT,
  memo        TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE(group_id, account_id, side)
);
CREATE INDEX idx_le_group ON ledger_entries(group_id);
CREATE INDEX idx_le_account ON ledger_entries(account_id, created_at);
CREATE INDEX idx_le_ref ON ledger_entries(ref_type, ref_id);

CREATE TABLE payouts (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 100),
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
CREATE INDEX idx_payouts_status ON payouts(status, created_at);
CREATE INDEX idx_payouts_user ON payouts(user_id, created_at);

CREATE TABLE payout_attempts (
  id         TEXT PRIMARY KEY,
  payout_id  TEXT NOT NULL REFERENCES payouts(id),
  adapter    TEXT NOT NULL,
  request    TEXT NOT NULL,
  response   TEXT,
  ok         INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE fraud_signals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  session_id  TEXT REFERENCES watch_sessions(id),
  signal_type TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('low','medium','high')),
  details     TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_fs_user ON fraud_signals(user_id, created_at);

CREATE TABLE account_flags (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL CHECK (action IN ('warn','suspend','ban')),
  reason     TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER, resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_af_user ON account_flags(user_id);

CREATE TABLE asn_reputation (
  asn   INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  risk  TEXT NOT NULL CHECK (risk IN ('allow','review','block')),
  notes TEXT
);

CREATE TABLE admin_audit_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  target_type TEXT, target_id TEXT,
  diff       TEXT NOT NULL DEFAULT '{}',
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_admin ON admin_audit_log(admin_id, created_at);

CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);

CREATE TABLE velocity_windows (
  scope      TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, window_start)
);

-- Dev-only: last mock OTP per phone. NEVER read in prod code paths;
-- exposed only through /_dev routes (not mounted when ENV_NAME=prod).
CREATE TABLE dev_last_otp (
  phone_e164 TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
