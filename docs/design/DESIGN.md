# KudiWatch — Design System & Screen Specs

**Status:** design stage deliverable, 2026-10-08 · **Pairs with:** `docs/DEEPDIVE.md` (engineering contract), `docs/DECISIONS.md` (product decisions), `docs/design/COPY.md` (UX copy deck), `docs/design/DECISIONS-DESIGN.md` (design deltas vs the deepdive).
**Clickable mockups:** `docs/design/*.html` — open `index.html` in any browser, no network needed.

---

## 1. Design principles

1. **Trust is the UI.** This audience has been burned by scam earn-apps. Every screen answers "is this real?" before "what do I tap?" — exact balances, plain fees, honest states, no dark patterns, no inflated promises. When in doubt, show the receipt.
2. **Mobile-first, cheap-Android-first.** Designed at 360 px wide. Works on 3G, on small screens, with fat thumbs and shaky connections. Light DOM, minimal JS, system fonts, no frameworks in the PWA shell target.
3. **Nothing hidden about money.** Earnings are always labeled with *how* they were earned (video, watch %, attention score). Payouts always show fee, ETA, and current state name. Mock builds say they are mock builds — loudly, on the money screens.
4. **One thumb, one task.** Each screen does one thing. Primary action ≥ 48 px tall, full-width on phones. Destructive/irreversible actions (skip with cooldown, payout submit) get a confirm step.
5. **Boring on purpose.** No gamification confetti, no streaks, no loot-box energy (DECISIONS.md #19). The reward moment is a calm, clear credit — dignity, not dopamine.

---

## 2. Color

All colors are specified as light/dark token pairs. Dark mode follows `prefers-color-scheme`; both palettes are WCAG AA.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#0d1310` | Page background |
| `--surface` | `#f2f6f3` | `#151e19` | Cards on bg, wells, sheet bg |
| `--card` | `#ffffff` | `#182420` | Elevated cards (dark needs lift) |
| `--ink` | `#101814` | `#eaf3ed` | Primary text |
| `--ink-2` | `#33403a` | `#c4d4ca` | Secondary text (not on colored bg) |
| `--muted` | `#57665e` | `#9db3a7` | Tertiary text, placeholders |
| `--line` | `#dde6e0` | `#27352d` | Borders, dividers |
| `--primary` | `#0b6e4f` | `#43d18f` | Primary actions, earn amounts, links |
| `--primary-deep` | `#095c42` | `#43d18f` | Primary *text* on light (higher contrast) |
| `--on-primary` | `#ffffff` | `#06251a` | Text on primary buttons |
| `--gold` | `#8a5a00` | `#e8b93c` | Accent: badges, payout method icons, "credited" flash (never body text on light) |
| `--danger` | `#b3261e` | `#ff8a80` | Errors, destructive actions |
| `--danger-bg` | `#fdecea` | `#3a1714` | Error wells |
| `--warn-bg` | `#fff4d6` | `#33270a` | Mock-mode / caution banners |
| `--warn-ink` | `#6b4a00` | `#f2cd6b` | Text inside warn banners |
| `--info` | `#1d5fa8` | `#7fb3ef` | Informational accents |
| `--ok` | `#0b6e4f` | `#43d18f` | Success states |

**Measured contrast (light, normal text — target ≥ 4.5:1):**

| Pair | Ratio | Pass |
|---|---|---|
| `--ink` on `--bg` | 15.9:1 | ✅ |
| `--muted` on `--bg` | 6.1:1 | ✅ |
| `--primary` on `--bg` | 6.3:1 | ✅ |
| `--on-primary` on `--primary` | 6.3:1 | ✅ |
| `--gold` on `--bg` | 5.9:1 | ✅ (badges/labels only, not long text) |
| `--danger` on `--bg` | 6.5:1 | ✅ |
| `--warn-ink` on `--warn-bg` | 7.2:1 | ✅ |
| Dark: `--ink` on `--bg` | 14.8:1 | ✅ |
| Dark: `--primary` on `--bg` | 8.4:1 | ✅ |

UI components (borders, icons, focus rings, progress tracks): ≥ 3:1 against adjacent colors.

**Rules:**
- Money amounts always render in `--primary` with tabular numerals. Never red for earnings, never gold-on-white for sentences.
- The `--gold` accent is rationed: "credited" flash, payout method icons, the KudiWatch mark. Scarcity = it means something.
- Status chips have dedicated, non-color-only encodings (see §6.5) — state is never color alone.

---

## 3. Typography

System stack only — zero font downloads, instant render on any device:

```css
--font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
--mono: ui-monospace, SFMono-Regular, "Roboto Mono", Menlo, Consolas, monospace;
```

| Style | Size / weight / lh | Use |
|---|---|---|
| Display | 24 px / 700 / 1.25 | Screen titles, balance hero |
| H2 | 20 px / 700 / 1.3 | Section heads, card titles |
| H3 | 17 px / 600 / 1.35 | Row titles, modal titles |
| Body | 16 px / 400 / 1.5 | Default text — **never smaller for sentences** |
| Small | 14 px / 400 / 1.45 | Meta, captions, table cells |
| Tiny | 12 px / 500 / 1.4, uppercase optional | Eyebrows, badges, legal |
| Money | 16–28 px / 700, `font-variant-numeric: tabular-nums` | All amounts |

**Rules:** body text never below 16 px on the watcher PWA (cheap screens, older eyes). Amounts always tabular-nums so balances don't jitter. Receipt/session IDs in `--mono` 12–13 px. Sentence case everywhere (no ALL-CAPS shouting except 12 px eyebrows).

---

## 4. Spacing & layout

4 px base scale: `4 · 8 · 12 · 16 · 24 · 32 · 48`.

- **Baseline viewport: 360 × 640.** All watcher mockups are composed at 360 px first.
- Content column: `max-width: 400px`, 16 px side gutters, centered.
- Vertical rhythm: 16 px between blocks, 24 px between sections, 8 px inside rows.
- Cards: 12 px radius, 1 px `--line` border (no heavy shadows — cheap GPUs, and shadows look scammy-glossy). Dark mode: 1 px border + 4% white overlay.
- **Scales up:** ≥ 720 px → content column max 560 px (advertiser/admin get a two-column grid at ≥ 900 px: sidebar + content; tables replace card lists).
- **Scales down:** 320 px still works — gutters shrink to 12 px, tab bar labels stay ≥ 11 px.

---

## 5. Touch targets & input

- **Minimum 44 × 44 px** for every interactive element. Primary CTAs 52 px tall, full-width.
- Spacing between adjacent targets ≥ 8 px.
- Text inputs: 52 px tall, 16 px font (prevents iOS zoom), 12 px radius, 1.5 px border that goes `--primary` + 3 px focus ring on focus.
- OTP boxes: 6 × 52 px boxes, numeric keypad (`inputmode="numeric"`), auto-advance, paste support.
- No hover-dependent UI. No double-tap or long-press gestures in the PWA. Pull-to-refresh is fine; the refresh button must also exist.
- The video player's tap targets (play/pause, skip) are 48 px; the progress bar has a 24 px invisible touch extension above/below (seek is clamped server-side anyway — §7).

---

## 6. Component inventory

### 6.1 Buttons

| Variant | Style | Use |
|---|---|---|
| Primary | `--primary` fill, `--on-primary` text, 52 px | The one thing: Watch, Send code, Request payout, Approve |
| Secondary | `--surface` fill, `--ink` text, 1 px `--line` | Back, Cancel, Resend |
| Ghost / text | transparent, `--primary-deep` text, 44 px min | Skip video, View receipt, inline actions |
| Danger | `--danger` fill or `--danger` text on `--danger-bg` | Reject, Ban (always confirm first) |
| Loading | primary + spinner + disabled + `aria-busy` | Any async submit — **double-submit is a ledger bug, so buttons disable on first tap** |

Button labels are verbs: "Watch video", "Send code", "Request $2.50 payout" (amount in the label when known). Never "Submit" or "OK".

### 6.2 Status chips

Small pill, 12 px semibold, icon + text (never color alone):

| Chip | Light style | Meaning |
|---|---|---|
| `EARNED` / `COMPLETED` | green fill tint, check icon | Money credited |
| `UNDER REVIEW` | amber tint, clock icon | `pending_review` — a person will look |
| `SENDING` | blue tint, arrow icon | `processing` |
| `PAID` | green solid | `completed` |
| `FAILED` / `REJECTED` | red tint | terminal, with reason shown |
| `REFUNDED` | neutral tint, undo icon | money returned to balance |
| `LIVE` / `PAUSED` / `DRAFT` / `EXHAUSTED` | green/blue/gray/red tints | campaign states |
| `IN REVIEW` | amber tint | video moderation queue |

Every chip's text is the plain-English name; the exact backend state name appears in tiny mono beneath on detail screens (admin/audit) so support conversations match the DB.

### 6.3 Video cards (queue)

Thumbnail 16:9 (generated gradient + duration badge, no external images), title (H3), advertiser name (small, muted), pay pill (`+$0.02`, gold-tinted), state row:
- **Ready:** "Watch" primary button (52 px).
- **In progress:** progress bar + "Paused at 41% — keep watching to reach 90%" + "Resume".
- **Done:** "✓ $0.02 earned" + "Watch %: 94 · Attention: 100%".
- Ghost "Skip" per card with cooldown note ("Skipped videos return after 24 h").

### 6.4 Player chrome (the critical component)

- 16:9 stage, black. Own HTML5 `<video>` — never an embed (hard constraint).
- **Transport row (48 px targets):** play/pause toggle, time `0:34 / 1:20`, `1×` lock badge (lock icon + "1× — speed locked" tooltip), fullscreen.
- **Progress bar:** custom, `role="progressbar"`, `aria-valuemin/max/now` = verified-watched seconds, `aria-label="Verified watched progress"`. Renders **verified segments** (from heartbeat evidence), not the raw playhead — segments the server has confirmed fill in solid; the current playhead is a thin marker. Unwatched = track. This is the honesty surface: the bar shows what *counts*.
- **Requirement checklist** under the player (live): `✓ Watched 90%`, `○ Attention check — due soon`, `○ Keep this tab visible`. States update as the session progresses.
- **"Tab hidden — paused"**: full-stage overlay (not a toast): pause icon, "Paused — this tab is hidden", "Watching doesn't count while the tab is hidden. Come back to keep earning." Resume button.
- **Skip:** ghost button "Skip video" → confirm sheet ("Skipped videos can return after 24 hours. You won't earn for this one." [Keep watching] [Skip video]).
- **Completion:** stage overlay card — "+$0.02 added to your balance", attention score, "View receipt" ghost, "Next video" primary. No confetti; the gold flash on the amount is the celebration.
- Screen-reader labels: `aria-label="Play"`, `"Pause"`, `"Video progress: 34 of 80 seconds verified"`, live region announces attention checks and completion.

### 6.5 Attention-check modal

`role="dialog"`, `aria-modal="true"`, focus trapped, video paused behind it, 15 s countdown ring (with `aria-live` polite announcements at 5 s).

- **Tap variant:** "Are you still watching?" + big "I'm watching" primary button (52 px). Copy never tricks: one clear action.
- **Quiz variant:** advertiser's question, 4 radio options (48 px rows), "Answer" primary. Wrong = fail, stated plainly.
- **Timeout/fail state:** "This watch didn't count." + reason ("The attention check wasn't answered in time.") + "No money was added. You can try the next video." + primary "Back to videos". Never punitive language.

### 6.6 Payout method picker

Radio cards (min 64 px tall, full-width): icon, name, fee line, ETA line, selected = 2 px `--primary` border + check. Below: live "You'll receive" line (`amount − fee`, tabular nums) that updates as the amount changes. Destination field swaps per method (M-Pesa/airtime: phone; bank: account no. + bank; USDT: address + network select). All labeled, all with format hints.

### 6.7 Receipt rows (earnings history / advertiser receipts)

Row: thumbnail (40 px), title + date, right-aligned `+$0.02`, sub-row chips: `Watch 94%` `Attention 100%` `2/2 checks`. Expandable (`<details>`) → full receipt: session ID (mono), campaign, completed-at timestamp, device class, country, attention-check breakdown. This is the product's proof surface — advertisers see the same shape.

### 6.8 Payout status tracker

Vertical stepper, 4 steps: **Under review → Approved → Sending → Paid**. Current step highlighted; past steps checked; timestamps under each completed step. Failed/refunded/rejected render as a terminal notice card with reason + "amount returned to balance" where applicable. State names shown in tiny mono for support parity.

### 6.9 Banners

- **Mock-mode banner** (amber, on every money screen in mock builds): "Mock mode — no real money moves in this build. Payouts are simulated end-to-end." Dismissible per session, returns on reload. Never on a screen the user could mistake for real banking without it.
- **Offline banner** (neutral dark): "You're offline. New watches will wait — nothing is lost." + queued-action count. Queue states are first-class: pending heartbeats/claims show "Waiting for connection".
- **Error well** (red tint): what happened, what to do, retry button. No error codes at the user; `request_id` in tiny mono for support.

### 6.10 Empty states

Illustration = simple inline SVG (no emoji), headline, one honest sentence, one action:
- Queue dry: "No videos right now." / "New videos appear when advertisers launch campaigns in your country. Check back soon." / [Check again].
- Earnings: "No earnings yet." / "Watch a video all the way through to earn your first $0.02." / [Find videos].
- Payout history: "No payouts yet." / "When you request a payout it will be tracked here, step by step." 

### 6.11 Bottom tab bar (watcher PWA)

3 tabs, 56 px tall, icons + 11 px labels: **Videos · Earnings · Payout**. Active = `--primary` icon + label + 3 px top indicator. Badges: payout tab shows a dot when a payout changes state (cleared on view).

### 6.12 Sheets & dialogs

Bottom sheets for confirmations (skip video, payout confirm, destructive admin actions). Scrim 40% black, sheet slides ≤ 200 ms, drag handle, focus trapped, Esc/back-button closes. Destructive confirms require typing nothing — but the confirm button states the consequence ("Skip video — no earnings", "Reject payout — $2.50 returns to watcher").

---

## 7. Iconography

Inline SVG only, 24 px viewBox, 2 px stroke, round caps, `currentColor`. No emoji anywhere in product UI (mockups included). Set needed: play, pause, lock, check, check-circle, clock, alert-triangle, x, chevron-right/left/down, wallet, banknote/coins, phone, bank (building), zap (airtime), link/hex (USDT), eye, shield, upload, sliders (config), list/receipt, refresh, wifi-off, search, external, info, user, flag.

Icons always pair with text labels on first use; icon-only buttons get `aria-label` and a visible tooltip on long-press is not required.

---

## 8. Motion

- Budget: transitions ≤ 200 ms, `ease-out`. One property at a time.
- The "credited" moment: amount counts up (600 ms) + gold flash on the figure. That's the entire celebration budget.
- Progress bars animate width; verified segments pop in per heartbeat.
- **Respects `prefers-reduced-motion`**: all animation off, state changes are instant, countdown ring becomes a number.
- No parallax, no auto-playing carousels, no skeleton shimmer (use static placeholders — shimmer reads as "loading scam" on slow networks).

---

## 9. Accessibility

- Contrast: §2 table; verified pairs listed, not assumed.
- Focus: 3 px `--primary` outline offset 2 px on `:focus-visible`, always visible, never removed.
- Player: full keyboard operation (Space/K play-pause, ←/→ seek ±5 s within verified range, F fullscreen, M mute). All controls labeled; progressbar with `aria-valuenow`; attention modal traps focus and announces via `aria-live`.
- Touch: §5. Screen reader: decorative SVGs `aria-hidden`, amounts read as "2 dollars 50 cents" via `aria-label` on hero figures where ambiguous.
- Reduced motion: §8. Text scaling: layout survives 200% text size (no fixed-height text containers).
- Language: plain English, grade-6 reading level target (see COPY.md). Numbers always digits, never words, for amounts and thresholds.

---

## 10. Offline & low-bandwidth behavior

- App shell cached by service worker; video never cached (deepdive §1.2).
- Heartbeats queue in IndexedDB when offline and flush in order; the player shows "Reconnecting — your progress is saved on this phone" rather than failing the session.
- Images: thumbnails are tiny inline SVGs/gradients (no photo downloads on the queue screen). Video streams single-rendition MP4 with `preload="metadata"`.
- Every async action has three visual states: idle → working (disabled + spinner) → done/error. No silent failures.

---

## 11. Screen inventory & flows

| # | File | Route (planned) | Purpose / key states |
|---|---|---|---|
| 0 | `index.html` | — | Mockup hub for reviewers |
| 1 | `watcher-signup.html` | `/app/signup` | Phone → OTP (6-box) → profile; error + resend-cooldown states |
| 2 | `watcher-queue.html` | `/app` | Video list w/ pay pills + states; daily cap meter; empty state |
| 3 | `watcher-player.html` | `/app/watch/:sid` | Player chrome, verified-segments bar, tab-hidden overlay, attention modal (tap + quiz), completion, skip sheet |
| 4 | `watcher-earnings.html` | `/app/earnings` | Balance hero, lifetime stats, receipt rows (expandable) |
| 5 | `watcher-payout.html` | `/app/payout` | Mock banner, amount + $1.00 min, method picker, fee math, status tracker, history |
| 6 | `advertiser-dashboard.html` | `/advertise` | Campaign list, create-campaign wizard, funding, stats, per-view receipts table |
| 7 | `admin-console.html` | `/admin` | Payout queue, video review, flagged accounts, config, audit log |

**Watcher happy path:** signup → queue → (Watch) → player → attention check(s) → completion +$0.02 → earnings (receipt) → payout ($1.00 min) → tracker → paid.
**Advertiser path:** profile → top-up (mock) → upload video → in review → approved → create campaign (escrow) → live → receipts.
**Admin path:** video review → flagged accounts → payout queue (approve/reject + note) → config → audit log.

---

## 12. Open questions for the founder

1. **Earnings display currency:** ledger is USD cents; watchers think in NGN/KES. Mock FX at payout screen only, or dual-display (USD + local) on earnings? (Recommend: USD primary + local estimate in small text once real FX exists; mock FX now would teach wrong numbers.)
2. **Attention-check copy tone:** current copy is neutral-polite. Any objection to "Are you still watching?" — or prefer brand voice "Quick check — are you with us?"
3. **Failed-watch consolation:** currently no partial credit (DECISIONS.md #5) and the fail screen says so plainly. If beta feedback is harsh, the design supports a "second chance" re-watch button without ledger changes.
4. **Admin density:** the admin console mockup is desktop-first (tables). Confirm admins are desktop — or does payout approval need a mobile view for on-the-go review?
