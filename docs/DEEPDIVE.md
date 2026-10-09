# KudiWatch — Architecture Deepdive

**Status:** build contract for the implementer stage. Concrete: table names, column names, endpoint paths, token formats. Vagueness is failure.
**Date:** 2026-10-08 · **Author:** staff-engineer deepdive (subagent) · **Model decision (founder-approved):** sponsored-attention / offerwall. Advertisers pay for verified human attention on **our own video inventory** (hosted on Cloudflare R2). **We never pay for YouTube views** — that is incentivized traffic under YouTube's Fake Engagement / Invalid Traffic policies (warning → 3 strikes → termination, view stripping, AdSense disablement), and every comparable attempt died (XCAD Network ran out of funds Aug 2026, app delisted; Zynn delisted from both stores).

---

## 1. System architecture

### 1.1 Topology

```
                          ┌─────────────────────────────┐
                          │   Cloudflare Pages (1 proj)  │
                          │   app.kudiwatch.com          │
                          │   /          landing         │
                          │   /app/*     watcher PWA     │
                          │   /advertise/* advertiser SPA│
                          │   /admin/*   admin console   │
                          └──────────────┬──────────────┘
                                         │ HTTPS (fetch)
                          ┌──────────────▼──────────────┐
                          │  Workers — api (Hono)       │
                          │  api.kudiwatch.com/v1/*     │
                          │  ┌───────────────────────┐  │
                          │  │ routes/ (per domain)  │  │
                          │  │ lib/ (auth, ledger,   │  │
                          │  │  verify, assign,      │  │
                          │  │  fraud, payouts)      │  │
                          │  └───────────────────────┘  │
                          └──────┬──────────────┬───────┘
                    ┌────────────▼────┐  ┌──────▼──────────┐
                    │  D1: kudiwatch  │  │ R2: kw-videos   │
                    │  (SQLite, all   │  │ (source MP4s,   │
                    │   relational    │  │  served ONLY via│
                    │   state)        │  │  signed Worker  │
                    └─────────────────┘  │  stream URLs)   │
                                         └─────────────────┘
```

**Why one Worker, not many:** at MVP scale a single Hono Worker keeps deploys, migrations, and the ledger transaction boundary trivial. Split only when a route needs different scaling (the `/stream` route is the first split candidate post-MVP).

**Why one Pages project:** three SPAs under path prefixes (`/app`, `/advertise`, `/admin`) share auth code, design tokens, and one deploy pipeline. Split only if bundle size hurts the watcher PWA on cheap Androids.

### 1.2 Where the PWA lives / where video is served from

- **PWA** (`/app/*`): installable, mobile-first, offline shell via service worker (app shell cached; video always streamed, never cached — see §7). Target: Chrome/Android WebView on sub-$150 Android devices, 3G-class networks. Budget: first paint < 3 s on Moto-G-class, total JS < 300 KB gz.
- **Video serving:** `GET /v1/stream/:videoId?wt=<watch-token>` on the API Worker. The Worker validates the watch token, then streams bytes from R2 with `Range` support (206 partial content), `Accept-Ranges`, and `Cache-Control: private, no-store`. **R2 has no public access and no direct URLs** — every byte flows through token validation. This is the anti-hotlink/anti-rip boundary.
- **Uploads (advertiser):** direct-to-R2 via **SigV4 presigned PUT URLs** minted by the Worker (R2 S3-compatible API; credentials in Worker secrets, 15-min expiry). Bytes never transit the Worker on upload (avoids Worker body-size limits); download always transits the Worker.

### 1.3 Request flows

**Watch-and-earn (happy path):**
1. PWA `GET /v1/feed/next` (auth cookie) → server runs assignment query (§8) → returns `{assignment_id, video_id, campaign meta, stream_url template}`.
2. PWA `POST /v1/assignments/:id/claim` → server creates `watch_sessions` row (status `active`), reserves budget (ledger hold), returns **watch token JWT** + scheduled attention-check times.
3. Player loads `GET /v1/stream/:videoId?wt=<watch-token>`; HTML5 `<video>` plays at 1x.
4. Every 10 s: `POST /v1/watch/:sid/heartbeat {seq, position_s, visible, rate}` → server validates continuity (§7.3), appends watched interval.
5. At server-scheduled times: attention check overlay → `POST /v1/watch/:sid/attention`.
6. On `ended` or ≥90% watched: `POST /v1/watch/:sid/complete` → server verifies (intervals ≥90%, checks passed, no fraud flags) → **idempotent double-entry credit** → assignment `completed`.

**Advertiser funding → campaign:**
1. `POST /v1/advertiser/videos/upload-url` → presigned PUT → browser PUTs MP4 to R2 → `POST /v1/advertiser/videos/:id/confirm` (sha256, duration from browser metadata).
2. Admin reviews (`pending_review` → `approved`).
3. Advertiser `POST /v1/advertiser/wallet/topup {amount_cents}` → **mock funding adapter** → ledger credit to advertiser account.
4. Advertiser `POST /v1/advertiser/campaigns {video_id, price_per_view_cents, budget_cents, targeting, caps}` → campaign `live` (if video approved + balance covers budget → budget moved to campaign escrow account).

**Payout:**
1. Watcher `POST /v1/payouts {method, destination, amount_cents, idempotency_key}` → validation (min $1.00, balance, destination format per method) → status `pending_review`, ledger hold (debit watcher, credit payout-clearing).
2. Admin approves → `processing` → **mock adapter** `execute()` → `completed` (+ `payout_attempts` log with fake txRef) or `failed` → auto-refund to watcher on final failure.

### 1.4 Environments & local dev (zero spend)

| Env | API | Web | D1 | R2 | Secrets |
|---|---|---|---|---|---|
| local | `wrangler dev` :8787 (miniflare, persistent `.wrangler/state/`) | `vite dev` :5173 → proxies `/v1` to :8787 | local D1 file | local R2 dir | `.dev.vars` (fake values only) |
| preview | `wrangler deploy` per-PR (or `wrangler versions upload`) | Pages preview | D1 preview DB | same R2 (prefix `preview/`) | preview secrets |
| prod | `wrangler deploy` | Pages prod | D1 prod | R2 prod | prod secrets |

