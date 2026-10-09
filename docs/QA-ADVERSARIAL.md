# KudiWatch — Adversarial QA Report

**Date:** 2026-10-09 · **Author:** adversarial QA engineer (independent pass) ·
**Build:** commit `a563bb4` + 5 uncommitted fixes from this pass (see §7) ·
**Method:** fresh DB (re-seeded from `db/seed.sql`), `npm run typecheck` + `npm test` baseline,
live server on `http://127.0.0.1:8787`, attacks via independent Python clients
(not reusing `scripts/adversarial.ts` — deliberately fresh angles).

**Scope note:** this pass did NOT re-run the implementation engineer's 28 probes
as a victory lap. Every attack below is either new or a harder variant.
Where I re-ran one of theirs (auth batch), it was to establish a baseline on the
fresh DB, not to claim their results.

**Verdict up front:** I broke the core watch-verification engine once (HIGH),
found one medium and three low/medium bugs, and fixed five issues total —
all re-verified. The ledger, auth/session layer, payout state machine, and
role gates survived everything I threw at them. Two mediums remain OPEN
(device-gate bypass without fingerprint; unvalidated video duration/size),
plus honest limitations listed in §9.

---

## 1. Auth / session attacks — ALL REPELLED

| # | Attack | Evidence | Result |
|---|---|---|---|
| A1 | Forged access JWT (flipped signature char) | `GET /v1/me` → `401 unauthorized` | ✅ repelled |
| A2 | `alg=none` confusion | crafted header `{"alg":"none"}` → `401` | ✅ repelled (`algorithms:['HS256']` pinned) |
| A2b | `alg=HS512` confusion | → `401` | ✅ repelled |
| A3 | Cross-user: A's cookie on B's watch session | heartbeat → `403 forbidden`; receipt → `403` | ✅ repelled (`ownSessionError`) |
| A4 | Refresh-token replay after rotation | old RT → `401`; new RT → `200` | ✅ repelled |
| A5 | OTP for phone A used on phone B | `401 otp_mismatch` | ✅ repelled (codes keyed per phone) |
| A6 | Admin cookie replay after logout | access + refresh replay → `401` | ✅ repelled (session-bound tokens) |
| A7 | Session fixation | two logins → two distinct session ids; old session stays valid 15 min (by design, short TTL) | ✅ no fixation |
| A8 | Refresh token presented as access token | `401` | ✅ repelled |
| A9 | Empty / garbage / two-part tokens | all `401` | ✅ repelled |
| A10 | Suspended user | `/me` → `403 account_suspended`; payout request → `403` | ✅ enforced |
| A11 | Banned user re-login | OTP verify → `403 account_banned` | ✅ enforced |
| A12 | Expired access JWT (dev-secret-signed, white-box) | `401` (control: fresh token → `200`) | ✅ exp enforced |
| A13 | Revoked session, still-valid token | `401` | ✅ revocation immediate |
| A14 | Role escalation via token `roles` claim | dev-secret-signed `roles:["admin"]` → **`403`** | ✅ defense in depth: roles loaded from DB, not token |
| A15 | Expired watch token on `/v1/stream` | `401` | ✅ repelled |
| A16 | `PATCH /me` with `roles:["admin"]` | roles ignored, still `["watcher"]` | ✅ repelled (zod strips) |

**Notable positive:** even with the signing secret, privilege escalation via the
JWT is impossible — `requireRole` reads roles from the DB-loaded user, never the
token claims.

---

## 2. Watch-verification attacks

### 🔴 FINDING 1 (HIGH, FIXED): buffering-inflated seek — whole-video skip in 2 heartbeats

**Attack:** `validateHeartbeat` let client-declared `buffering_s` expand the
position-continuity window:
`hi = last + elapsed*1.25 + 2.0 + buffering` (up to +120 s per beat).

**Evidence (before fix):**
```
POST /v1/watch/<sid>/heartbeat {"seq":2,"position_s":74.0,"buffering_s":120,...}
→ {"ok":true,"watched_pct":98.67}      # 75 s video, 2nd heartbeat
```
Full exploit chain executed end-to-end: 75 s video "watched" in ~11 s of
heartbeats; tap check presented late + answered; quiz guessed (1-in-4);
`POST /complete` → **`{"status":"completed","credited_cents":2}`**.

