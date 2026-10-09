# KudiWatch — UX Copy Deck

Every user-facing string that matters, in one place so the implementer copies instead of inventing. Tone: plain, warm, exact. Grade-6 reading level. Numbers as digits. No hype.

**Banned words/phrases** (scam markers — never use): "guaranteed", "get rich", "instant cash", "limited offer", "act now", "100% free money", "double your", "risk-free", "withdraw instantly" (payouts are manual — saying instant would be a lie).

---

## Global

- Mock-mode banner (every money screen, mock builds): **"Mock mode — no real money moves in this build. Payouts are simulated end-to-end."**
- Offline banner: **"You're offline. Your progress is saved on this phone and will send when you're back."**
- Generic error: **"Something went wrong. Your money is safe — nothing was lost."** + [Try again]. Request ID in tiny mono: `Ref: 8f3a…`
- Empty action: **"Check again"** (not "Refresh feed").

## Signup (`/app/signup`)

- Step 1 headline: **"Enter your phone number"**
- Sub: **"We use your phone number to keep things fair — one person, one account. We never sell your number, and we never share it with advertisers."**
- Button: **"Send code"**
- Code sent: **"We sent a 6-digit code to +234 801 234 5678. It expires in 10 minutes."**
- Step 2 headline: **"Enter your code"**
- Wrong code: **"That code didn't match. 4 tries left."** (count down; at 0: "Too many tries. Wait 1 hour, then request a new code.")
- Resend cooldown: **"Resend code in 0:42"** → **"Resend code"**
- Demo builds only: **"Demo build — your code is 482916. Real builds send it by SMS."**
- Step 3 headline: **"Tell us about you"**
- Name field label: **"What should we call you?"** placeholder: "e.g. Adaeze"
- Country label: **"Country"** (select)
- Language: **"Language — English for now. More languages are coming."** (disabled select)
- Consent line: **"By creating an account you agree to watch videos honestly — one account per person, no tricks. Accounts that cheat are removed."**
- Button: **"Create account"**
- Done: **"Welcome, Adaeze. Here's how earning works:"** → 3 bullets:
  1. **"Pick a video and watch it all the way through."**
  2. **"Answer a quick check to prove you watched."**
  3. **"Get paid — $0.01 to $0.03 per video, straight to your balance."**
- Then: **"No fees to join. Watching is always free. We will never ask for your bank password."**

## Queue (`/app`)

- Greeting: **"Videos for you"**
- Honesty strip: **"Watch a video fully to earn. Skipped or half-watched videos pay nothing."**
- Pay pill: **"+$0.02"** with sr-label "Pays 2 cents per completed watch"
- Card button: **"Watch"** / in-progress: **"Resume — paused at 41%. Keep watching to reach 90%."** / done: **"✓ $0.02 earned"**
- Skip: **"Skip"** → sheet: **"Skip this video?"** / "Skipped videos can come back after 24 hours. You won't earn for this one." / [Keep watching] [Skip video]
- Daily meter: **"6 of 50 videos today"** sub: "Daily limit keeps earning fair for everyone."
- Empty: **"No videos right now."** / "New videos appear when advertisers launch campaigns in Nigeria. Check back soon." / [Check again]

## Player (`/app/watch/:sid`)

- Under-player title block: video title, **"Paid ad by {advertiser}"** (always labeled as an ad — honesty), **"Earn $0.02 when you finish"**
- Requirement checklist (live):
  - **"✓ Watched 90% of the video"** / **"○ Watch 90% of the video"**
  - **"✓ Attention check passed"** / **"○ Attention check — coming up"**
  - **"✓ This tab stayed visible"** / **"○ Keep this tab visible"**
