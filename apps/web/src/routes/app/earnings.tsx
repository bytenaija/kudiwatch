import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, money, moneyA11y, type WalletResponse } from '../../lib/api';
import { MockBanner, OfflineBar, TabBar, TopBar, useRequireAuth, useShowError } from '../../components/ui';

export const Route = createFileRoute('/app/earnings')({
  component: EarningsPage,
});

interface LedgerEntry {
  entry_type: string;
  side: string;
  memo: string;
  amount_cents: number;
  created_at: number;
  ref_id?: string;
}

interface Receipt {
  session_id: string;
  campaign?: { title: string; advertiser: string };
  completed_at: number | null;
  country: string | null;
  checks_passed: number;
  checks_total: number;
  watched_pct: number;
  attention_score: number;
}

function ReceiptDetail({ sid }: { sid: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!sid) {
      setFailed(true);
      return;
    }
    api<{ receipt: Receipt }>('GET', `/v1/watch/${sid}/receipt`)
      .then((r) => {
        if (alive) setReceipt(r.receipt);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [sid]);
  if (failed) return <p className="small">{sid ? 'Receipt unavailable.' : 'No receipt.'}</p>;
  if (!receipt) return <p className="small">Loading receipt…</p>;
  const rc = receipt;
  return (
    <>
      <dl>
        <dt>Session</dt>
        <dd className="mono">{rc.session_id}</dd>
        <dt>Campaign</dt>
        <dd>
          {rc.campaign?.title || ''} ({rc.campaign?.advertiser || ''})
        </dd>
        <dt>Finished</dt>
        <dd>{rc.completed_at ? new Date(rc.completed_at * 1000).toLocaleString() : '—'}</dd>
        <dt>Country</dt>
        <dd>{rc.country || '—'}</dd>
        <dt>Attention checks</dt>
        <dd>
          {rc.checks_passed}/{rc.checks_total} passed
        </dd>
      </dl>
      <p>
        <span className="chip ok">Watch {rc.watched_pct}%</span>{' '}
        <span className="chip ok">Attention {rc.attention_score}%</span>
      </p>
    </>
  );
}

function EarningsPage() {
  const showError = useShowError();
  const { me, error } = useRequireAuth();
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [earns, setEarns] = useState<LedgerEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!me) return;
    api<WalletResponse>('GET', '/v1/wallet')
      .then(setWallet)
      .catch((e: any) => showError(e?.message || 'Could not load wallet.', e?.requestId));
    api<{ entries: LedgerEntry[] }>('GET', '/v1/wallet/ledger?limit=50')
      .then((data) => {
        setEarns((data.entries || []).filter((e) => e.entry_type === 'EARN_CREDIT' && e.side === 'credit'));
        setLoaded(true);
      })
      .catch((e: any) => {
        showError(e?.message || 'Could not load history.', e?.requestId);
        setLoaded(true);
      });
  }, [me, showError]);

  if (error) {
    return (
      <div className="wrap">
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!me) {
    return (
      <div className="wrap">
        <p className="small">Loading…</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <TopBar title="Earnings" />
      <TabBar active="earnings" />
      <MockBanner />
      <OfflineBar />
      <h1>Earnings</h1>

      <div className="card">
        {wallet ? (
          <>
            <p className="small" style={{ margin: 0 }}>
              Available balance
            </p>
            <div className="money" style={{ fontSize: 28 }} aria-label={moneyA11y(wallet.balance_cents)}>
              {money(wallet.balance_cents)}
            </div>
            {wallet.pending_payout_cents ? (
              <p className="small">{money(wallet.pending_payout_cents)} waiting in payout review</p>
            ) : null}
            <div className="between" style={{ marginTop: 12 }}>
              <span className="small">
                <strong>{wallet.views_completed}</strong> videos watched
              </span>
              <span className="small">
                <strong>{money(wallet.lifetime_earned_cents)}</strong> earned all time
              </span>
              {wallet.avg_attention_pct != null && (
                <span className="small">
                  <strong>{wallet.avg_attention_pct}%</strong> attention
                </span>
              )}
            </div>
          </>
        ) : (
          <p className="small">Loading…</p>
        )}
      </div>

      <div className="row" style={{ margin: '16px 0' }}>
        <Link to="/app/payout" className="btn primary" style={{ flex: 1 }}>
          Request payout
        </Link>
      </div>
      <p className="tiny">Minimum $1.00</p>

      <h2>Earnings history</h2>
      {!loaded && <p className="small">Loading…</p>}
      {loaded && !earns.length && (
        <div className="empty">
          <h3>No earnings yet.</h3>
          <p>Watch a video all the way through to earn your first cents.</p>
          <Link to="/app" className="btn secondary">
            Find videos
          </Link>
        </div>
      )}
      {earns.map((e, i) => (
        <details className="receipt" key={`${e.ref_id || i}-${e.created_at}`}>
          <summary>
            <span style={{ flex: 1 }}>
              <strong>{e.memo || 'Video view'}</strong>
              <br />
              <span className="tiny">{new Date(e.created_at * 1000).toLocaleString()}</span>
            </span>
            <span className="money">+{money(e.amount_cents)}</span>
          </summary>
          <div className="detail">
            <ReceiptDetail sid={e.ref_id || ''} />
          </div>
        </details>
      ))}
    </div>
  );
}
