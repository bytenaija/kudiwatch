# KudiWatch — QA Report (implementation verification)

**Date:** 2026-10-09 · **Author:** implementation engineer (finishing pass) ·
**Scope:** deepdive build steps 0–10 acceptance (step 11, gate-0 dry run, is for the coordinator/founder).

The previous engineer left the build ~90% complete and unverified. This report records what was actually executed and the results. Nothing here is asserted without a run behind it.

---

## 1. Static checks

| Check | Command | Result |
|---|---|---|
| Install | `npm install` | clean (15 packages) |
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **clean, 0 errors** |
| Unit tests | `npm test` (vitest) | **10/10 pass** — `apps/api/test/ledger.test.ts`: balanced-group invariant, negative-balance refusal, idempotent re-post, partial-group refusal, version-conflict path, fee math |

## 2. Scripted E2E (`npm run e2e`, ~80 s, real-time 10 s heartbeats)

Full loop on the live server, all green:
- signup → mock OTP (dev endpoint) → feed offer → claim (watch JWT + 2 scheduled checks)
- stream `Range: bytes=0-1023` → **206**, 1024 bytes through token validation
- 7 honest heartbeats (10 s cadence) → watched 93.3% (75 s video)
- tap check presented + passed; quiz check presented + answered + passed
- `complete` → **completed, credited 2c**; double-`complete` → same receipt (idempotent)
- wallet: balance 2c / pending 0c / lifetime 2c; receipt shows watched %, attention %, checks
- admin lowered `min_payout_cents` → payout request 201 → double-POST same idempotency key → same payout id
- admin approve → `_dev/cron` → **payout `completed`**, `payout_attempts` row with `MOCK-MPESA-…` txRef
- `min_payout_cents` restored to 100 afterwards

**Result: ALL CHECKS PASSED ✔**

## 3. Adversarial suite (`npm run adv`, ~3 min, 28 checks)

Threat-model probes (deepdive §13), all passing:

| Probe | Result |
|---|---|
| 6 — OTP brute force (6 wrong codes) | ✔ locked (`otp_locked`), signal recorded |
| 4/3 — stream without / with garbage token | ✔ 401 / 401 |
| 9 — admin cookie replay after logout | ✔ 401 (session-bound tokens) |
| 2 — replayed seq / 2x speed / hidden playback | ✔ `dup_seq` / `bad_rate` / `hidden` rejections; session survives single anomalies |
| 11 — 20 concurrent `complete` calls | ✔ all `completed`, exactly one 2c credit (idempotent group + guarded flip) |
| 5 — no-repeat after completion | ✔ campaign not re-offered (per-user cap) |
| 1 — 3 signups, 1 shared device fingerprint | ✔ first two claims allowed, third `device_blocked` |
| 8 — clock tampering (±1 h `client_ts` skew) | ✔ server clock authoritative; position jump still `jump`-rejected |
| 10 — advertiser uploads 5 s video | ✔ 422 `bad_duration` (< 15 s min) |
| 12 — refund loop (`payout_mock_failure_rate=1.0`) | ✔ 3 adapter attempts → `refunded`, wallet restored exactly once; destination immutable (no PATCH endpoint → 404; unchanged after approval) |

**Result: 28 passed, 0 failed ✔**

## 4. Independent manual walkthrough (48 checks, all pass)