- Speed lock badge: **"1× — speed locked"**, tooltip: "Faster playback doesn't count. Everyone watches at normal speed."
- Tab hidden overlay: **"Paused — this tab is hidden"** / "Watching doesn't count while the tab is hidden. Come back to keep earning." / [Resume watching]
- Attention modal (tap): **"Quick check — are you still watching?"** / [I'm watching] + "Answer within 15 seconds to keep earning."
- Attention modal (quiz): **"Quick question about the video"** + question + 4 options + [Answer]
- Check passed toast: **"Checked — keep watching."**
- Check failed: **"This watch didn't count."** / "The attention check wasn't answered in time. No money was added — that's the rule for everyone." / [Back to videos]
- Completion: **"+$0.02 added to your balance"** / "Attention score: 100% · Watched: 94%" / [View receipt] [Next video]
- Heartbeat/debug (demo only): **"Session details (demo)"**

## Earnings (`/app/earnings`)

- Hero: **"Available balance"** + **"$4.86"** (sr: "4 dollars 86 cents")
- Sub: **"$0.50 waiting in payout review"**
- CTA: **"Request payout"** + tiny "Minimum $1.00"
- Stats: **"142 videos watched"** · **"$7.36 earned all time"** · **"98% attention"**
- History heading: **"Earnings history"**
- Receipt row sub: **"Watched 94% · Attention 100% · 2/2 checks"**
- Receipt detail labels: Session, Campaign, Finished, Device, Country, Attention checks
- Empty: **"No earnings yet."** / "Watch a video all the way through to earn your first cents." / [Find videos]

## Payout (`/app/payout`)

- Headline: **"Get your money"**
- Amount label: **"How much? (minimum $1.00)"**
- Below minimum: **"Minimum payout is $1.00. You're at $0.84 — $0.16 to go."** (exact remaining — motivating and honest)
- Above balance: **"That's more than your $4.86 balance."**
- Method heading: **"How should we send it?"**
- Method rows:
  - **M-Pesa** — "Fee 1.5% · Arrives in ~5 minutes"
  - **Bank transfer** — "Fee $0.30 · Arrives in ~1 day"
  - **Airtime** — "No fee · Arrives in ~5 minutes"
  - **USDT** — "Network fee $1.00 · Arrives in ~10 minutes"
- Fee note: **"Fees are estimates for this demo. Real fees will be shown before you confirm."**
- You'll receive: **"You'll receive $2.46"**
- Destination labels: "M-Pesa phone number" / "Account number" + "Bank" / "Phone number for airtime" / "USDT wallet address" + "Network"
- Confirm sheet: **"Confirm payout"** + rows (Amount, Fee, You'll receive, To) + **"A person reviews every payout before money moves. This usually takes under 24 hours."** + [Confirm payout]
- Requested: **"Payout requested."** / "It's under review now. Nothing moves until a person approves it — we'll update you here." / [Track payout]
- Tracker steps: **Under review → Approved → Sending → Paid**
- Step sub-copy (under review): "A reviewer checks every payout. This usually takes under 24 hours."
- History: **"Past payouts"**; failed: **"Failed — $2.50 returned to your balance."** + reason.

## Advertiser (`/advertise`)

- Welcome: **"Pay for real human attention."**
- Sub: **"Upload your video. Watchers watch it fully — verified second by second — and you get proof of every view."**
- Wallet: **"Balance $250.00"** + [Add funds] — top-up: **"Add $50 (demo money — no real charge)"**
- Create campaign steps: **"1. Video"** / **"2. Budget & pay"** / **"3. Who sees it"** / **"4. Review & launch"**
- Price slider: **"Watcher earns per view"** $0.01–$0.03; explainer: **"You pay $0.04 per completed view. The watcher gets $0.02. KudiWatch keeps $0.02."** (spread shown openly — trust)
- Budget: **"Campaign budget"** + "Only completed, verified views spend your budget."
- Targeting: **"Countries"**, **"Devices"**, **"Daily limit"** ("Spreads your budget through the day"), **"Views per person"** ("1 means every view is a new person")
- Upload constraints: **"MP4 or WebM · 15–180 seconds · up to 200 MB"**
- Video states: **"In review"** ("A person checks every video before it goes live."), **"Approved"**, **"Rejected — {reason}"**
- Report headline: **"Proof of attention"**; metrics: Views, Completion rate, Avg attention, Spent
- Receipts: **"Every view, receipted."** + [Export CSV]

## Admin (`/admin`)

- Payout queue row: amount, method, masked destination **"+254 7•• ••• 210"**, **"Account 12 days old · 34 completions/day · 0 signals"**
- Approve: **"Approve $2.50"** / Reject: **"Reject…"** + note field: **"Reason (the watcher will see this)"**
- Reject confirm: **"Reject payout — $2.50 returns to the watcher."**
- Re-auth notice: **"Your session is older than 12 hours. Re-verify to decide payouts."** + [Send me a code]
- Video review: **"Approve"** / **"Reject…"** + "Reason (the advertiser will see this)"
- Account actions: **Warn** ("The user sees a warning."), **Suspend** ("Blocks watching and payouts immediately."), **Ban** ("Permanent. Use for fraud.")
- Config: **"Changes apply immediately — no redeploy."**
- Audit log: **"Every admin action is recorded here, permanently."**

## Session/account states (user-facing wording)

| Backend state | User sees |
|---|---|
| `watch_sessions.failed` (attention) | "This watch didn't count." + reason |
| `watch_sessions.expired` | "This session expired. Start the video again." |
| `assignments.skipped` | "Skipped — it can return after 24 hours." |
| `users.suspended` | "Your account is paused while we review it. Payouts are on hold — your balance is safe." |
| `users.banned` | "This account was closed for breaking the fair-watch rules." |
| payout `rejected` | "Declined: {reason}. The $X.XX is back in your balance." |
| payout `failed` | "Sending failed ({reason}). The $X.XX is back in your balance." |