- **No paid Cloudflare products at MVP:** no Stream (we serve MP4 progressively from R2), no Workers AI, no Rate Limiting rules (app-level velocity in D1), no Queues (cron + polling instead). Verify current D1 free-tier quotas before launch; design assumes "millions of rows/day reads" headroom and heartbeats purged at 90 days (§4, `heartbeats`).
- **Tests:** `vitest` in plain node for pure logic (ledger math, heartbeat continuity, pacing, token validation). Integration: `wrangler dev` + seed script + scripted adversarial client (see §16, step 10). Miniflare-only for anything touching R2/D1 bindings.
- **`.wrangler/`, `.dev.vars`, local D1/R2 state are gitignored.** No real credentials anywhere — `.dev.vars.example` ships with `MOCK_*` placeholders.

### 1.5 Repo layout (implementer scaffolds this in build step 0)

```
kudiwatch/
  apps/api/                  # Hono Worker
    src/index.ts             # router mount, middleware (auth, cors, request-id)
    src/routes/auth.ts       # otp request/verify, refresh, logout, me
    src/routes/watcher.ts    # feed, assignments, watch sessions, heartbeats, wallet, payouts
    src/routes/advertiser.ts # videos, campaigns, funding, reports
    src/routes/admin.ts      # review queues, flags, payout decisions, config, audit
    src/routes/stream.ts     # token-validated R2 streaming
    src/lib/tokens.ts        # JWT (access, refresh, watch) HS256
    src/lib/ledger.ts        # double-entry primitives
    src/lib/assign.ts        # assignment query + pacing
    src/lib/verify.ts        # heartbeat validation + completion check
    src/lib/fraud.ts         # fingerprinting, ASN, velocity
    src/lib/sms.ts           # SmsAdapter interface + MockSmsAdapter
    src/lib/payouts.ts       # PayoutAdapter interface + 4 mocks
    src/lib/funding.ts       # FundingAdapter interface + mock
    src/lib/r2sign.ts        # SigV4 presigned URLs for R2
    wrangler.toml
  apps/web/                  # Vite + single Pages project
    src/landing/ src/app/ (PWA: feed, player, wallet) src/advertise/ src/admin/
    src/components/player/   # WatchPlayer: 1x lock, visibility pause, seek clamp, checks
    public/manifest.webmanifest, sw.js
  packages/shared/           # zod schemas + TS types shared by api & web
  db/migrations/0001_init.sql ...   # §4, applied with wrangler d1 migrations
  db/seed.sql                # demo advertiser, campaign, config, ASN list
  docs/DEEPDIVE.md docs/DECISIONS.md
```

---

## 2. Identity, auth & sessions

