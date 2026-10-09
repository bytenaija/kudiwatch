# KudiWatch

**Pay for verified human attention.** Advertisers/brands upload short videos; the platform assigns them to registered watchers in Africa and Asia; watchers who verifiably watch in full get paid.

> **Hard constraint (founder-locked):** sponsored-attention / offerwall model ONLY. Advertisers pay for verified human attention on **our own video inventory**. We NEVER pay for YouTube views, embeds, or API calls — that is incentivized traffic under YouTube's Fake Engagement policy (warning → 3 strikes → termination). There is nothing YouTube anywhere in this product.

> **Demo build — mock mode.** No real money moves. Payouts are simulated end-to-end behind interfaces identical to the future real adapters. The UI says so loudly on every money screen.

---

## Architecture

```
apps/api/src/
  index.ts            Hono app factory (Workers-portable: no Node APIs)
  workers.ts          Cloudflare Workers entrypoint (real deploys)
  routes/             auth · watcher · advertiser · admin · stream · dev
  lib/
    ledger.ts         double-entry ledger (balanced groups, no negatives, idempotent)
    verify.ts         heartbeat continuity validation + completion/crediting
    assign.ts         assignment engine (pacing deficit, caps, targeting)
    fraud.ts          signals, velocity windows, ASN reputation, device tracking
    tokens.ts         JWT (access/watch) + opaque refresh rotation
    sms.ts            SmsAdapter + MockSmsAdapter (mock OTP, logged in dev)
    payouts.ts        PayoutAdapter ×4 mocks (mpesa/bank/airtime/usdt) + MockCardAdapter funding
    cron.ts           expiry, payout processing, heartbeat retention
    r2sign.ts         SigV4 presigned PUT (prod) / HMAC local-shim grant (dev)
    config.ts         tunable config table (no redeploy)
  local/
    server.ts         local dev server: @hono/node-server + node:sqlite + fs R2 shim
    sqlite.ts         DbAdapter over node:sqlite (D1-compatible surface)
    r2fs.ts           R2Adapter over ./data/r2
    prod-bindings.ts  D1/R2 thin adapters for real Workers deploys

apps/web/              TanStack Start + React + Tailwind CSS v4 (TypeScript) SPA.
                      `npm run build:web` → apps/web/dist/client (served as the
                      worker's [assets]; index.html is the SPA shell, deep links
                      resolve via not_found_handling = "single-page-application")
  src/routes/         / (landing) · /app (queue) · /app/signup · /app/watch (player)
                      /app/earnings · /app/payout · /advertise · /admin
  src/components/
    WatchPlayer.tsx   faithful port of the hardened player: 1x lock, seek clamp,
                      visibility pause, heartbeat seq chain, attention overlays,
                      verified-segments bar
    ui.tsx            Toast, TopBar, TabBar, sheets, OfflineBar, BusyButton
  src/lib/api.ts      API client (X-Device-Fp, cookies kw_at/kw_rt), money fmt,
                      IndexedDB offline queue — same /v1/* contract as the API
  public/             manifest.webmanifest · icons/ · sw.js (shell cached; video NEVER cached)

db/migrations/        0001 schema (21 tables) · 0002 ledger normal_side · 0003 payout CHECK
db/seed.sql           config defaults + ASN reputation
scripts/              seed.ts · e2e.ts · adversarial.ts · cron-once.ts · gen-videos.sh
```

**Money:** USD cents, double-entry (`ledger_accounts` + `ledger_entries`), per-group balance + non-negativity + idempotency on `group_id`. Watch credit `earn:<session>`; payout hold `payout-hold:<id>`; escrow `escrow:<campaign>`.

**Watch verification:** signed watch JWT per session → 10 s heartbeats (sequence chain, position window, 1x rate lock, visibility) → server-scheduled attention checks (tap + quiz) → ≥90% unioned intervals + all checks passed → idempotent credit. Failed/abandoned watches free the assignment (no per-user-cap burn).

---

## Run locally (zero spend, no Cloudflare account)

```bash
cd ~/workspace/kudiwatch
npm install          # once
npm run gen:videos   # once — generates 3 real test MP4s with ffmpeg
npm run seed         # once — demo advertiser, funded campaign, videos, accounts
npm run dev          # API + web on http://127.0.0.1:8787
```

Open **http://127.0.0.1:8787** (landing), **/app/signup.html** (watcher PWA), **/advertise/**, **/admin/**.

### Demo credentials (DEV ONLY — mock OTP, codes logged)

| Role | Phone | Notes |
|---|---|---|
| Admin | `+10000000001` | role `admin`; approve videos/payouts, config, audit |
| Advertiser | `+10000000002` | Demo Brand Ltd, $250 mock balance, 3 approved videos, 1 live campaign ($10 budget, $0.02/view, NG+KE) |
| Watcher | `+15551230001` | Adaeze (NG) |
| Watcher | `+15551230002` | Brian (KE) |
| Watcher | `+15551230003` | Chidi (NG) |

**Sign-in flow:** `POST /v1/auth/otp/request {"phone_e164":"+15551230001"}` → read the code from `GET /v1/_dev/last-otp?phone=%2B15551230001` (the response also includes `dev_code` in non-prod) → `POST /v1/auth/otp/verify {"phone_e164":"…","code":"…","device":{"fingerprint":"…"}}`. Cookies (`kw_at`/`kw_rt`) are httpOnly.

