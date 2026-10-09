# KudiWatch — Decisions for Founder Review

Eva is AFK. I made reasonable calls so the build never blocks; each is recorded below with the recommendation I encoded in `docs/DEEPDIVE.md` and the alternative I rejected. Nothing here is irreversible before gate 2 — but several get expensive to change after real money flows, so flag disagreements early.

---

## Product / economics

### 1. Model: sponsored-attention on our own inventory (not YouTube)
- **Recommendation (locked):** advertisers pay for verified human attention on videos they upload to us; we host on R2 and serve through our own player. No YouTube embeds, no paying for YouTube views — ever.
- **Alternative considered:** the original brief (pay watchers to watch creators' YouTube videos in full). Rejected: it is textbook incentivized traffic under YouTube's Invalid Traffic / Fake Engagement policies (warning → 3 strikes → termination, view stripping, AdSense disablement). XCAD Network — the closest analog — ran out of funds Aug 2026 and died; Zynn was delisted from both app stores.
- **Confirm:** none needed; this was your call. Recorded so the builder never drifts.

### 2. Ledger currency: USD cents internally
- **Recommendation:** all ledger amounts in USD cents; local-currency display via a mock FX table at payout time.
- **Alternative:** NGN/KES-native ledger. Rejected: multi-country from day one (NG, KE, IN, PH, ID) makes a single base currency simpler; FX only matters at the payout edge, which is mocked at MVP anyway.
- **Revisit at:** gate 2, when real M-Pesa payouts force a real FX source.

### 3. Watcher pay: $0.01–$0.03 per completed view (default); advertiser CPC $0.03–$0.08
- **Recommendation:** campaign-settable, defaults in that band; platform margin = spread (50–70%).
- **Alternative:** flat $0.02. Rejected: advertisers need price control to manage budgets; watchers in research earn ~$0.50–$1.00/hr on GPT sites, so a 60 s view at $0.02 ≈ $1.20/hr of *active* attention — competitive without torching margin.
- **Watch at gate 1:** if completion rate < 50%, price is too low or videos too long; if > 90%, suspect bots.

### 4. Minimum payout: $1.00
- **Recommendation:** $1.00 (100 cents), enforced in schema.
- **Alternative:** $5–$10 (ClipClaps used $10 and collapsed into user hatred; FreeCash uses $5 first / region-dependent). $1.00 builds trust fast in markets where $1 is meaningful, and fraud is contained by manual approval + phone identity. Raise it if payout-queue ops cost exceeds margin.

### 5. Completion threshold: ≥90% watched, no partial credit
- **Recommendation:** 90% of duration from unioned heartbeat intervals + all due attention checks passed; binary credit, no partial.
- **Alternative:** 80% (XCAD used 80%) or 100%. 80% felt gameable with seek-clamp edge cases; 100% punishes buffering on 3G. 90% is the standard rewarded-video bar. Partial credit adds ledger complexity for pennies — cut at MVP, revisit if watchers complain.

### 6. Heartbeat interval: 10 seconds
- **Recommendation:** 10 s beats; session invalidated after 60 s of silence.
- **Alternative:** 5 s (2× D1 writes, tighter evidence) or 30 s (cheaper, weaker anti-fraud). 10 s ≈ 18 rows for a 3-min video — trivial for D1, strong enough for continuity checks. Tunable via `config.heartbeat_interval_s` without redeploy.

### 7. Attention checks: random, 1–2 per video ≥60 s; tap default, quiz optional
- **Recommendation:** server-scheduled at claim time, never in first/last 5 s; tap-to-confirm (15 s timeout) default; advertiser-supplied 1-MCQ quiz optional (asked post-70%).
- **Alternative:** fixed mid-roll check (predictable → scriptable) or no checks for short videos (chosen: <60 s gets 0–1 tap check). Randomness is the anti-scripting property — keep it.

### 8. Identity: phone OTP only at MVP; ID verification deferred to gate 2
- **Recommendation:** one account per verified phone number; no government ID at MVP.
- **Alternative:** FreeCash-style ID before first withdrawal from day one. Rejected for MVP: adds friction before product-market fit and all payouts are mocked anyway. **But:** ID verification (or equivalent liveness) is mandatory before gate 2 real-money payouts — that's the industry backstop against number farms.
- **Confirm:** acceptable risk posture for closed beta?

### 9. Video: 15–180 s, MP4/H.264, ≤200 MB, no server transcoding at MVP
- **Recommendation:** single MP4 rendition, progressive streaming from R2; validation = magic bytes + browser metadata + human admin review.
- **Alternative:** Cloudflare Stream or a transcode pipeline. Rejected: Stream is a paid product; self-built transcoding is a whole project. Short videos at 720p stream fine progressively on 3G. Revisit when advertisers demand 1080p+ or adaptive bitrate.

### 10. Payouts: manual approval always at MVP; 4 mocked adapters, identical interface to real ones
- **Recommendation:** every payout waits for an admin click; mocks for M-Pesa, bank, airtime, USDT share the exact `PayoutAdapter` interface real adapters will implement.
- **Alternative:** auto-approve under a threshold (e.g. <$5). Rejected at MVP: with mock money there's no cost to manual review, and it forces us to build the review queue well. Auto-approve rules come at gate 2 with real fraud data.

### 11. Referrals: OUT of MVP entirely
- **Recommendation:** no referral program.
- **Alternative:** referral bonuses for growth (Roz Dhan, Zynn). Rejected: referrals are the #1 fraud vector in this space (fake accounts, number farms) and both reference cases ended badly (Zynn: FTC scrutiny; Roz Dhan: referrals drive nearly all real earnings, i.e., the product doesn't). Growth comes from watcher earnings credibility, not bounties.

### 12. Client: PWA only; no native apps at MVP
- **Recommendation:** mobile-first installable PWA, <300 KB gz JS budget.
- **Alternative:** React Native / native. Rejected: PWA reaches cheap Androids via URL with zero store risk (Zynn was delisted; stores hate earn-apps). Native only if PWA can't deliver (e.g., background playback policies — but background playback must NOT earn anyway).

### 13. Language: English-only UI at MVP
- **Recommendation:** English only; add Hausa/Swahili/Hindi post-gate-1 if cohort data justifies.
- **Alternative:** multi-language from day one. Rejected: translation multiplies QA surface; English is the lingua franca of the target earn-app markets.

### 14. Advertiser funding: mock money at MVP
- **Recommendation:** `MockCardAdapter` — instant fake settlement into the advertiser wallet.
- **Alternative:** real PSP integration now. Rejected: zero-spend constraint + no real credentials; the `FundingAdapter` interface makes the swap mechanical at gate 2.

---

## Technical

### 15. Single Worker + single Pages project (split later)
- **Recommendation:** one Hono Worker, one Pages project with `/app`, `/advertise`, `/admin` prefixes.
- **Alternative:** micro-Workers per domain. Rejected: the ledger transaction boundary and deploys stay trivial as a monolith; first split candidate is `/stream` if R2 egress dominates.

### 16. Watch-token binding: device fingerprint claim, loose (not IP-pinned)
- **Recommendation:** watch JWT carries `fp` (device hash); mismatch → fraud signal, not instant fail (cheap Androids reinstall, fingerprints drift).
- **Alternative:** pin to IP. Rejected: mobile IPs rotate constantly in our markets; IP pinning would false-positive relentlessly.

### 17. Heartbeat evidence retention: 90 days, then purge
- **Recommendation:** cron purges `heartbeats` older than `config.heartbeat_retention_days` (90); aggregates (watched_pct, attention_score) live forever on `watch_sessions`.
- **Alternative:** keep forever (D1 quota risk) or 30 days (weaker dispute evidence). 90 days covers payout-dispute windows.

### 18. Admin 2FA (TOTP): deferred to gate 2
- **Recommendation:** at MVP, admin protection = short-lived cookies + re-auth for payout decisions + immutable audit log.
- **Alternative:** TOTP now. It's cheap to add but adds login friction during the fastest iteration phase; the audit log is the real control. Non-negotiable before real money.

### 19. No partial credit, no streaks, no gamification beyond attention score
- **Recommendation:** binary per-view credit; attention score shown to advertisers as quality signal.
- **Alternative:** streak bonuses, levels. Rejected: gamification mechanics are exploit surface (and ClipClaps showed they end in reward devaluation anyway).

### 20. Fraud posture: detect + human review; auto-block only the unambiguous
- **Recommendation:** auto-block datacenter ASNs, emulator UAs, OTP brute force; everything else → `fraud_signals` → manual review queue (payouts are manual anyway, so nothing pays out while flagged).
- **Alternative:** aggressive auto-ban heuristics. Rejected: false positives in our markets are costly (shared devices, carrier-grade NAT, VPN use for legitimate reasons). Tune toward auto-action only with gate-1 data.

### 21. Video URLs: never public; always token-bound Worker streams
- **Recommendation:** R2 private; `GET /stream/:videoId?wt=` validates the watch JWT per request with Range support.
- **Alternative:** signed R2 URLs with expiry. Weaker: a leaked URL plays anywhere until expiry and bypasses heartbeat binding. Worker-mediated streaming also gives us byte-count abuse signals.

### 22. Velocity caps: 10 completions/hour, 50/day per watcher (configurable)
- **Recommendation:** soft-block with `retry_after` + signal; caps in `config`.
- **Alternative:** no caps (simpler) or tighter (5/hr). 50/day × $0.02 = $1.00/day max — matches the ~$1/hr GPT benchmark and bounds worst-case fraud loss per account before review.

### 23. Skip cooldown: 24 h before a skipped video is re-offered
- **Recommendation:** watchers can skip; skipped assignments re-enter eligibility after 24 h.
- **Alternative:** never re-offer (cleaner) or immediate re-offer (annoying). 24 h balances watcher choice with campaign fill.

### 24. Domain: kudiwatch.com (and alternatives) — UNVERIFIED
- RDAP checks from this sandbox failed (egress blocked to Verisign RDAP). **Founder action:** check `kudiwatch.com` at a registrar; fallbacks `getkudiwatch.com`, `kudiwatch.app`. API subdomain `api.kudiwatch.com` assumed.

---

## What changes these decisions

- **Gate-1 data** (completion rate, fraud-signal rates, payout-queue load) is the scheduled moment to revisit #3, #4, #5, #20, #22.
- **Gate 2** (real money) forces #2 (FX), #8 (ID verification), #10 (auto-approve rules), #14 (real PSP), #18 (TOTP).
- Everything else stands until a concrete failure says otherwise.

---

## Implementation-stage resolutions (2026-10-09, founder AFK — DESIGN.md §12)

### 25. Earnings display currency: USD-only at MVP; local estimate only on the payout screen
- **Decision:** balances, earnings, and receipts stay USD-only everywhere. The payout screen shows a per-method local-currency *estimate* in small muted text, labeled "Demo estimate — not a real rate" (mock FX table, never touches the ledger).
- **Reasoning:** mock FX on the earnings screen would teach watchers wrong numbers they'd anchor on; but at the payout edge a local estimate answers "what does $2.50 mean for me" without implying a real rate. Revisit with real FX at gate 2 (see #2).

### 26. Attention-check copy tone: "Quick check — are you still watching?"
- **Decision:** adopt the mockup's line verbatim for the tap check ("Quick check — are you still watching?" + "I'm watching" button, "Answer within 15 seconds to keep earning.").
- **Reasoning:** neutral-polite beat brand-voice here — the check interrupts a video; warmth reduces the feeling of being policed. COPY.md already carried this line; locking it.

### 27. Failed-watch second chance: failed watches don't consume the per-user cap
- **Decision:** any watch that leaves `active` without completing (attention fail/timeout, under-watched, fraud invalidation, silence expiry) flips its assignment to `expired`, freeing the campaign for re-offer. Only `completed` assignments count toward `per_user_cap`.
- **Reasoning:** punishing a failed watch with a permanent lockout feels scammy and contradicts the "calm, clear credit" principle; the design mockup already promised a second chance without ledger changes, and this needs none (no credit was posted). Implemented in `abandonSession()` (`lib/verify.ts`).

### 28. Admin console: desktop-first, responsive — payout approval works on phones
- **Decision:** desktop-first tables that collapse to card lists under 720px; approve/reject are full-width reachable buttons on mobile. No separate mobile admin app.
- **Reasoning:** payout approval is the time-critical admin action and admins may need it on the go; the queue is a short list, not a dense dashboard, so responsive collapse is enough at MVP. Revisit if the queue grows past ~50/day.

### 29. Local runtime: Node adapter (node:sqlite + fs R2 shim), not miniflare
- **Decision:** the Worker code is written Cloudflare-portable (no Node APIs in `src/`, `wrangler.toml` + D1/R2 production bindings ship), but local dev runs under `@hono/node-server` with `node:sqlite` and a filesystem R2 shim. No Cloudflare account, no spend, `npm run dev` just works.
- **Reasoning:** miniflare/D1-local would also work but adds wrangler as a heavy dependency and still needs the same shims for R2/SMTP; the Node adapter is one small file, starts in seconds, and the D1 SQL stays portable (no `RETURNING`, positional binds). Deviation recorded; the Workers entrypoint (`src/workers.ts`) is the deploy path.

### 30. Ledger: per-account normal side (debit-normal mock-funding receivable)
- **Decision:** `ledger_accounts.normal_side` (`credit` default, `debit` for `clearing:mock-funding`); deltas are signed by normal side, non-negativity enforced on the normal balance.
- **Reasoning:** mock advertiser top-ups are outside money entering the system. Booking them as debit-receivable/credit-wallet keeps double-entry clean with no negative balances, and the receivable balance visibly shows how much "demo money" is outstanding. No behavior change for user/campaign/clearing accounts.

### 31. Frontend: build-free static HTML/JS instead of Vite+React
- **Decision:** the three surfaces (`/app`, `/advertise`, `/admin`) ship as static HTML + vanilla JS served from `apps/web/public/` (Pages-compatible as-is, no build step).
- **Reasoning:** zero-build keeps the local loop instant and the PWA JS far under the 300 KB budget; the design system (DESIGN.md) is component CSS, not framework-dependent. A Vite build can be reintroduced if bundle-splitting becomes necessary; the API contract is unchanged.

### 32. payouts.amount_cents table CHECK relaxed to > 0 (migration 0003)
- **Decision:** the `>= 100` CHECK from the deepdive schema is relaxed to `> 0`; the $1.00 minimum is enforced in app code via the tunable `config.min_payout_cents`.
- **Reasoning:** the deepdive also says the min is config-tunable ("min $1.00, enforced in schema" + admin config editor). A hardcoded table CHECK made the config a lie — QA/E2E can't exercise payouts below $1.00 without it. The product rule is unchanged ($1.00 default); only the enforcement layer moved.

### 33. Completion race: guarded flip; tiny crash window documented
- **Decision:** `completeSession` posts the idempotent ledger group first, then a guarded `UPDATE … WHERE status='active'` flip; only the flip winner applies campaign spend/assignment/daily aggregates. Concurrent completes all return the same receipt; spend is applied exactly once.
- **Known edge:** a process crash between the flip and the spend batch would under-count `campaigns.spent_cents` by one view (pacing drift only — the ledger, the source of truth for money, is always correct). Accepted: the window is a single statement boundary in one process.

### 34. Advertisers cannot watch their own campaigns (QA finding 5 — coordinator close-out)
- **Decision:** `nextOffer` excludes campaigns where `c.advertiser_id = user.id`.
- **Reasoning:** self-watch moves own escrow to self minus the platform spread — no direct theft, but it inflates the view/completion stats advertisers pay for. One-line exclusion; no legitimate use case for self-watch.

### 35. Device fingerprint required at claim time (QA finding 6 — coordinator close-out)
- **Decision:** `POST /assignments/:id/claim` rejects requests without `x-device-fp` (403 `device_required`, low-severity signal recorded). Signup stays fingerprint-optional for UX.
- **Reasoning:** the 1:1 device gate never fired when clients simply omitted the fingerprint — "optional" made the control trivially bypassable rather than merely circumventable. The PWA always sends the header; only raw API clients are affected, which is the point. A forged fingerprint is still possible (client-asserted), so this is defense-in-depth alongside velocity caps and manual payout review, not a complete fix.

### 36. Upload size verified at confirm; media probing stays human-gated (QA finding 4 — coordinator close-out, partial)
- **Decision:** `POST /videos/:id/confirm` now rejects when stored bytes ≠ declared `size_bytes` (422 `size_mismatch`), closing the storage-abuse vector (lying about size to bypass `max_upload_bytes`). Duration/container/dimension claims remain client-asserted.
- **Reasoning:** size is verifiable portably via R2 `head()` (real R2 and the local fs shim both support it). True media probing (ffprobe) cannot run in Cloudflare Workers, so there is no portable technical control for duration validity — the human admin review (every video is `in_review` before it goes live) remains the gate at gate-0/1 scale. Revisit with an async probe worker (e.g. a container/VM job) before gate 2.
