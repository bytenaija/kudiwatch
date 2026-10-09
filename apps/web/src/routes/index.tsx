import { createFileRoute, Link } from '@tanstack/react-router';
import { OfflineBar } from '../components/ui';

export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage() {
  return (
    <div className="wrap">
      <div className="topbar" style={{ position: 'static', border: 'none', padding: '16px 0' }}>
        <span className="brand">
          <span className="k">Kudi</span>Watch
        </span>
        <span className="spacer" />
        <Link to="/app/signup" className="btn secondary sm">
          Sign in
        </Link>
      </div>

      <h1>Get paid for your attention.</h1>
      <p>
        Brands upload short videos. You watch them all the way through — verified second by second — and earn $0.01
        to $0.03 per video. Every view comes with a receipt.
      </p>
      <Link to="/app/signup" className="btn primary">
        Start watching
      </Link>
      <p className="small">One person, one account — verified by phone number. No fees to join. Watching is always free.</p>

      <div className="card">
        <h3>How earning works</h3>
        <ol>
          <li>Pick a video and watch it all the way through.</li>
          <li>Answer a quick check to prove you watched.</li>
          <li>Get paid — straight to your balance.</li>
        </ol>
        <p className="small">Skipped or half-watched videos pay nothing. That&apos;s the rule for everyone.</p>
      </div>

      <div className="card">
        <h3>For advertisers</h3>
        <p>
          Pay for real human attention — not impressions, not bots. Every completed view is receipted: watch %,
          attention score, checks passed.
        </p>
        <Link to="/advertise" className="btn secondary">
          Advertise with KudiWatch
        </Link>
      </div>

      <div className="banner warn" role="note">
        <span>
          <strong>Demo build</strong> — mock mode. No real money moves here; payouts are simulated end-to-end.
        </span>
      </div>

      <p className="tiny">KudiWatch never asks for your bank password. &ldquo;Kudi&rdquo; means money in Hausa — earned honestly.</p>

      <OfflineBar />
    </div>
  );
}
