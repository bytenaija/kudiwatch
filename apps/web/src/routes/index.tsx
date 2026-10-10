import { createFileRoute, Link } from '@tanstack/react-router';
import { OfflineBar } from '../components/ui';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

/* Inline SVG icons — no external assets, no emoji. */
function Icon({ d, label }: { d: string; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined} aria-label={label}>
      <path d={d} />
    </svg>
  );
}
const I = {
  check: 'M20 6 9 17l-5-5',
  shield: 'M12 22s8-3.6 8-10V5l-8-3-8 3v7c0 6.4 8 10 8 10z',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M11 18h2',
  receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6',
  zap: 'M13 2 3 14h7l-1 8 10-12h-7z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  wallet: 'M20 7H5a2 2 0 0 1 0-4h14v4 M20 7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5 M18 14h.01',
  users: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  play: 'M8 5v14l11-7z',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
};

function LandingPage() {
  return (
    <div className="lp">
      {/* Demo banner — honest mock-mode notice, restyled for the new design */}
      <div className="lp-demo" role="note">
        <span className="lp-demo-dot" aria-hidden="true" />
        <span>
          <strong>Demo build — mock mode.</strong>&nbsp;No real money moves here; payouts are simulated end-to-end.
        </span>
      </div>

      {/* Sticky nav */}
      <header className="lp-nav">
        <div className="lp-nav-inner">
          <Link to="/" className="lp-brand" aria-label="KudiWatch home">
            <span className="lp-brand-k">Kudi</span>Watch
          </Link>
          <nav className="lp-nav-links" aria-label="Sections">
            <a href="#watchers">Watchers</a>
            <a href="#how">How it works</a>
            <a href="#advertisers">Advertisers</a>
            <a href="#faq">FAQ</a>
          </nav>
          <span className="lp-nav-spacer" />
          <Link to="/app/signup" className="lp-nav-signin">
            Sign in
          </Link>
          <Link to="/app/signup" className="lp-btn lp-btn-primary lp-btn-sm">
            Start earning
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-hero-inner">
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">Early access · Africa &amp; Asia</span>
            <h1 className="lp-h1">
              Get paid for <span className="lp-h1-accent">your attention.</span>
            </h1>
            <p className="lp-lede">
              Brands submit their YouTube videos. You watch them all the way through — verified
              second by second — and earn <strong>$0.01–$0.03 per video</strong>.
              Every view comes with a receipt.
            </p>
            <div className="lp-cta-row">
              <Link to="/app/signup" className="lp-btn lp-btn-primary lp-btn-lg">
                Start earning <Icon d={I.arrow} />
              </Link>
              <Link to="/advertise" className="lp-btn lp-btn-outline lp-btn-lg">
                Advertise
              </Link>
            </div>
            <p className="lp-hero-fine">
              Free to join · One account per person · Watching is always free
            </p>
          </div>

          {/* CSS phone mockup — the watch-to-earn flow, no external images */}
          <div className="lp-hero-visual" aria-hidden="true">
            <div className="lp-phone">
              <div className="lp-phone-notch" />
              <div className="lp-phone-screen">
                <div className="lp-mini-brand">
                  <span className="lp-brand-k">Kudi</span>Watch
                </div>
                <div className="lp-mini-player">
                  <div className="lp-mini-thumb">
                    <span className="lp-mini-play">
                      <Icon d={I.play} />
                    </span>
                  </div>
                  <div className="lp-mini-progress">
                    <i style={{ width: '100%' }} />
                  </div>
                  <div className="lp-mini-meta">
                    <span>Brand video · 0:45</span>
                    <span className="lp-mini-pct">100%</span>
                  </div>
                </div>
                <div className="lp-mini-check">
                  <Icon d={I.check} /> Attention check passed
                </div>
                <div className="lp-mini-earn">
                  <span className="lp-mini-earn-amt">+$0.02</span>
                  <span className="lp-mini-earn-label">earned</span>
                </div>
                <div className="lp-mini-balance">
                  <span>Balance</span>
                  <strong>$4.37</strong>
                </div>
              </div>
            </div>
            <div className="lp-receipt-card">
              <div className="lp-receipt-title">
                <Icon d={I.receipt} /> View receipt
              </div>
              <dl>
                <div><dt>Watched</dt><dd>100%</dd></div>
                <div><dt>Attention</dt><dd>96</dd></div>
                <div><dt>Checks</dt><dd>2 / 2</dd></div>
              </dl>
            </div>
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="lp-trust" aria-label="Why you can trust KudiWatch">
        <div className="lp-section-inner">
          <ul className="lp-trust-list">
            <li><Icon d={I.users} label="" /><span><strong>One account per person</strong>Verified by phone number</span></li>
            <li><Icon d={I.shield} label="" /><span><strong>Verified watches only</strong>Heartbeats + attention checks</span></li>
            <li><Icon d={I.zap} label="" /><span><strong>No fees to join</strong>Watching is always free</span></li>
            <li><Icon d={I.receipt} label="" /><span><strong>Every view receipted</strong>Watch %, score, checks passed</span></li>
          </ul>
        </div>
      </section>

      {/* How earning works */}
      <section className="lp-section" id="how">
        <div className="lp-section-inner">
          <span className="lp-eyebrow lp-eyebrow-dark" id="watchers">For watchers</span>
          <h2 className="lp-h2">How earning works</h2>
          <p className="lp-sub">Three steps. No tricks, no fine print.</p>
          <ol className="lp-steps">
            <li>
              <span className="lp-step-n">1</span>
              <div>
                <h3>Get assigned a video</h3>
                <p>Brands submit their YouTube videos. KudiWatch assigns them to you — pick one from your queue and press play.</p>
              </div>
            </li>
            <li>
              <span className="lp-step-n">2</span>
              <div>
                <h3>Watch it all the way through</h3>
                <p>Normal speed, tab visible. Quick attention checks along the way prove a human is watching — not a script.</p>
              </div>
            </li>
            <li>
              <span className="lp-step-n">3</span>
              <div>
                <h3>Get paid to your balance</h3>
                <p>$0.01–$0.03 per verified video, credited instantly with a receipt. Cash out from $1.00.</p>
              </div>
            </li>
          </ol>
          <div className="lp-rule" role="note">
            <Icon d={I.shield} />
            <p><strong>The honest rule:</strong> skipped or half-watched videos pay nothing. That's the rule for everyone — it's what keeps advertisers paying.</p>
          </div>
          <Link to="/app/signup" className="lp-btn lp-btn-primary lp-btn-lg">
            Start earning <Icon d={I.arrow} />
          </Link>
        </div>
      </section>

      {/* For advertisers */}
      <section className="lp-section lp-band" id="advertisers">
        <div className="lp-section-inner">
          <span className="lp-eyebrow lp-eyebrow-dark">For advertisers</span>
          <h2 className="lp-h2">Pay for verified human attention.</h2>
          <p className="lp-sub">Not impressions. Not bots. Not a view counter you can't audit.</p>
          <div className="lp-cards">
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.receipt} /></span>
              <h3>Per-view receipts</h3>
              <p>Every completed view is receipted: watch percentage, attention score, and checks passed. Export it all to CSV.</p>
            </div>
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.shield} /></span>
              <h3>Anti-fraud by design</h3>
              <p>Device fingerprinting, one account per person, velocity limits — and every video reviewed by a human before it goes live.</p>
            </div>
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.eye} /></span>
              <h3>Pay only for completions</h3>
              <p>Fund a campaign, set your targeting and caps. You pay for verified full watches — half-watches cost you nothing.</p>
            </div>
          </div>
          <Link to="/advertise" className="lp-btn lp-btn-primary lp-btn-lg">
            Advertise with KudiWatch <Icon d={I.arrow} />
          </Link>
        </div>
      </section>

      {/* Proof, not promises */}
      <section className="lp-section">
        <div className="lp-section-inner">
          <span className="lp-eyebrow lp-eyebrow-dark">Verification</span>
          <h2 className="lp-h2">Proof, not promises.</h2>
          <p className="lp-sub">This is the machinery that makes a KudiWatch view worth paying for.</p>
          <div className="lp-cards lp-cards-2">
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.zap} /></span>
              <h3>Heartbeat-verified sessions</h3>
              <p>Every watch streams signed heartbeats every 10 seconds — sequence-chained, so a forged "finished" can't exist.</p>
            </div>
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.eye} /></span>
              <h3>Attention checks</h3>
              <p>Random tap-to-confirm prompts and content quizzes mid-video. Backgrounded tabs and bots fail them.</p>
            </div>
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.phone} /></span>
              <h3>Device fingerprinting</h3>
              <p>One account per verified phone number, emulator detection, VPN and datacenter-IP screening, velocity caps.</p>
            </div>
            <div className="lp-card">
              <span className="lp-card-ic"><Icon d={I.users} /></span>
              <h3>Human review of every video</h3>
              <p>Every advertiser video is reviewed by a person before it reaches a single watcher. No spam, no scams.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Payouts */}
      <section className="lp-section lp-band">
        <div className="lp-section-inner">
          <span className="lp-eyebrow lp-eyebrow-dark">Payouts</span>
          <h2 className="lp-h2">Your money, your way.</h2>
          <p className="lp-sub">Cash out from <strong>$1.00</strong> — no minimums games, no locked balances.</p>
          <ul className="lp-payouts">
            <li><span className="lp-payout-ic"><Icon d={I.wallet} /></span><div><strong>M-Pesa &amp; mobile money</strong><span>Direct to your mobile wallet</span></div></li>
            <li><span className="lp-payout-ic"><Icon d={I.receipt} /></span><div><strong>Bank transfer</strong><span>Local bank payout</span></div></li>
            <li><span className="lp-payout-ic"><Icon d={I.phone} /></span><div><strong>Airtime</strong><span>Top up any phone</span></div></li>
            <li><span className="lp-payout-ic"><Icon d={I.zap} /></span><div><strong>USDT</strong><span>Crypto, on-chain</span></div></li>
          </ul>
          <p className="lp-fine">
            On this demo build, payouts are simulated — no real money moves. Payout methods may carry small
            processing fees, always shown before you confirm.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="lp-section" id="faq">
        <div className="lp-section-inner lp-faq-inner">
          <span className="lp-eyebrow lp-eyebrow-dark">FAQ</span>
          <h2 className="lp-h2">Questions, answered.</h2>
          <div className="lp-faq">
            <details>
              <summary>Is KudiWatch free?</summary>
              <p>Yes. Joining is free, watching is free, and there are no fees to join. Payout methods may carry small processing fees — always shown before you confirm a payout.</p>
            </details>
            <details>
              <summary>How much can I earn?</summary>
              <p>Each fully verified video pays $0.01–$0.03, credited to your balance instantly with a receipt. How much you earn overall depends on how many videos are available in your country — we don't promise totals, only that every verified watch pays.</p>
            </details>
            <details>
              <summary>How do payouts work?</summary>
              <p>Once your balance reaches $1.00, request a payout to M-Pesa/mobile money, bank transfer, airtime, or USDT. Requests are reviewed, then paid out. On this demo build, payouts are simulated end-to-end.</p>
            </details>
            <details>
              <summary>Why only one account per person?</summary>
              <p>It's the foundation of the whole system. Every account is verified by phone number, and multi-accounting, emulators, and VPNs get flagged. One person, one account keeps payouts fair and advertisers willing to pay.</p>
            </details>
            <details>
              <summary>What do advertisers get?</summary>
              <p>Verified human attention with proof: a per-view receipt showing watch percentage, attention score, and checks passed — exportable to CSV. Videos are human-reviewed before launch, and you only pay for verified completions. KudiWatch sells attention, not view counts — we promise nothing about YouTube metrics.</p>
            </details>
            <details>
              <summary>Where is KudiWatch available?</summary>
              <p>KudiWatch is in early access, launching across Africa and Asia. Video availability varies by country as advertisers come on board.</p>
            </details>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="lp-cta-band">
        <div className="lp-section-inner">
          <h2 className="lp-h2 lp-h2-light">Your attention is worth something.<br />Start getting paid for it.</h2>
          <div className="lp-cta-row">
            <Link to="/app/signup" className="lp-btn lp-btn-gold lp-btn-lg">
              Start earning <Icon d={I.arrow} />
            </Link>
            <Link to="/advertise" className="lp-btn lp-btn-outline-light lp-btn-lg">
              Advertise
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-section-inner">
          <div className="lp-footer-top">
            <Link to="/" className="lp-brand" aria-label="KudiWatch home">
              <span className="lp-brand-k">Kudi</span>Watch
            </Link>
            <nav className="lp-footer-links" aria-label="Footer">
              <a href="#watchers">Watchers</a>
              <a href="#how">How it works</a>
              <a href="#advertisers">Advertisers</a>
              <a href="#faq">FAQ</a>
            </nav>
          </div>
          <p className="lp-fine">
            &ldquo;Kudi&rdquo; means money in Hausa — earned honestly. KudiWatch never asks for your bank password.
          </p>
          <p className="lp-fine lp-copy">© 2026 KudiWatch · Demo build — mock mode, no real money moves.</p>
        </div>
      </footer>

      <OfflineBar />
    </div>
  );
}