### Demo walkthrough (5 minutes)

1. **Watcher:** sign up at `/app/signup.html` with `+15551230001` (OTP from `/v1/_dev/last-otp`). Queue shows the Demo Brand video (+$0.02). Tap **Watch** → player streams real video via token-bound `/v1/stream`.
2. Watch honestly — the bar fills with **verified segments** (what counts), the checklist tracks 90% / attention check / tab visibility. Answer the tap check when it pops (the 75s spot also asks a quiz question).
3. On completion: "+$0.02 added to your balance". Check **Earnings** → expand the receipt (session id, watch %, attention, checks, country).
4. **Advertiser:** sign in as `+10000000002` → `/advertise/` → top up mock funds, upload a video (presigned PUT → confirm), watch it land **In review**.
5. **Admin:** sign in as `+10000000001` → `/admin/` → approve the video → create a campaign → it goes live.
6. **Payout:** back as the watcher, lower `min_payout_cents` via Admin → Config (default $1.00 needs 50 views), request an M-Pesa payout → admin **Payout queue** → Approve → it processes on the next cron tick (≤60 s locally) → **Paid** with a `MOCK-MPESA-…` txRef. Restore the $1.00 min after.
7. Run the scripted suites instead: `npm run e2e` (full loop, ~2 min, honest real-time heartbeats) and `npm run adv` (all 12 threat-model probes, 28 checks, ~3 min). Results are recorded in `docs/QA-REPORT.md`.

---

## What is mocked vs real (honest table)

| Area | Status |
|---|---|
| Video bytes | **Real** — ffmpeg-generated MP4s, streamed with Range/206 through token validation |
| Watch verification | **Real** — heartbeat chain, position window, rate lock, visibility, attention checks, 90% rule, double-entry credit |
| Ledger | **Real** — balanced groups, optimistic locking, idempotency, no-negative invariant (unit-tested) |
| Assignment/pacing | **Real** — pacing-deficit ordering, daily/per-user caps, targeting, skip cooldown, velocity |
| SMS OTP | **Mock** — `MockSmsAdapter` logs codes; `SmsAdapter` interface ready for a real provider |
| Advertiser funding | **Mock** — `MockCardAdapter`, instant fake settlement; `FundingAdapter` interface ready |
| Payouts | **Mock** — 4 adapters validate/quote/execute with fake txRefs + failure injection; `PayoutAdapter` interface identical for real rails |
| FX | **Mock** — estimate only on the payout screen, labeled as demo |
| ASN/country | **Real** in prod via `request.cf`; locally absent (skipped, documented) |
| Admin re-auth (12 h) | **Real** — payout approve/reject returns `reauth_required` when the admin session is older than 12 h; console shows a sign-in-again banner |
| Push notifications | **Out** of MVP (email link only, per deepdive) |

## Known limitations

- Local R2 shim has no SigV4 — uploads use an HMAC-signed local URL (same flow, documented in `r2sign.ts`).
- `wrangler.toml` ships for real deploys but the D1/R2 bindings are commented until IDs exist; `src/workers.ts` is the deploy entrypoint (not exercised against real Cloudflare here).
- Heartbeat evidence purges at 90 days via cron; aggregates live on forever.
- The PWA targets modern mobile browsers; the player needs JS + HTML5 video.
- No i18n (English only), no referrals, no native apps — all deliberate MVP scope cuts (see `docs/DECISIONS.md`).

---

## API quick reference

Base `http://127.0.0.1:8787/v1` (prod: `https://api.kudiwatch.com/v1`). Auth: `kw_at`/`kw_rt` cookies. Envelope: `{data}` or `{error:{code,message,request_id}}`.

Auth: `POST /auth/otp/request` · `POST /auth/otp/verify` · `POST /auth/refresh` · `POST /auth/logout` · `GET /me` · `PATCH /me`
Watcher: `GET /feed/next` · `POST /assignments/:id/claim` · `POST /assignments/:id/skip` · `POST /watch/:sid/heartbeat` · `POST /watch/:sid/attention` · `POST /watch/:sid/complete` · `GET /watch/:sid/receipt` · `GET /wallet` · `GET /wallet/ledger` · `POST /payouts` · `GET /payouts[/​:id]`
Advertiser: `POST /advertiser/profile` · `POST /advertiser/videos/upload-url` · `POST /advertiser/videos/:id/confirm` · `GET /advertiser/videos` · `POST /advertiser/wallet/topup` · `POST /advertiser/campaigns` · `PATCH /advertiser/campaigns/:id` · `GET /advertiser/campaigns/:id/report` · `GET /advertiser/campaigns/:id/receipts[?format=csv]`
Admin: `GET /admin/videos/review-queue` · `POST /admin/videos/:id/review` · `GET /admin/accounts/flagged` · `GET /admin/accounts/:id/signals` · `POST /admin/accounts/:id/flag` · `POST /admin/accounts/:id/clear` · `POST /admin/accounts/:id/grant-admin` · `GET /admin/payouts/queue` · `GET /admin/payouts[?status=]` · `POST /admin/payouts/:id/decision` · `GET /admin/campaigns` · `GET|PUT /admin/config` · `GET /admin/audit-log`
Stream: `GET /stream/:videoId?wt=<watch-token>` (Range-capable, token-bound)
Dev (non-prod): `GET /_dev/last-otp?phone=` · `GET /_dev/fraud` · `POST /_dev/cron`