Worse, on a **tap-only video** (no quiz) the bypass is total — proven with a
garbage-bytes "video" (see Finding 4): 30 s video, 2 heartbeats (~11 s),
tap answered → **2¢ credited for ~12 s of scripting**.

**Fix** (`apps/api/src/lib/verify.ts`): `buffering_s` no longer expands the
position window (`hi = last + elapsed*1.25 + 2.0`). Buffering still extends the
wall-clock bound via `total_buffering_s` (legitimate). Added a `low`
`buffering_anomaly` signal for contradictory claims (heavy buffering + max-rate
advance) — signal, not reject, to protect cheap Androids that misreport.

**Re-verified:** same attack → `{"ok":false,"reject_code":"jump"}` +
`position_jump` **high**-severity signal, `watched_pct` stays 0.
Regression: honest watch with genuine buffering stalls (position frozen,
`buffering_s: 5`) completes and credits normally — **no regression**.

Residual: the `elapsed*1.25 + 2.0` slack lets a bot advance ~1.8× realtime
(~42 s minimum for a 75 s video). Attention checks still gate; accepted as
jitter tolerance (LOW).

### Other watch attacks — all repelled

| # | Attack | Evidence | Result |
|---|---|---|---|
| W1 | Heartbeat schema abuse (`seq:0/-5/1.5`, `position:-5/"ten"`, missing fields, string rate) | all `400 bad_request` | ✅ |
| W1b | `playback_rate: 0.999999` | `bad_rate` (strict `!== 1`) | ✅ |
| W2 | Seq gap then resume | `seq_gap` (medium signal); chain recoverable via `last_seq+1` after 5 s | ✅ by design |
| W3 | Heartbeat after completion/failure | `session_failed` / `session_completed` | ✅ |
| W4 | **Concurrent claim race** — 40 threads × 3 rounds, same assignment | exactly 1/40 `200`, rest `409 bad_state`; 1 session row | ✅ safe (recommendation: guarded `UPDATE … WHERE status='offered'` as hardening — the window is tiny but not DB-guaranteed) |
| W5 | Quiz brute force | wrong answer → `{"passed":false,"reason":"wrong_answer"}` → session `failed/attention_failed`; no retries | ✅ (1-in-4 guess per attempt is the residual) |
| W6 | Complete without ever presenting checks | `failed/attention_missed` | ✅ |
| W7 | Attention timeout (present, never answer, heartbeat) | `attention_timeout` → session `failed` | ✅ |
| W8 | Present check too early | `409 too_early` | ✅ |
| W9 | Double-answer a check | `409` | ✅ |
| W10 | `choice_idx: 9` | `400` (schema) | ✅ |
| W11 | Claim while session active | `409 session_active` | ✅ |
| W12 | `answer_idx` leak in quiz present payload | absent from payload | ✅ |

---

## 3. Money attacks

### 🟠 FINDING 2 (MEDIUM-LOW, FIXED): cross-user idempotency-key collision

