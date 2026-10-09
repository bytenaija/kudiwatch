# KudiWatch — Design Decisions (deltas vs the deepdive)

Design choices that **extend** or (rarely) **contradict** `docs/DEEPDIVE.md`. The implementer reads this alongside the mockups; anything marked EXTENDS is new surface the deepdive implies but doesn't specify; anything marked CONTRADICTS needs founder sign-off before build.

## Extensions (deepdive-compatible, new surface specified here)

1. **Verified-segments progress bar.** The deepdive unions heartbeat intervals server-side (§5.3.6) and exposes `watched_pct`. The player renders the *verified segments themselves* (per-heartbeat blocks) instead of the raw playhead — the bar shows what counts, the playhead is a thin marker. Rationale: the #1 scam-app complaint is "the bar filled but I wasn't paid"; this makes the evidence visible. No API change required beyond what the deepdive already returns (or the client can reconstruct segments from its own accepted heartbeats).
2. **Requirement checklist under the player.** Live checklist: watched 90% / attention check / tab visible. The deepdive defines these as completion conditions (§5.5); the design surfaces them so the watcher always knows what's missing. No partial-credit change.
3. **Tab-hidden is a full overlay, not a toast.** Deepdive §5.1 pauses on `visibilitychange`; the design shows a full-stage overlay with explicit copy ("Watching doesn't count while the tab is hidden") instead of a transient toast, because a toast can be missed and the watcher would lose earning time silently.
4. **Demo-mode OTP shown on screen.** Deepdive §2 keeps the OTP readable only via the dev-only `_dev/last-otp` endpoint. The signup mockup shows the code in a labeled demo banner. **This is mockup-only UX** — the implementer must NOT ship on-screen codes in any build; use the dev endpoint. Flagged here so nobody copies the mockup literally.
5. **Skipped-card cooldown copy.** Deepdive §6/DECISIONS #23: skipped assignments re-offer after 24 h. The queue card shows "Skipped videos can return after 24 hours" — the deepdive never specifies user-facing copy for this; now it exists in COPY.md.
6. **Empty-queue reason honesty.** The deepdive's `feed/next` returns `{assignment:null, reason}` (§6); the empty state copy names the real reasons (no campaigns in your country yet, daily caps) rather than a generic "nothing here".
7. **Balance split: available vs in-review.** The wallet endpoint returns `balance_cents` and `pending_payout_cents` (§4); the earnings hero renders both ("$4.86 available", "$0.50 waiting in payout review") so held money is never mistaken for missing money.
8. **Payout fee quote pre-submit.** Deepdive §9 defines `quote()`; the payout screen renders fee + ETA per method and a live "You'll receive" line before submit. Copy explicitly says fees are estimates in demo.
9. **Admin decision sheet states consequences.** The deepdive logs decisions + notes (§11); the design requires the confirm button to state the money consequence ("Reject payout — $2.50 returns to the watcher") and labels the note field "the watcher will see this" so admins write human-readable reasons.
10. **Dark mode.** The deepdive doesn't mention it; the design ships dark-mode-safe token pairs (cheap Androids skew dark-mode). Zero backend impact.
11. **Receipt expand affordance.** The deepdive defines the receipt payload (§4 `GET /watch/:sid/receipt`); the design makes every earnings row expandable to the full receipt (session id, checks, device, country) — same data, trust surface.
12. **Attention modal countdown as ring + number.** Deepdive §5.4: 15 s timeout. The design renders a 15 s countdown ring with `aria-live` announcements and a numeric fallback under `prefers-reduced-motion`.
13. **Player keyboard map.** Deepdive is silent on keyboard; the design specifies Space/K, ←/→ (clamped to verified range), F, M — desktop reviewer/QA need this.
14. **No skeleton shimmer.** Loading states are static placeholders, not shimmer — shimmer reads as "fake loading" to scam-burned users. Minor, recorded for consistency.

## Contradictions (need founder sign-off)

**None at this time.** The design stays inside the deepdive's state machines, thresholds ($1.00 min, 90% completion, 10 s heartbeats, 15 s attention timeout, 1× lock, 24 h skip cooldown, 10/hr + 50/day caps, mock fees), role model, and copy constraints (English-only, no referrals, no gamification, mock-everything).

## Questions the deepdive doesn't answer (asked in DESIGN.md §12, repeated)

- Earnings display currency: USD-only at MVP, or dual USD + local estimate? (Design currently USD-only; mock FX now would teach wrong numbers.)
- Attention-check copy tone: neutral "Quick check — are you still watching?" vs brand-voice variant.
- Admin console: confirm desktop-first, or does payout approval need a mobile view?
