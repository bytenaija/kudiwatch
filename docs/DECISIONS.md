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