**Attack:** `POST /payouts` looked up `idempotency_key` globally. User B
replaying user A's key got `200 {deduped:true, payout:{id: <A's payout>}}` —
another user's payout id + status disclosed; B sees a false "success".

**Evidence:** `B reuses racer's key -> HTTP 200, deduped=True,
payout_id=0e8ae231-…` (identical to A's payout id).

**Fix** (`apps/api/src/routes/watcher.ts`): lookup scoped to
`WHERE idempotency_key = ? AND user_id = ?`. Client-chosen UUIDs can no
longer collide across users.

**Re-verified:** B reusing A's key → `422` on B's own validation path, no
`deduped`. Same-user same-key dedup unaffected.

### 🟠 FINDING 3 (MEDIUM-LOW, FIXED): payout destination label unmasked

**Attack:** `redactDestination` kept `label` raw — and for mpesa/airtime the
label **is** the full E.164 number. `GET /payouts`, `GET /payouts/:id`, and the
**admin** queue/list all returned `"label": "+254700000009"`.

**Fix** (`apps/api/src/lib/payouts.ts`): E.164-shaped labels are masked via
`maskPhone` → `"+254 •• ••• 009"`.

**Re-verified:** all three endpoints return the masked label.

### Other money attacks — all repelled

| # | Attack | Evidence | Result |
|---|---|---|---|
| M1 | 6 concurrent full-balance payouts (different idempotency keys) | exactly 1× `201`, 5× `422 insufficient_funds`; balance 0, **0 negative accounts** | ✅ race safe (optimistic locking) |
| M2 | Double-approve payout | 2nd → `409 bad_state` | ✅ |
| M3/M4 | approve→reject, reject→approve, reject→completed | all `409` | ✅ state machine is one-way |
| M5 | Refund-gamer loop (failure_rate=1.0 → refund → re-request ×2) | `refunded`, wallet restored to exactly 2¢ each cycle — **no free money** | ✅ |
| M6 | Payout amount 0 / negative / 10¹⁵ / 10¹⁸ | `400` / `400` / `422 insufficient_funds` / `400` (zod rejects unsafe integers — fail-closed) | ✅ |
| M7 | Below-minimum payout | `422 below_minimum` | ✅ |
| M8 | Concurrent completes + payouts → ledger sweep | 34 entries / 17 groups: **0 negatives, 0 unbalanced, every account reconciles** | ✅ |
| M9 | Admin 12 h re-auth (session backdated 13 h) | decision → `401 reauth_required`; fresh session → passes gate | ✅ |
| M10 | Campaign budget > balance | `422 insufficient_funds` (escrow post fails) | ✅ |
| M11 | Campaign budget == balance → end | balance 0 → full refund on end; campaign account 0 | ✅ |
| M12 | Concurrent double-end of campaign (5 threads) | exactly one `escrow-release` group (2 entries) — idempotent | ✅ |

---

## 4. Advertiser / admin attacks

### 🟡 FINDING 4 (MEDIUM, OPEN): video bytes + duration never validated

**Attack chain (executed end-to-end):**
1. `POST /videos/upload-url` with `size_bytes: 1024` → PUT **10 MB** of bytes →
   stored 10,485,760 bytes. **The claimed `size_bytes` is never checked
   against the actual upload** — `max_upload_bytes` is bypassable by lying
   (storage-abuse vector).
2. PUT 1 KB of **garbage (not a video)** → `POST /videos/:id/confirm
   {"duration_s": 30}` → `200 in_review`. **No media inspection** (no
   ffprobe): `duration_s`, dimensions, and even the container are
   client-claimed. The 15 s minimum is enforced on the *claim*, not the media.
3. Admin approved (human review is the only real gate) → campaign live →
   watchers earn on an unplayable "video" (combined with Finding 1 pre-fix).

**Why OPEN:** proper fix is server-side media probing (ffprobe) at confirm
time — needs a design call (async probe job vs. synchronous; Workers can't
run ffprobe — must be a pre-upload client attestation + admin thumbnail
check, or a queue worker). Human review currently covers it at gate 0/1
scale, but it's not a technical control. **Recommend:** at minimum, verify
`size_bytes` against actual stored bytes at confirm (cheap, local + R2
`head`), and probe duration where a runtime allows.

Upload-URL tampering itself is solid: cross-video key → `403`, `..`
traversal → `400`, expired grant → `403`, missing sig → `400`.

### 🟡 FINDING 5 (LOW-MEDIUM, OPEN): advertiser can watch their own campaign

**Evidence:** signed in as the demo advertiser, `GET /feed/next` offered
`"QA tap-only trap"` with `advertiser_is_self=True`. `nextOffer` never
excludes `advertiser_id = user.id`.

**Impact:** no direct theft (self-watch moves own escrow to self, minus the
platform spread which sweeps to fees) — but it inflates view/completion
stats, the exact metric advertisers pay for. **Recommend:** exclude own
campaigns in `nextOffer` (one-line `AND c.advertiser_id != ?`).

### Other advertiser/admin attacks — all repelled

| # | Attack | Evidence | Result |
|---|---|---|---|
| D1 | Watcher/advertiser on all admin endpoints (review queue, config, payout decision, audit log, grant-admin) | all `403` | ✅ |
| D2 | Advertiser approving own video | `403` | ✅ |
| D3 | Watcher on advertiser endpoints (campaigns, videos) | `403` | ✅ |
| D4 | Advertiser B confirming advertiser A's video | `404` | ✅ |
| D5 | Campaign on unapproved video | `422 video_not_approved` | ✅ |
| D6 | Ended → live "zombie" campaign | allowed; completes fail `campaign_insolvent` (fail-closed, but watchers waste time — recommend blocking re-live after escrow release) | ⚠️ low, noted |

---

## 5. Fraud-evasion attacks

### 🟡 FINDING 6 (MEDIUM, OPEN): device gate bypassed by omitting the fingerprint

**Attack:** the 1:1 device enforcement (`trackDevice`, `accountCount > 2`
block) only runs when the client volunteers a fingerprint — `device` is
optional at OTP-verify and `x-device-fp` is optional at claim.

**Evidence:** 3 fresh accounts created with **no** `device` field, all
claimed successfully with **no** `x-device-fp` header — the multi-account
gate never fired (threat-model row #1's main technical control).

**Why OPEN:** a fingerprint is client-asserted and forgeable anyway, so
making it mandatory is not a complete fix by itself — but "optional" means
the control is *trivially* bypassed rather than merely circumventable.
**Recommend (defense in depth):** require the fingerprint at claim time
(reject claims without `x-device-fp`); keep signup optional for UX. Pair
with the existing velocity caps and manual payout review.

### 🟢 FINDING 7 (MEDIUM-LOW, FIXED): OTP 1-hour lock was bypassable

**Attack:** 5 wrong codes → `429 otp_locked` (lock until +1 h). But after the
60 s resend cooldown, requesting a fresh code created a new row and the
attempt counter reset — the "1 h lock" lasted ~60 s. Effective brute-force
rate was 5 attempts/min/phone, unbounded.

**Evidence:** `wrong attempt on FRESH code: 401 otp_mismatch` (fresh
attempts-left, lock evaporated).

**Fix** (`apps/api/src/lib/sms.ts`): `requestOtp` now checks the latest
row's `locked_until` — a locked phone gets no new code until the lock
expires (response stays always-200, `resend_after_s` = lock remainder).

**Re-verified:** after 5 wrong + 65 s wait, re-request →
`{sent:true, resend_after_s:3538}` (no new code; ~59 min lock remainder).

Still open by design: no per-IP/global OTP rate limit — SMS-pumping cost
is a gate-2 (real provider) concern. Noted.

### Other fraud probes

| # | Attack | Evidence | Result |
|---|---|---|---|
| F1 | Same phone, different device | same `user.id` — phone is the identity | ✅ 1:1 enforced |
| F2 | Claim velocity boundary (3/min) | claims 1–3 → `200`, 4th–5th → `429 too_fast` | ✅ exact boundary |
| F3 | Watch velocity (`max_views_per_hour`) | `nextOffer` returns `reason: velocity` at cap | ✅ (code path; boundary exact by `count >= limit`) |
| F4 | Emulator UA | `emulator_ua` medium signal recorded | ✅ |
| F5 | Session silence (claim, no heartbeats) | after ~130 s: session `expired/silence_timeout`, assignment `expired` (re-offerable) | ✅ cron works |
| F6 | Same destination on 2 users | `payout_destination_reuse` high signal | ✅ (code path) |

---

## 6. Input-abuse / transport attacks — ALL REPELLED OR NOTED

| # | Attack | Evidence | Result |
|---|---|---|---|
| I1 | SQLi in phone / display_name / path id / config key | binds everywhere; tables intact; config key stored literally | ✅ |
| I2 | 5 MB JSON body | `400` via zod bounds, no crash | ✅ (no global body-size limit — a 500 MB body would buffer in memory; LOW, recommend a limit at gate 1) |
| I3 | Wrong `Content-Type` (text/plain JSON) | parsed anyway (hono ignores ctype) | ✅ not a vuln |
| I4 | CORS origin reflection with `credentials:true` | `Access-Control-Allow-Origin: https://evil.example` reflected — **sloppy, but** cookies are `SameSite=Lax` (cross-site fetch POST can't carry them) and state-changing endpoints need JSON (preflight). CSRF risk: **LOW**. Recommend tightening origin in prod (the code comment says "tighten in prod" but nothing does). | ⚠️ low |
| I5 | `x-cf-asn` / `x-cf-country` header spoofing | trusted only when `request.cf` absent (local dev); prod prefers real `request.cf` | ✅ by code (dev-only surface) |