- **Primary identity = verified phone number (E.164).** One account per verified number — enforced by `UNIQUE(phone_e164)` + OTP verification at signup. (Research: FreeCash bans multi-accounts; adBTC's #1 ban cause is VPN/proxy — we bind identity to phone, not IP.)
- **OTP flow (mocked SMS):** `POST /v1/auth/otp/request {phone_e164}` → server generates 6-digit code, stores **HMAC-SHA256(code, OTP_PEPPER)** in `phone_verifications` (never plaintext), expiry 10 min, attempts counter, resend cooldown 60 s. `MockSmsAdapter.sendOtp()` logs to console + writes to a dev-only table/endpoint (`GET /v1/_dev/last-otp?phone=`, **local/preview only, 404 in prod**). `POST /v1/auth/otp/verify {phone_e164, code, device:{fingerprint, ua, platform}}` → on success: upsert user, record device, issue tokens.
- **Sessions:** access JWT (15 min) in `httpOnly; Secure; SameSite=Lax` cookie `kw_at`; refresh token (opaque, 30 d, rotating, hashed in `auth_sessions`) in cookie `kw_rt`. `POST /v1/auth/refresh` rotates. `POST /v1/auth/logout` revokes. `GET /v1/me` returns profile + roles + wallet balance (cached from ledger).
- **Roles:** `watcher` (default), `advertiser` (granted on advertiser profile creation), `admin` (seeded; granted only by existing admin, every grant in `admin_audit_log`). One user can hold watcher+advertiser.
- **Admin auth:** same cookie session + `role=admin` required; admin console additionally requires re-auth (fresh OTP) if session older than 12 h for payout decisions. TOTP 2FA for admins is **post-MVP** (DECISIONS.md #18).

---

## 3. Data model — full D1 schema

Conventions: `id TEXT PRIMARY KEY` = `crypto.randomUUID()`; money = `INTEGER` cents USD; timestamps = `INTEGER` unix seconds (UTC); JSON columns = `TEXT` (validated by zod at write). Foreign keys declared; D1 does not enforce them by default — the API is the integrity boundary, and a nightly `PRAGMA foreign_key_check` cron logs violations.

```sql
-- 0001_init.sql
PRAGMA journal_mode=WAL;

CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  phone_e164       TEXT NOT NULL UNIQUE,
  phone_verified_at INTEGER NOT NULL,
  country_code     TEXT NOT NULL,              -- 'NG','KE','IN','PH','ID',...
  display_name     TEXT NOT NULL,
  roles            TEXT NOT NULL DEFAULT '["watcher"]',  -- JSON array
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','warned','suspended','banned')),
  default_device_fp TEXT,                     -- last seen device fingerprint hash
  created_at       INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL
);
CREATE INDEX idx_users_status ON users(status);

CREATE TABLE phone_verifications (
  id           TEXT PRIMARY KEY,
  phone_e164   TEXT NOT NULL,
  otp_hash     TEXT NOT NULL,                  -- HMAC-SHA256(code, OTP_PEPPER)
  attempts     INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  consumed_at  INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_pv_phone ON phone_verifications(phone_e164);

CREATE TABLE auth_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  refresh_hash TEXT NOT NULL UNIQUE,          -- SHA-256 of opaque token
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_as_user ON auth_sessions(user_id);

-- Stable client-generated device id + server hash of signals
CREATE TABLE devices (
  fingerprint_hash TEXT PRIMARY KEY,          -- SHA-256(canonical signals)
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
  r2_key         TEXT NOT NULL UNIQUE,        -- e.g. videos/<uuid>/source.mp4
  sha256         TEXT NOT NULL,
  duration_s     REAL NOT NULL,               -- from browser metadata at confirm
  width          INTEGER, height INTEGER,
  size_bytes     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'uploaded'
                 CHECK (status IN ('uploaded','in_review','approved','rejected','archived')),
  rejection_reason TEXT,
  quiz           TEXT,                        -- JSON: [{q, choices[4], answer_idx}] | null
  reviewed_by    TEXT REFERENCES users(id),
  reviewed_at    INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_videos_status ON videos(status);

CREATE TABLE campaigns (
  id                  TEXT PRIMARY KEY,
  advertiser_id       TEXT NOT NULL REFERENCES users(id),
  video_id            TEXT NOT NULL REFERENCES videos(id),
  title               TEXT NOT NULL,
  price_per_view_cents INTEGER NOT NULL,      -- what the WATCHER earns
  advertiser_cpc_cents INTEGER NOT NULL,      -- what the ADVERTISER pays (≥ watcher price)
  budget_cents        INTEGER NOT NULL,       -- total advertiser budget, escrowed
  spent_cents         INTEGER NOT NULL DEFAULT 0,
  reserved_cents      INTEGER NOT NULL DEFAULT 0,  -- held by active claims
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_review','live','paused','exhausted','ended')),
  targeting           TEXT NOT NULL DEFAULT '{}',  -- JSON {countries:[], device:'any'|'android'|'ios', languages:[]}
  daily_cap           INTEGER NOT NULL DEFAULT 1000,  -- views/day pacing
  per_user_cap        INTEGER NOT NULL DEFAULT 1,     -- views per watcher, lifetime of campaign
  starts_at           INTEGER, ends_at INTEGER,
  priority            INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_status ON campaigns(status);

CREATE TABLE campaign_daily_spend (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  day         TEXT NOT NULL,                  -- 'YYYY-MM-DD' UTC
  spent_cents INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, day)
);

-- One row per offer. claimed → exactly one watch_sessions row.
CREATE TABLE assignments (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'offered'
               CHECK (status IN ('offered','claimed','completed','expired','skipped')),
  offered_at   INTEGER NOT NULL,
  claim_deadline INTEGER NOT NULL,            -- offered_at + 120s
  claimed_at   INTEGER,
  UNIQUE(campaign_id, user_id, status) -- soft guard; real no-repeat rule enforced in assign.ts
);
CREATE INDEX idx_assign_user ON assignments(user_id, status);

CREATE TABLE watch_sessions (
  id              TEXT PRIMARY KEY,
  assignment_id   TEXT NOT NULL UNIQUE REFERENCES assignments(id),
  user_id         TEXT NOT NULL REFERENCES users(id),
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id),
  video_id        TEXT NOT NULL REFERENCES videos(id),
  token_jti       TEXT NOT NULL UNIQUE,       -- watch-token JWT id
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','completed','failed','expired','invalidated')),
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_s      REAL NOT NULL,              -- video duration at claim time
  watched_intervals TEXT NOT NULL DEFAULT '[]', -- JSON [[start_s,end_s],...] unioned server-side
  watched_pct     REAL NOT NULL DEFAULT 0,
  attention_score REAL,                       -- 0..1, computed at completion
  credit_group_id TEXT,                       -- ledger_entries.group_id, set on credit
  failure_reason  TEXT,
  ip              TEXT, asn INTEGER,
  device_fp       TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_ws_user ON watch_sessions(user_id, status);

-- Raw evidence. Purged after 90 days by cron (config.heartbeat_retention_days).
CREATE TABLE heartbeats (
  session_id  TEXT NOT NULL REFERENCES watch_sessions(id),
  seq         INTEGER NOT NULL,
  client_ts   INTEGER NOT NULL,
  server_ts   INTEGER NOT NULL,
  position_s  REAL NOT NULL,
  visible     INTEGER NOT NULL,               -- 0/1
  playback_rate REAL NOT NULL,
  accepted    INTEGER NOT NULL,               -- 0/1 (rejected still logged)
  reject_code TEXT,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE attention_checks (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES watch_sessions(id),
  check_type  TEXT NOT NULL CHECK (check_type IN ('tap','quiz')),
  scheduled_at_s REAL NOT NULL,               -- video-time the check fires
  presented_at INTEGER,
  due_at      INTEGER,                        -- presented_at + 15s
  responded_at INTEGER,
  passed      INTEGER,                        -- 0/1/NULL
  payload     TEXT NOT NULL DEFAULT '{}'      -- quiz: {q, choices}; tap: {}
);
CREATE INDEX idx_ac_session ON attention_checks(session_id);

-- Double-entry ledger. Invariant: per group_id, SUM(debit)=SUM(credit); no negative balances.
CREATE TABLE ledger_accounts (
  id         TEXT PRIMARY KEY,                -- 'user:<uuid>' | 'campaign:<uuid>' | 'platform:fees' | 'payout:clearing'
  owner_type TEXT NOT NULL CHECK (owner_type IN ('user','campaign','platform','clearing')),
  owner_id   TEXT,
  currency   TEXT NOT NULL DEFAULT 'USD',
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  version    INTEGER NOT NULL DEFAULT 0,      -- optimistic locking
  created_at INTEGER NOT NULL
);

CREATE TABLE ledger_entries (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,                  -- one UUID per economic event
  account_id  TEXT NOT NULL REFERENCES ledger_accounts(id),
  side        TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  entry_type  TEXT NOT NULL CHECK (entry_type IN (
    'EARN_CREDIT','EARN_REVERSAL','PAYOUT_HOLD','PAYOUT_RELEASE','PAYOUT_REFUND',
    'ADJUSTMENT','FUND_TOPUP','CAMPAIGN_ESCROW','CAMPAIGN_SPEND','PLATFORM_FEE')),
  ref_type    TEXT, ref_id TEXT,               -- e.g. ('watch_session', '<id>')
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
  amount_cents    INTEGER NOT NULL CHECK (amount_cents >= 100),  -- ≥ $1.00
  currency        TEXT NOT NULL DEFAULT 'USD',
  method          TEXT NOT NULL CHECK (method IN ('mpesa','bank','airtime','usdt')),
  destination     TEXT NOT NULL,              -- JSON {label, ...}; secrets redacted in logs
  destination_hash TEXT NOT NULL,            -- SHA-256(canonical) for dup detection
  idempotency_key TEXT NOT NULL UNIQUE,       -- client-generated UUID
  fee_cents       INTEGER NOT NULL DEFAULT 0,
  fx_rate         REAL,                       -- mock FX at approval time
  status          TEXT NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review','approved','processing','completed','failed','rejected','refunded')),
  hold_group_id   TEXT,                       -- ledger group of the PAYOUT_HOLD
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
  adapter    TEXT NOT NULL,                   -- 'mock-mpesa' | ...
  request    TEXT NOT NULL,                   -- JSON, destination redacted
  response   TEXT,                            -- JSON {ok, txRef?, error?}
  ok         INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE fraud_signals (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  session_id  TEXT REFERENCES watch_sessions(id),
  signal_type TEXT NOT NULL,  -- 'seq_gap','position_jump','hidden_playback','rate_change',
                              -- 'multi_account_device','datacenter_asn','vpn_asn','velocity_exceeded',
                              -- 'check_failed','uniform_heartbeats','otp_bruteforce','impossible_travel'
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
  created_by TEXT REFERENCES users(id),       -- NULL for automatic
  created_at INTEGER NOT NULL,
  resolved_at INTEGER, resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_af_user ON account_flags(user_id);

-- Seeded manually; Worker reads into memory per request via request.cf.asn
CREATE TABLE asn_reputation (
  asn   INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  risk  TEXT NOT NULL CHECK (risk IN ('allow','review','block')),
  notes TEXT
);

CREATE TABLE admin_audit_log (
  id         TEXT PRIMARY KEY,
  admin_id   TEXT NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,                   -- 'video.review','payout.decide','account.flag','config.set',...
  target_type TEXT, target_id TEXT,
  diff       TEXT NOT NULL DEFAULT '{}',      -- JSON {before, after}
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_admin ON admin_audit_log(admin_id, created_at);

CREATE TABLE config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,                   -- JSON
  updated_by TEXT REFERENCES users(id),
  updated_at INTEGER NOT NULL
);
-- seed: heartbeat_interval_s=10, completion_pct=90, min_payout_cents=100,
-- max_views_per_hour=10, max_views_per_day=50, otp_* , payout_mock_failure_rate=0, ...

CREATE TABLE velocity_windows (
  scope      TEXT NOT NULL,                   -- 'user:<id>:completions' | 'ip:<ip>:claims' | ...
  window_start INTEGER NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, window_start)
);
```

**Ledger flows (canonical groups):**
- Watch credit: debit `campaign:<cid>` / credit `user:<uid>`, amount = `price_per_view_cents`, type `EARN_CREDIT`, ref watch_session. Platform margin is the spread: advertiser was already charged `advertiser_cpc_cents` into campaign escrow at campaign creation (`CAMPAIGN_ESCROW`: debit `user:<advertiser>`, credit `campaign:<cid>`); the fee remainder stays in the campaign account and sweeps to `platform:fees` on campaign end (`PLATFORM_FEE`).
- Payout hold: debit `user:<uid>` / credit `clearing:payouts` (`PAYOUT_HOLD`). On `completed`: debit `clearing:payouts`, memo only (money left the system; the mock adapter "sent" it). On `failed`/`rejected`: `PAYOUT_REFUND` reverses the hold.
- All writes go through `lib/ledger.ts#postEntries(group)` which runs in a **single D1 batch transaction**, asserts Σdebits = Σcredits per group, asserts no account goes negative (re-read balance with `version` optimistic lock), and is idempotent on `group_id` (insert-or-ignore + verify).

---

## 4. API surface

Base `https://api.kudiwatch.com/v1` (local: `http://127.0.0.1:8787/v1`). Auth: cookies `kw_at`/`kw_rt` (all `/v1/*` except OTP request/verify and landing). Every response: `{data|error:{code,message,request_id}}`. Pagination: `?cursor=&limit=` (cursor = opaque base64 of `(created_at,id)`).

### Auth (`routes/auth.ts`)
| Method & path | Auth | Request | Response |
|---|---|---|---|
| `POST /auth/otp/request` | none | `{phone_e164}` | `{sent:true, resend_after_s:60}` (always 200, even for unknown numbers) |
| `POST /auth/otp/verify` | none | `{phone_e164, code, device:{fingerprint, user_agent, platform}}` | sets cookies; `{user:{id,display_name,roles,country_code}}` |
| `POST /auth/refresh` | `kw_rt` | `{}` | rotates cookies; `{ok:true}` |
| `POST /auth/logout` | `kw_at` | `{}` | clears cookies |
| `GET /me` | `kw_at` | — | `{user, wallet:{balance_cents, pending_payout_cents}}` |

### Watcher (`routes/watcher.ts`)
| Method & path | Request | Response / notes |
|---|---|---|
| `GET /feed/next` | — | `{assignment:{id, claim_deadline}, video:{id,duration_s}, campaign:{id,title,price_per_view_cents}}` or `{assignment:null, reason:'empty'|'capped'}`. §5 |
| `POST /assignments/:id/claim` | `{}` | `{watch_token, expires_at, session_id, checks:[{id,type,scheduled_at_s}]}`. One active session/user; 409 if another active. Reserves budget. |
| `POST /assignments/:id/skip` | `{reason?}` | 200; assignment `skipped`, 24 h cooldown before re-offer |
| `POST /watch/:sid/heartbeat` | `{seq, position_s, visible, playback_rate, client_ts}` | `{ok:true, server_ts}` or `{ok:false, reject_code}` — rejected beats still logged |
| `POST /watch/:sid/attention` | `{check_id, response:{choice_idx?}}` | `{passed:true|false}`; fail → session `invalidated`, fraud signal |
| `POST /watch/:sid/complete` | `{}` | `{status:'completed', credited_cents}` or `{status:'failed', reason}` — idempotent on session |
| `GET /watch/:sid/receipt` | — | per-view receipt (also used by advertisers aggregated) |
| `GET /wallet` | — | `{balance_cents, pending_payout_cents, lifetime_earned_cents}` |
| `GET /wallet/ledger?cursor=&limit=` | — | entries for caller's account |
| `POST /payouts` | `{method, destination:{...}, amount_cents, idempotency_key}` | `{payout:{id,status}}` → `pending_review`, hold posted |
| `GET /payouts` / `GET /payouts/:id` | — | list / detail (destination partially masked) |

### Advertiser (`routes/advertiser.ts`, requires `advertiser` role)
| Method & path | Request | Response / notes |
|---|---|---|
| `POST /advertiser/profile` | `{company_name, contact_email}` | grants role; creates `advertiser_profiles` |
| `POST /advertiser/videos/upload-url` | `{filename, size_bytes, sha256}` | `{upload_url (presigned PUT, 15 min), r2_key, video_id}` — validates size ≤ 200 MB, ext mp4/webm |
| `POST /advertiser/videos/:id/confirm` | `{duration_s, width, height}` | `uploaded`→`in_review`; validates 15 s ≤ duration ≤ 180 s |
| `GET /advertiser/videos` | — | list with statuses |
| `POST /advertiser/wallet/topup` | `{amount_cents, method:'mock_card'}` | mock funding → `FUND_TOPUP` ledger credit; `{balance_cents}` |
| `POST /advertiser/campaigns` | `{video_id, title, price_per_view_cents, advertiser_cpc_cents, budget_cents, targeting:{countries[],device,languages[]}, daily_cap, per_user_cap, starts_at?, ends_at?}` | validates video `approved`, `advertiser_cpc_cents ≥ price_per_view_cents`, balance ≥ budget → escrow → status `live` |
| `PATCH /advertiser/campaigns/:id` | `{status:'paused'|'live'}` | pause/resume; `ended` releases unspent escrow |
| `GET /advertiser/campaigns/:id/report` | — | `{views, completions, completion_rate, avg_attention_score, spent_cents, remaining_cents, by_country:{}, by_device:{}}` |
| `GET /advertiser/campaigns/:id/receipts?cursor=` | — | per-view receipts: `{session_id, watched_pct, attention_score, checks_passed, country, device, completed_at}` |

### Admin (`routes/admin.ts`, requires `admin` role; every mutation → `admin_audit_log`)
| Method & path | Notes |
|---|---|
| `GET /admin/videos/review-queue` | `in_review` videos, oldest first |
| `POST /admin/videos/:id/review` `{approve:boolean, reason?}` | approve → `approved`; reject → `rejected` + reason |
| `GET /admin/accounts/flagged` | users with open flags or high-severity signals |
| `POST /admin/accounts/:id/flag` `{action:'warn'|'suspend'|'ban', reason}` | suspend/ban blocks claims + payouts immediately |
| `GET /admin/payouts/queue` | `pending_review` payouts with velocity/fraud context |
| `POST /admin/payouts/:id/decision` `{approve:boolean, note?}` | approve → `approved` (then cron `processing`→adapter→`completed`/`failed`); reject → `rejected` + refund |
| `GET /admin/campaigns` | all campaigns w/ spend (fraud watch: abnormal completion rates) |
| `GET/PUT /admin/config` | rate/cap/threshold tuning (§3 `config`) |
| `GET /admin/audit-log?cursor=` | immutable log |

### Streaming (`routes/stream.ts`)
- `GET /stream/:videoId?wt=<watch-token>` — validates JWT (sig, exp, `vid` match, session `active`), then R2 `get(key, {range})` → 206/200. Headers: `Accept-Ranges: bytes`, `Cache-Control: private, no-store`, `Content-Type: video/mp4`. Logs bytes served per session (abuse signal: 3x duration bytes = ripper).

### Dev-only (`routes/dev.ts`, **not mounted in prod**)
- `GET /_dev/last-otp?phone=` — returns last mock OTP. `POST /_dev/seed` — reseeds demo data. `GET /_dev/fraud` — recent signals.

---

## 5. Watch-verification design (the core — §7 in task)

### 5.1 Player (PWA, `apps/web/src/components/player/WatchPlayer.tsx`)
Our own HTML5 `<video>` element. **Never a YouTube embed.** Hardening:
- `playbackRate` forced to `1` (re-set on `ratechange` event; any deviation pauses + sends heartbeat with `playback_rate≠1` → server rejects).
- `controlsList="nodownload"`, `disablePictureInPicture`, context menu suppressed. (Determined rippers can still capture — we don't pretend otherwise; the token-bound stream + attention checks are the real defense.)
- **Seek clamp:** `seeking` event → if `newTime > maxWatchedPosition` → `video.currentTime = maxWatchedPosition`. Backward seek allowed (re-watch doesn't double-credit; intervals are unioned).
- **Page Visibility API:** `visibilitychange` → `hidden` → `video.pause()` + immediate heartbeat `{visible:false}`; server grants **zero credit** for hidden intervals and rejects position advances while hidden.
- **Heartbeat loop:** `setInterval(10_000)` + `sendBeacon` on `pagehide` for the final beat.
- **Attention overlay:** absolutely-positioned modal over the player (pauses video until resolved, 15 s timeout; timeout = fail).

### 5.2 Watch session token (JWT, HS256, secret `WATCH_TOKEN_SECRET`)
Claims: `{jti, sub:user_id, sid:watch_session_id, vid, cid, iat, exp, fp:device_fp_hash}`. `exp = now + duration_s + 900` (15-min grace). `jti` stored in `watch_sessions.token_jti` — single active session per user enforced by unique partial state (app-level check: no other `active` session for user).

### 5.3 Heartbeat protocol
Request: `{seq (strictly increasing from 1), position_s, visible:bool, playback_rate, client_ts}`.
Server validation (`lib/verify.ts#validateHeartbeat`), in order:
1. Session exists, `active`, token signature + expiry + `fp` matches request device (allow fp rotation → fraud signal `device_change`, not instant fail — cheap Androids reinstall).
2. `seq == last_seq + 1`. Duplicate → `reject_code='dup_seq'` (signal `seq_gap`, low). Jump → reject + medium signal.
3. `visible == true`, else reject `hidden` (no credit; signal if position advanced).
4. `playback_rate == 1.0` exactly, else reject `bad_rate` + medium signal.
5. Position continuity: `position_s ∈ [last_pos − 1.0, last_pos + elapsed_wall*1.25 + 2.0]` where `elapsed_wall = server_ts − last_server_ts`. Outside → reject `jump` + high signal. (Tolerates 3G buffering stalls; `waiting`/`stalled` events reported by client extend the window — client includes `buffering_s` in heartbeat; server adds it to the allowance.)
6. On accept: merge `[min(last_pos,position_s), max(...)]` into `watched_intervals` (union), `last_seq=seq`, `watched_pct = union_length / duration_s`.
7. Rate-limit: >1 heartbeat/5 s per session → reject `too_fast` + signal (scripted clients often over-beat).

### 5.4 Attention checks
Scheduled at claim time, server-side random: for videos ≥ 60 s, 1–2 checks at random `scheduled_at_s` (never in first/last 5 s); < 60 s: 0–1 tap check. Types:
- **tap-to-confirm:** overlay "Tap to continue watching" — 15 s to respond; response = `{check_id}`.
- **content quiz (optional per campaign):** advertiser supplies 1 MCQ (`videos.quiz`); asked after ≥70% watched; wrong answer = fail.
Fail/timeout → session `invalidated`, `failure_reason='attention_failed'`, fraud signal `check_failed` (medium), **no credit**, budget reservation released. Pass → `attention_score` accumulates (tap=0.5 weight, quiz=1.0; normalized 0..1 at completion).

### 5.5 Completion
`POST /watch/:sid/complete` (also auto-called by client on `ended`):
- Recompute `watched_pct` from intervals; require **`watched_pct ≥ 0.90`** (config `completion_pct`).
- Require all due attention checks `passed=1`.
- Require no open high-severity fraud signals on the session.
- Session wall-clock ≤ `duration_s + 900 + total_buffering_s` (catches slowed-clock tampering).
- Then **atomically**: status → `completed`, ledger credit group posted (idempotent on `credit_group_id` — re-POST returns the same receipt), assignment → `completed`, campaign `spent_cents += price`, `reserved_cents -= price`, `campaign_daily_spend` updated.
- Failure → status `failed` + `failure_reason`, reservation released, fraud signal if warranted. **No partial credit at MVP** (DECISIONS.md #5).

---

## 6. Assignment engine (`lib/assign.ts`)

`GET /feed/next` runs (single D1 query + app filters):
```sql
SELECT c.*, v.duration_s FROM campaigns c JOIN videos v ON v.id=c.video_id
WHERE c.status='live'
  AND (c.starts_at IS NULL OR c.starts_at <= :now) AND (c.ends_at IS NULL OR c.ends_at > :now)
  AND c.spent_cents + c.reserved_cents < c.budget_cents
  AND (SELECT COALESCE(SUM(views),0) FROM campaign_daily_spend
        WHERE campaign_id=c.id AND day=:today) < c.daily_cap
  AND NOT EXISTS (SELECT 1 FROM assignments a
                   WHERE a.campaign_id=c.id AND a.user_id=:uid
                     AND a.status IN ('claimed','completed'))
ORDER BY c.priority DESC, RANDOM() LIMIT 8;
```
App-side: filter by targeting (country ∈ `targeting.countries` — from user profile + `request.cf.country`; device class from UA; language), drop campaigns where user hit `per_user_cap`, drop if user's velocity caps hit (`velocity_windows`), drop if `price_per_view_cents` below user's... (no — keep simple). Pick winner: **largest pacing deficit** = `daily_cap − views_today` weighted by `priority`, random tiebreak. Create `assignments` row (`offered`, `claim_deadline = now+120`), return it. If none: `{assignment:null, reason}`.

**Claim** (`POST /assignments/:id/claim`): checks assignment `offered` + not expired + user has no other `active` session + campaign still has budget → creates `watch_sessions`, posts **budget reservation** (memo-only increment of `reserved_cents` — not a ledger movement; real money moves only on completion), mints watch token, schedules attention checks. Expiry cron flips stale `offered` → `expired` and stale `active` (no heartbeat 60 s) → `expired`, releasing reservations.

**Pacing:** `daily_cap` spreads spend; `priority` lets advertisers bid for precedence (no auction at MVP — priority is admin/plan-set, DECISIONS.md).

---

## 7. Fraud layer (`lib/fraud.ts`)

Defense in depth; every signal lands in `fraud_signals` with severity. MVP posture: **detect + queue for human review; auto-block only the unambiguous** (datacenter ASN, emulator UA, OTP brute force). Manual review queue is the backstop because payouts are manual anyway.

| Signal | Detection | Action |
|---|---|---|
| Multi-account device | `devices.account_count > 2` (fingerprint = SHA-256 of UA+screen+tz+canvas+stored id) | auto-flag `review`; blocks 3rd claim until admin clears |
| Emulator | UA regex (generic, `sdk_`, `Emulator`, webdriver flag via client hint) | auto `review`; completion requires attention pass |
| Datacenter/VPN ASN | `request.cf.asn` ∈ `asn_reputation` risk `block`/`review` (seeded list: common VPN/hosting ASNs) | `block` → 403 on claim; `review` → flag |
| OTP brute force | `phone_verifications.attempts ≥ 5` | lock number 1 h, signal high |
| Velocity | `velocity_windows`: >10 completions/h or >50/day per user; >5 accounts/IP/day; >3 claims/min/user | soft-block with `retry_after`, signal medium |
| Heartbeat anomalies | seq gaps, position jumps, hidden playback, bad rate, over-frequent beats (§5.3) | per-event signals; 3 mediums in a session → invalidate |
| Uniform beats | stddev of inter-heartbeat intervals < 300 ms over ≥10 beats (bots are metronomic) | signal medium `uniform_heartbeats` |
| Attention fail rate | >40% checks failed across last 20 sessions | auto `warn` → `suspend` on repeat |
| Impossible travel | country change > 2000 km within 1 h between sessions | signal medium |
| Ripper | bytes served > 3× duration×bitrate for a session | signal high, invalidate future claims 24 h |
| Payout dup | same `destination_hash` on ≥2 users | hold both payouts, admin review |

**Device fingerprint (PWA):** `fp = SHA-256(stable_id || UA || screen || tz || canvas_hash)`; `stable_id` persisted in localStorage/IndexedDB (survives cookie clear; not reinstall). Server keeps `devices` table; **never collect IMEI/serial** — not available on web anyway.

**What we deliberately don't do at MVP:** behavioral biometrics, liveness/KYC (phone OTP only — DECISIONS.md #10), IP geolocation beyond `request.cf` (no MaxMind spend), SMS pumping defense beyond rate limits (mock SMS anyway).

---

## 8. Wallet & ledger (`lib/ledger.ts`)

- Double-entry, USD cents, `ledger_accounts` + `ledger_entries` (§3). `postEntries(group_id, entries[])`: single `D1.batch`, asserts balanced + non-negative + idempotent (`INSERT OR IGNORE` on the `UNIQUE(group_id,account_id,side)` key, then verify row count).
- Balances are cached on the account row; `version` optimistic-lock prevents lost updates under concurrency (two completions racing).
- **No negative balances:** `CHECK (balance_cents >= 0)` + app assertion; payout hold fails closed if insufficient.
- **Idempotent crediting:** watch credit keyed by `credit_group_id = 'earn:'+session_id`; payout keyed by client `idempotency_key`. Retries and double-POSTs are safe.
- Watcher wallet shows `balance_cents` (spendable) and `pending_payout_cents` (in `pending_review`/`approved`/`processing`).
- Advertiser wallet is the same ledger (`user:<advertiser_id>`); campaign escrow is `campaign:<cid>`.

---

## 9. Payout queue & mocked adapters

**State machine:** `pending_review` → (`approved`|`rejected`) → `processing` → (`completed`|`failed`) → `failed` may → `refunded` (auto-refund ledger) or manual retry → `processing`. Terminal: `completed`, `rejected`, `refunded`. Every transition writes `payout_attempts` (for adapter runs) and is admin-audited.

**Adapter interface** (`lib/payouts.ts`) — identical for mocks and future real adapters:
```ts
interface PayoutDestination { label: string; [k: string]: unknown } // e.g. {msisdn} | {iban, bank} | {msisdn} | {address, network}
interface PayoutAdapter {
  readonly method: 'mpesa' | 'bank' | 'airtime' | 'usdt';
  validateDestination(d: unknown): { ok: boolean; error?: string };
  quote(amountCents: number): { feeCents: number; etaMinutes: number; fxRate: number };
  execute(job: { payoutId: string; amountCents: number; destination: PayoutDestination }): 
    Promise<{ ok: boolean; txRef?: string; error?: string; retryable?: boolean }>;
}
```
**Mocks** (`MockMpesaAdapter`, `MockBankAdapter`, `MockAirtimeAdapter`, `MockUsdtAdapter`): validate formats (E.164 MSISDN for mpesa/airtime; IBAN-ish/account for bank; `0x`/TRC20/ERC20 for usdt), quote from `config` (mock fees: mpesa 1.5%, bank $0.30 flat, airtime 0%, usdt $1.00 network), `execute()` sleeps 500–2000 ms, returns `txRef: 'MOCK-'+ulid`, honors `config.payout_mock_failure_rate` (default 0; QA sets 0.3 to exercise retries). All requests/responses → `payout_attempts` with destination secrets redacted.

**Cron** (`scheduled` handler, every 5 min): picks `approved` payouts (oldest first, limit 20) → `processing` → adapter → terminal. **Payouts are NEVER auto-approved at MVP** — admin clicks approve.

---

## 10. Advertiser dashboard (`apps/web/src/advertise/`)

- **Onboarding:** company profile → role granted → mock top-up (`FundingAdapter`: `MockCardAdapter` — fake PAN `4242…`, instant settle, logged; interface identical to a future PSP).
- **Submit video:** drag-drop → client validates (mp4/webm magic bytes, ≤200 MB) → presigned PUT → `confirm` with duration/dimensions (from `<video>` metadata) → status `in_review`. **Constraints enforced:** 15–180 s, ≤200 MB, H.264/AAC preferred (we sniff `video.canPlayType`; non-conforming → warning, admin decides). No server transcoding at MVP (DECISIONS.md #9).
- **Campaign builder:** title, video select (approved only), watcher price/view ($0.01–$0.03 default slider), advertiser CPC (≥ watcher price; the spread is our margin), budget, targeting (countries multi-select incl. NG/KE/IN/PH/ID; device any/android/ios; languages), `daily_cap`, `per_user_cap` (default 1), schedule. Live → budget escrowed from advertiser wallet.
- **Reports:** views, completions, completion rate, avg attention score, spend vs budget, pacing bar, breakdowns by country/device; **per-view receipts** table (session id, watched %, attention score, checks passed/failed, country, device class, completed_at) — this receipt is the product: *proof of human attention*, exportable CSV.
- **Quiz builder (optional):** 1 MCQ per video; shown to watchers post-70%.

---

## 11. Admin & moderation (`apps/web/src/admin/`)

- **Video review queue:** thumbnail (first-frame extracted client-side at upload, stored `videos/<id>/thumb.jpg`), metadata, advertiser history → approve/reject + reason. Policy at MVP: no adult, no hate, no scams/crypto-doubling, no copyrighted re-uploads (best-effort human review).
- **Flagged accounts:** fraud signals aggregated per user with severity timeline → warn/suspend/ban (ban blocks claims, freezes payouts pending review).
- **Payout approval queue:** amount, method, destination (masked), account age, completions/day, signal count → approve/reject + note. Re-auth required if admin session > 12 h.
- **Config:** heartbeat interval, completion %, caps, prices, mock failure rates — all `config` table, no redeploy.
- **Audit log:** every admin mutation, immutable, filterable.

---

## 12. Ruthless MVP scope & launch gates

### Gate 0 — internal alpha (team + friends, mock money everywhere)
- [x] Auth: phone OTP (mock SMS), sessions, roles
- [x] Advertiser: upload (presigned R2), confirm, mock top-up, campaign CRUD, pause/resume
- [x] Watcher PWA: feed, claim, player (1x lock, seek clamp, visibility pause), heartbeats, tap attention checks, completion + credit
- [x] Ledger double-entry + wallet views
- [x] Payout request + mock adapter execution (admin auto-approves own test payouts)
- [x] Admin: video review, config
- Exit: 20 test sessions complete end-to-end, ledger balances, no negative balances, receipts render.

### Gate 1 — closed beta (≤500 watchers, NG+KE first; still mock payouts, real attention)
- [x] Fraud v1: fingerprint, ASN lists, velocity caps, review queue, warn/suspend
- [x] Quiz attention checks (advertiser-supplied)
- [x] Payout manual-approval queue + re-auth
- [x] Assignment pacing + per-user caps + skip/cooldown
- [x] Heartbeat retention cron, expiry cron, payout cron
- Exit: fraud review SLA < 24 h, completion rate 60–85% (too high = bots; too low = UX), payout queue drains.

### Gate 2 — public (real money decisions made here, not before)
- Real SMS provider behind `SmsAdapter`; real PSP behind `FundingAdapter`; real payout rails behind `PayoutAdapter` (start: M-Pesa + airtime, the Africa unlock); ID verification before first withdrawal (FreeCash precedent); admin TOTP; per-viewer watermarking; abuse dashboards + alerts.
- Exit criteria defined by founder (unit economics review: CAC vs margin per view).

### Explicitly OUT of MVP (do not build; do not sneak in)
1. **Anything paying for YouTube views/embeds** — the hard constraint.
2. Referral program (fraud magnet; Roz Dhan/Zynn lesson).
3. Native iOS/Android apps — PWA only.
4. Server-side transcoding / adaptive bitrate — single MP4 rendition.
5. Real money movement, real SMS, real KYC — all mocked behind swappable interfaces.
6. Advertiser auction/bidding, priority marketplace — priority is plan-set.
7. Multi-language UI — English only (add Hausa/Swahili/Hindi post-gate-1 if data supports).
8. Push notifications, in-app support chat — email link only.
9. Crypto wallet connect / token rewards — USDT is a payout *rail* (mock), not a token.
10. Offerwall network integrations (AdscendMedia/Tapjoy) — we are advertiser-direct; integrations are a scale play.
11. Partial credit for incomplete watches; watch streaks/gamification beyond attention score.
12. Public API for third parties.

---

## 13. Threat model summary (adversarial QA target list)

| # | Attacker | Goal | Attack | Mitigation in design | QA probe |
|---|---|---|---|---|---|
| 1 | Watch farmer | multiply payouts | multi-account via number farms, emulator farm | 1 phone = 1 account; device fingerprint `account_count>2` blocks; emulator UA detect; velocity caps; manual payout approval | script 5 signups from 1 fingerprint; emulator UA |
| 2 | Scripter | fake watches at scale | headless browser driving player, forged heartbeats | signed seq chain; position continuity; uniform-beat detection; random attention checks; quiz | puppeteer client with perfect 10 s beats; replayed seq |
| 3 | Token thief | steal/extend sessions | intercept watch JWT, replay on another device | short TTL; `fp` claim binding; single active session; stream bound to session | replay token from different fp; use after expiry |
| 4 | Ripper | steal advertiser video | download via stream URL | token-bound URLs, no public R2, ripper byte-count signal | `curl` stream URL without token; with expired token |
| 5 | Budget drainer | burn competitor budget | complete own views via colluding accounts | per-user cap=1, no-repeat, velocity caps, attention quiz, abnormal completion-rate alerts | 50 completions from 1 IP across accounts |
| 6 | OTP attacker | account takeover | brute-force 6-digit code | HMAC-stored codes, 5 attempts → 1 h lock, 60 s resend cooldown | 6 rapid wrong codes |
| 7 | Payout fraudster | redirect funds | tamper destination post-approval | destination hash locked at request; re-confirm shown at approval; audit log | change destination between request and approval |
| 8 | Clock tamperer | inflate watched % | slow device clock to stretch intervals | server timestamps authoritative; wall-clock bound on session | heartbeat with skewed client_ts |
| 9 | Admin attacker | escalate | hijack admin cookie | short access TTL, re-auth for payouts, audit log, (TOTP at gate 2) | replay admin cookie after logout |
| 10 | Advertiser fraud | fake engagement for stats | upload 1-frame video, quiz with trivial answer | 15 s min duration, human video review, advertiser history | 15 s black video + trivial quiz |
| 11 | Idempotency breaker | double credit | double-POST complete, replay payout | `credit_group_id` unique; `idempotency_key` unique; batch transactions | fire complete ×20 concurrently |
| 12 | Refund gamer | free money loop | payout fail → refund → re-request cycling | refund only on terminal adapter failure; destination velocity | force mock failure rate 1.0, loop requests |

**Assumptions:** TLS everywhere (Cloudflare); D1 is trusted storage; `request.cf` (country/ASN) is trustworthy; client is **never** trusted for position/visibility/rate — server re-derives credit from heartbeat evidence.

---

## 14. Build plan (ordered — implementer follows this sequence)

Each step ends with acceptance criteria; do not start step N+1 until N passes.

0. **Scaffold & schema.** Repo layout (§1.5); `wrangler.toml` (api) + Pages config; `db/migrations/0001_init.sql` (§3) + `db/seed.sql` (admin user, demo advertiser, 1 campaign, ASN seed, config seed); `.dev.vars.example`; CI-less `pnpm -r typecheck`. *Accept:* `wrangler d1 migrations apply --local` clean; seed loads.
1. **Auth.** OTP request/verify, mock SMS, sessions, `/me`, roles. *Accept:* full signup→verify→refresh→logout cycle via curl; OTP brute-force locks.
2. **Ledger.** `lib/ledger.ts`, accounts, `postEntries` with balance/idempotency tests (vitest). *Accept:* property tests — random entry batches always balance; negative-balance attempt fails; double-post idempotent.
3. **Advertiser ingest.** Presigned upload URL (SigV4), confirm, video review queue (admin), mock top-up, campaign CRUD + escrow. *Accept:* 50 MB MP4 upload → review → approve → campaign live with escrowed budget.
4. **Assignment + claim.** `lib/assign.ts`, `/feed/next`, claim with reservation, expiry cron. *Accept:* scripted 100 offers respect caps, no-repeat, budget; pacing deficit ordering sane.
5. **Player + watch session.** PWA player (§5.1), watch token, heartbeat validation (§5.3), tap attention checks, completion + credit (§5.5). *Accept:* real browser session completes → credited; hidden-tab session earns nothing; seek-forward clamped.
6. **Payouts.** Request validation, hold, admin queue, mock adapters ×4, payout cron, refunds. *Accept:* request→approve→completed with fake txRef; failure injection → refund; double-POST same idempotency key → one payout.
7. **Quiz checks + receipts.** Advertiser quiz builder, quiz attention flow, per-view receipts, campaign report. *Accept:* quiz fail → no credit; report numbers reconcile with ledger.
8. **Fraud v1.** Fingerprint, ASN lists, velocity windows, signals, review queue, warn/suspend/ban enforcement. *Accept:* each row of §7's table has a passing negative test.
9. **Admin console + audit.** All queues, config editor, audit log viewer. *Accept:* every admin mutation appears in audit log with before/after.
10. **Adversarial QA harness.** Scripted attacker clients for §13 probes 1–12; run against local + preview. *Accept:* all probes either blocked or produce review-queue flags; write results to `docs/QA-REPORT.md` (implementer/QA stage owns this file).
11. **Gate-0 dry run.** 20 humans (or realistic scripts) end-to-end; fix UX; freeze scope. Then hand to coordinator for gate review.

**Cross-cutting:** zod schemas in `packages/shared` from step 1; every endpoint logs `request_id`; errors never leak stack traces; PWA Lighthouse mobile ≥ 85 before gate 1.

---

*Companion: `docs/DECISIONS.md` — every product/technical call the founder should review on return.*
