import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { api, fmtTime, money, setClaim, type FeedResponse, type WalletResponse } from '../../lib/api';
import {
  BusyButton,
  MockBanner,
  OfflineBar,
  Sheet,
  TabBar,
  TopBar,
  useRequireAuth,
  useShowError,
} from '../../components/ui';

export const Route = createFileRoute('/app/')({
  component: VideosPage,
});

function VideosPage() {
  const navigate = useNavigate();
  const showError = useShowError();
  const { me, error } = useRequireAuth();
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [wallet, setWallet] = useState<WalletResponse | null>(null);
  const [skipFor, setSkipFor] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<FeedResponse>('GET', '/v1/feed/next');
      setFeed(data);
    } catch (e: any) {
      showError(e?.message || 'Could not load videos.', e?.requestId);
    }
    setLoading(false);
  }, [showError]);

  useEffect(() => {
    if (!me) return;
    load();
    api<WalletResponse>('GET', '/v1/wallet')
      .then(setWallet)
      .catch(() => {
        /* non-fatal */
      });
  }, [me, load]);

  const claim = async (assignmentId: string) => {
    setClaiming(true);
    try {
      const c = await api('POST', `/v1/assignments/${assignmentId}/claim`, {});
      setClaim(c as any);
      navigate({ to: '/app/watch', search: { sid: (c as any).session_id } });
    } catch (e: any) {
      showError(e?.message || 'Could not start.', e?.requestId);
    }
    setClaiming(false);
  };

  const skip = async () => {
    if (!skipFor) return;
    setSkipping(true);
    try {
      await api('POST', `/v1/assignments/${skipFor}/skip`, {});
      setSkipFor(null);
      load();
    } catch (e: any) {
      showError(e?.message || 'Could not skip.', e?.requestId);
    }
    setSkipping(false);
  };

  if (error) {
    return (
      <div className="wrap">
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!me) return <div className="wrap"><p className="small">Loading…</p></div>;

  const a = feed?.assignment;
  const v = feed?.video;
  const cp = feed?.campaign;

  return (
    <div className="wrap">
      <TopBar title="Videos for you" />
      <TabBar active="videos" />
      <MockBanner />
      <OfflineBar />
      <h1>Videos for you</h1>
      <p className="small">Watch a video fully to earn. Skipped or half-watched videos pay nothing.</p>

      {wallet && (
        <div className="card" style={{ marginTop: 0 }}>
          <div className="between">
            <strong>
              {wallet.views_today} of {wallet.max_views_per_day} videos today
            </strong>
            <span className="money">{money(wallet.balance_cents)}</span>
          </div>
          <p className="small" style={{ margin: '4px 0 0' }}>
            Daily limit keeps earning fair for everyone.
          </p>
        </div>
      )}

      {loading && <p className="small">Loading videos…</p>}

      {!loading && a && v && cp && (
        <div className="video-card">
          <div className="thumb" aria-hidden="true">
            <span>{cp.title}</span>
            <span className="dur">{fmtTime(v.duration_s)}</span>
          </div>
          <div className="body">
            <div className="between">
              <h3 style={{ margin: 0 }}>{cp.title}</h3>
              <span className="pay-pill" aria-label={`Pays ${cp.price_per_view_cents} cents per completed watch`}>
                +${(cp.price_per_view_cents / 100).toFixed(2)}
              </span>
            </div>
            <p className="small">
              Paid ad by {cp.advertiser} · offer expires in ~{Math.max(1, Math.ceil((a.claim_deadline - Date.now() / 1000) / 60))} min
            </p>
            <div className="row">
              <BusyButton className="btn primary" style={{ flex: 1 }} busy={claiming} busyLabel="Starting…" onClick={() => claim(a.id)}>
                Watch
              </BusyButton>
              <button className="btn ghost" onClick={() => setSkipFor(a.id)}>
                Skip
              </button>
            </div>
          </div>
        </div>
      )}

      {!loading && !a && (
        <div className="empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M10 9l5 3-5 3z" />
          </svg>
          <h3>No videos right now.</h3>
          <p>{feed?.message || 'Check back soon.'}</p>
          <button className="btn secondary" onClick={load}>
            Check again
          </button>
        </div>
      )}

      {skipFor && (
        <Sheet title="Skip this video?" onClose={() => setSkipFor(null)}>
          <p>Skipped videos can come back after 24 hours. You won&apos;t earn for this one.</p>
          <button className="btn secondary" style={{ width: '100%', marginBottom: 8 }} onClick={() => setSkipFor(null)}>
            Keep watching
          </button>
          <BusyButton className="btn danger" busy={skipping} busyLabel="Skipping…" onClick={skip}>
            Skip video — no earnings
          </BusyButton>
        </Sheet>
      )}
    </div>
  );
}