---

## 7. Fixes applied in this pass (all re-verified, none committed)

| # | File | Change |
|---|---|---|
| 1 | `apps/api/src/lib/verify.ts` | **HIGH:** `buffering_s` removed from heartbeat position window; added `buffering_anomaly` low signal |
| 2 | `apps/api/src/lib/verify.ts` | Uniform-beat signal deduped to 1/session (was: per-beat → honest metronomic clients on long videos auto-invalidated via 3-mediums rule) |
| 3 | `apps/api/src/routes/watcher.ts` | Payout idempotency lookup scoped per user |
| 4 | `apps/api/src/lib/payouts.ts` | `redactDestination` now masks E.164 labels (`+254 •• ••• 009`) |
| 5 | `apps/api/src/lib/sms.ts` | OTP lock binds the phone, not the code row |

`npm run typecheck`: clean. `npm test`: 10/10. Final ledger sweep: 34 entries /
17 groups — 0 negative balances, 0 unbalanced groups, every account reconciles.

`git status`: only the 4 files above modified; **nothing committed** (per
instructions — coordinator owns commits). Test residue lives in the gitignored
`data/` dir (fresh re-seed); `/tmp/kw-data-backup-qa` holds the pre-pass DB.

---

## 8. What survived (honest strengths worth keeping)