A from-scratch Python client (not reusing the repo's scripts) verified what e2e/adv don't cover:

- **Advertiser ingest:** mock top-up (+$50, flagged `mock:true`) → presigned PUT upload → confirm → `in_review` → admin review queue → approve → campaign create → **$2.00 escrowed** (advertiser balance −$2.00)
- **Abuse on live sessions:** hidden-tab beat → `hidden`, **watched_pct stays 0** (zero credit); replayed seq → `dup_seq`; 2x → `bad_rate`; seek-forward → `jump`; forged bodies (`seq:0`, `seq:-5`, non-numeric position/rate, missing fields) → 400 schema rejection; session survives 2 medium-severity signals, invalidated on the 3rd (by design)
- **Honest 30 s watch:** 6 s heartbeats to 95% verified → tap check passed → `complete` → +2c → double-complete idempotent → receipt (watched %, attention, checks) → wallet 2c/2c
- **Payout rules:** $0.50 request → 422 `below_minimum` ($1.00 enforced); request 2c → 201; same idempotency key → deduped; second 2c request → 422 `insufficient_funds` (hold consumed balance); wallet shows balance 0 / pending 2c
- **Approval → cron → `completed`** with `MOCK-MPESA-…` txRef; destination masked in API responses
- **Advertiser proof:** report shows 1 view / 1 completion / spent 2c / remaining 198c; per-view receipts list the session (watched ≥ 90%, attention, checks, country); **CSV export works**
- **Audit:** `video.review`, `payout.decide`, `config.set` all in `admin_audit_log`; `min_payout_cents` restored to 100

**Result: ALL PASS (48/48) ✔**

## 5. Ledger invariant sweep (direct SQL)

- `SELECT COUNT(*) FROM ledger_accounts WHERE balance_cents < 0` → **0**
- Every `group_id`: Σ(debits) = Σ(credits) → **0 unbalanced groups**
- Spot-checked balances reconcile with the walkthrough (escrow 198c remaining, campaign spent 2c, watcher lifetime 2c)

## 6. PWA smoke (headless Chromium, `chrome-headless-shell`)

- All 8 pages (`/`, `/app/*`, `/advertise/`, `/admin/`) load; **0 console errors** after the fix below
- Unauthenticated pages correctly redirect to `/app/signup.html`
- Copy spot-check: attention overlay matches COPY.md verbatim ("Quick check — are you still watching?" / "Answer within 15 seconds to keep earning.")
- Mock-mode banner code path executes (its crash was the bug found below)

## 7. Bugs found and fixed

1. **`apps/api/wrangler.toml`: `main = "src/index.ts"` → `"src/workers.ts"`.**
   `index.ts` exports `createApp`/`scheduled` but no default fetch handler; the documented deploy entrypoint is `workers.ts`. A real `wrangler deploy` would have failed. Fixed; README already named `workers.ts` correctly.
2. **`apps/web/public/js/kw.js` — `mockBanner()` TypeError.**
   `document.body.prepend(host.firstElementChild)` moves the node out of `host`, so `host.querySelector('.x')` was `null` → uncaught TypeError on every money page (`/app/`, `/app/watch.html`, `/app/payout.html`, `/app/earnings.html`, `/advertise/`). Fixed by capturing the element reference before prepending. Verified: 0 console errors on all pages afterwards.

Non-bugs encountered (my own harness mistakes, not product defects):
- Killing the dev server with a `| head -20` pipe mid-run; restarted cleanly.
- Reusing one device fingerprint across admin/advertiser/watcher test signins → correctly `device_blocked` (the multi-account gate working as designed).
- Firing anomaly probes faster than the 5 s beat-frequency rule → correctly `too_fast`-rejected.

## 8. Honest list: still mocked, stubbed, or incomplete

- **SMS OTP** — `MockSmsAdapter` logs codes; `SmsAdapter` interface ready. Real provider at gate 2.
- **Advertiser funding** — `MockCardAdapter`, instant fake settlement; `FundingAdapter` interface ready.
- **Payouts** — 4 mock adapters (M-Pesa / bank / airtime / USDT); UI labels mock mode on every money screen. Identical `PayoutAdapter` interface for real rails.
- **FX** — mock estimate only on the payout screen ("Demo estimate — not a real rate"); never touches the ledger.
- **ASN/country** — real via `request.cf` in prod; locally absent (gates skipped, documented).
- **Uploads** — local HMAC-signed shim; prod path is true SigV4 presigned PUTs (code ships, **not exercised against real Cloudflare** — no account in this environment).
- **Deploy path** — `wrangler.toml` + `src/workers.ts` ship for real deploys; never run against real Cloudflare here. D1/R2 bindings are commented until IDs exist.
- **Admin TOTP** — deferred to gate 2 per DECISIONS.md #18 (short-lived cookies + 12 h re-auth + audit log at MVP).
- **Push notifications** — out of MVP (email link only).
- **PWA player vs API** — the heartbeat/attention/complete protocol the player speaks was verified end-to-end at the API level; the player itself was smoke-tested for JS errors, not driven through a real video playback in a browser (headless-shell has no media pipeline for the full watch).
- **Watch-page Skip button** — abandons the session client-side (silence cron frees the assignment) rather than calling `POST /assignments/:id/skip`; outcome equivalent, 24 h skip-cooldown only applies via the queue-page skip.
- **Test residue** — e2e/adv/manual runs leave paused probe campaigns, test users, and signals in the *local* `data/` DB (gitignored, regenerable). The seed campaign was left **live** and `min_payout_cents` restored to **100**.

## 9. Deepdive acceptance checklist (steps 0–10)

| Step | Status |
|---|---|
| 0 Scaffold & schema | ✅ migrations apply clean; seed loads |
| 1 Auth | ✅ OTP cycle, lockout, refresh rotation, logout |
| 2 Ledger | ✅ 10 unit tests + SQL invariant sweep |
| 3 Advertiser ingest | ✅ upload → review → campaign + escrow |
| 4 Assignment + claim | ✅ caps, pacing, no-repeat, skip, expiry cron |
| 5 Player + watch session | ✅ verification engine; PWA smoke-tested |
| 6 Payouts | ✅ request → approve → cron → completed / refund |
| 7 Quiz + receipts | ✅ quiz fail → no credit; report reconciles; CSV |
| 8 Fraud v1 | ✅ all threat probes blocked or flagged |
| 9 Admin + audit | ✅ every mutation audited with before/after |
| 10 Adversarial QA | ✅ 28/28 (this file) |

Step 11 (gate-0 dry run with humans) is out of scope for this pass — handed to the coordinator.