- **Ledger:** double-entry with optimistic locking held under every race I
  built (concurrent full-balance payouts, concurrent completes, double-end
  campaigns, refund loops). Idempotency on `group_id` is the load-bearing
  wall and it works.
- **Auth:** session-bound JWTs, immediate revocation, role checks against
  DB (not token), OTP keyed per phone, suspended/banned enforcement.
- **Payout state machine:** strictly one-way (`pending_review → approved/
  rejected → processing → completed/refunded`); double-approve, backward
  moves all `409`; 12 h admin re-auth gate works.
- **Attention checks:** no-ret
...[truncated 1910 chars]

---

## 9. Coordinator close-out (2026-10-09)

The QA engineer was killed by an infrastructure restart mid-write (§8 above is truncated). As coordinator I closed the three OPEN findings myself, re-verified each live against a fresh server, and recorded the product calls in `docs/DECISIONS.md` (#34–#36):

- **Finding 5 (advertiser self-watch) — FIXED:** `nextOffer` (`lib/assign.ts`) now excludes `c.advertiser_id = user.id`. Verified live: signed in as Demo Brand Ltd, `GET /v1/feed/next` offers nothing from their own campaigns.
- **Finding 6 (device gate bypass) — FIXED:** `POST /v1/assignments/:id/claim` now requires `x-device-fp` → `403 device_required` + `missing_device_fp` low signal when absent. Verified live: 403 without the header, 200 with it. The PWA already sends `X-Device-Fp` on every request (`kw.js`), so honest users are unaffected.
- **Finding 4 (upload validation) — PARTIAL FIX:** `POST /v1/advertiser/videos/:id/confirm` now rejects with `422 size_mismatch` when stored bytes ≠ declared `size_bytes` (R2 `head()`, portable to real R2 and the local fs shim). Verified live: declared 16 B / stored 1024 B → 422; exact match → `in_review`. Duration/container/dimension claims remain client-asserted — true media probing (ffprobe) cannot run in Cloudflare Workers, so the human admin review (every video is `in_review` before going live) stays the gate at gate-0/1 scale. Revisit with an async probe job before gate 2.

`npm run typecheck`: clean. `npm test`: 10/10. No money paths were modified by these fixes (read-only offer filter, claim gate, confirm gate); the ledger invariants from §7 stand.

**Remaining honest limitations** (unchanged from the QA pass): SMS OTP is mocked; advertiser funding is mock-card; payouts are mock adapters; FX estimates are demo-only; ASN/country gates are prod-only (`request.cf`); the deploy path (`wrangler.toml` + `src/workers.ts`) has never run against real Cloudflare; admin TOTP deferred to gate 2; no global body-size limit (LOW); CORS origin reflection noted LOW (SameSite=Lax cookies); PWA player smoke-tested for JS errors but not driven through real video playback in a browser.
