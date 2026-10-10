import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, money } from '../../lib/api';
import { BusyButton, MockBanner, OfflineBar, TopBar, useRequireAuth, useShowError, useToast } from '../../components/ui';

export const Route = createFileRoute('/advertise/')({
  component: AdvertisePage,
});

interface AdvVideo {
  id: string;
  youtube_video_id: string | null;
  youtube_title: string | null;
  youtube_author: string | null;
  duration_s: number;
  status: string;
  rejection_reason?: string;
  advertiser?: string;
  advertiser_video_count?: number;
}

interface Campaign {
  id: string;
  title: string;
  status: string;
  budget_cents: number;
  spent_cents: number;
  reserved_cents: number;
  views?: number;
  completions?: number;
  advertiser?: string;
}

function AdvertisePage() {
  const toast = useToast();
  const showError = useShowError();
  const { me, error } = useRequireAuth();
  const [isAdvertiser, setIsAdvertiser] = useState<boolean | null>(null);
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [becoming, setBecoming] = useState(false);
  const [balance, setBalance] = useState(0);
  const [videos, setVideos] = useState<AdvVideo[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [subStatus, setSubStatus] = useState<{ kind: 'info' | 'err'; msg: string } | null>(null);
  const [campFormOpen, setCampFormOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [report, setReport] = useState<React.ReactNode>(null);

  // campaign form state
  const [cfVideo, setCfVideo] = useState('');
  const [cfTitle, setCfTitle] = useState('');
  const [cfPrice, setCfPrice] = useState(2);
  const [cfCpc, setCfCpc] = useState(4);
  const [cfBudget, setCfBudget] = useState('10.00');
  const [cfCountries, setCfCountries] = useState('NG,KE');
  const [cfDaily, setCfDaily] = useState(100);
  const [cfPerUser, setCfPerUser] = useState(1);
  // upload quiz state
  const [q, setQ] = useState('');
  const [choices, setChoices] = useState(['', '', '', '']);
  const [qAnswer, setQAnswer] = useState(0);
  const [ytUrl, setYtUrl] = useState('');

  useEffect(() => {
    if (!me) return;
    setIsAdvertiser(me.user.roles.includes('advertiser'));
  }, [me]);

  const refreshBalance = async () => {
    try {
      const w = await api<{ balance_cents: number }>('GET', '/v1/advertiser/wallet');
      setBalance(w.balance_cents);
    } catch (e: any) {
      showError(e?.message || 'Could not load balance.', e?.requestId);
    }
  };
  const loadVideos = async () => {
    try {
      const data = await api<{ videos: AdvVideo[] }>('GET', '/v1/advertiser/videos');
      setVideos(data.videos || []);
      const approved = (data.videos || []).filter((v) => v.status === 'approved');
      if (approved.length && !cfVideo) setCfVideo(approved[0]!.id);
    } catch (e: any) {
      showError(e?.message || 'Could not load videos.', e?.requestId);
    }
  };
  const loadCampaigns = async () => {
    try {
      const data = await api<{ campaigns: Campaign[] }>('GET', '/v1/advertiser/campaigns');
      setCampaigns(data.campaigns || []);
    } catch (e: any) {
      showError(e?.message || 'Could not load campaigns.', e?.requestId);
    }
  };

  useEffect(() => {
    if (isAdvertiser) {
      refreshBalance();
      loadVideos();
      loadCampaigns();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdvertiser]);

  if (error) {
    return (
      <div className="wrap wide">
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!me || isAdvertiser === null) {
    return (
      <div className="wrap wide">
        <p className="small">Loading…</p>
      </div>
    );
  }

  const become = async () => {
    setBecoming(true);
    try {
      await api('POST', '/v1/advertiser/profile', {
        company_name: company,
        contact_email: email || undefined,
      });
      window.location.reload();
    } catch (e: any) {
      showError(e?.message || 'Could not create profile.', e?.requestId);
    }
    setBecoming(false);
  };

  const topup = async () => {
    const amt = window.prompt('Add funds (USD, demo money — no real charge):', '50.00');
    if (!amt) return;
    const cents = Math.round(Number(amt) * 100);
    if (!cents || cents < 100) {
      toast('Enter at least $1.00.', 'warn');
      return;
    }
    try {
      await api('POST', '/v1/advertiser/wallet/topup', { amount_cents: cents, method: 'mock_card' });
      toast(`Added ${money(cents)} (demo money).`);
      refreshBalance();
    } catch (e: any) {
      showError(e?.message || 'Topup failed.', e?.requestId);
    }
  };

  const submitVideo = async () => {
    const url = ytUrl.trim();
    if (!url) {
      toast('Paste a YouTube link first.', 'warn');
      return;
    }
    setSubmitting(true);
    setSubStatus(null);
    try {
      const qq = q.trim();
      const quiz = qq && choices.every(Boolean) ? { q: qq, choices, answer_idx: qAnswer } : null;
      const res = await api<{ title: string; author: string }>('POST', '/v1/advertiser/videos/submit', {
        youtube_url: url,
        quiz,
      });
      setSubStatus({ kind: 'info', msg: `“${res.title}” submitted — a person checks every video before it goes live.` });
      setYtUrl('');
      setQ('');
      setChoices(['', '', '', '']);
      loadVideos();
    } catch (e: any) {
      setSubStatus({ kind: 'err', msg: e?.message || 'Submission failed.' });
    }
    setSubmitting(false);
  };

  const launch = async () => {
    setLaunching(true);
    try {
      await api('POST', '/v1/advertiser/campaigns', {
        video_id: cfVideo,
        title: cfTitle.trim(),
        price_per_view_cents: cfPrice,
        advertiser_cpc_cents: cfCpc,
        budget_cents: Math.round(Number(cfBudget) * 100),
        targeting: {
          countries: cfCountries.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
          device: 'any',
          languages: [],
        },
        daily_cap: cfDaily,
        per_user_cap: cfPerUser,
      });
      toast('Campaign is live — budget escrowed.');
      setCampFormOpen(false);
      refreshBalance();
      loadCampaigns();
    } catch (e: any) {
      showError(e?.message || 'Could not launch.', e?.requestId);
    }
    setLaunching(false);
  };

  const setStatus = async (id: string, status: string) => {
    try {
      await api('PATCH', `/v1/advertiser/campaigns/${id}`, { status });
      loadCampaigns();
      refreshBalance();
    } catch (e: any) {
      showError(e?.message || 'Could not update.', e?.requestId);
    }
  };

  const showReport = async (id: string) => {
    try {
      const r = await api<{ campaign: any; views: number; completions: number; completion_rate_pct: number; avg_attention_pct: number | null }>(
        'GET',
        `/v1/advertiser/campaigns/${id}/report`,
      );
      const rc = await api<{ receipts: any[] }>('GET', `/v1/advertiser/campaigns/${id}/receipts?limit=25`);
      setReport(
        <div className="card">
          <h3>Proof of attention — {r.campaign.title}</h3>
          <div className="between"><span>Views</span><strong>{r.views}</strong></div>
          <div className="between"><span>Completions</span><strong>{r.completions}</strong></div>
          <div className="between"><span>Completion rate</span><strong>{r.completion_rate_pct}%</strong></div>
          <div className="between"><span>Avg attention</span><strong>{r.avg_attention_pct ?? '—'}{r.avg_attention_pct != null ? '%' : ''}</strong></div>
          <div className="between"><span>Spent</span><strong className="money">{money(r.campaign.spent_cents)}</strong></div>
          <h3>Every view, receipted.</h3>
          <table className="data responsive">
            <thead>
              <tr><th>Session</th><th>Watched</th><th>Attention</th><th>Checks</th><th>Country</th><th>Finished</th></tr>
            </thead>
            <tbody>
              {rc.receipts.map((x: any, i: number) => (
                <tr key={i}>
                  <td data-th="Session" className="mono">{String(x.session_id).slice(0, 8)}…</td>
                  <td data-th="Watched">{x.watched_pct}%</td>
                  <td data-th="Attention">{x.attention_score == null ? '—' : Math.round(x.attention_score * 100) + '%'}</td>
                  <td data-th="Checks">{x.checks_passed}/{x.checks_total}</td>
                  <td data-th="Country">{x.country || '—'}</td>
                  <td data-th="Finished">{x.completed_at ? new Date(x.completed_at * 1000).toLocaleString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <a className="btn secondary sm" href={`/v1/advertiser/campaigns/${id}/receipts?format=csv`} style={{ marginTop: 12 }}>
            Export CSV
          </a>
        </div>,
      );
      setTimeout(() => document.getElementById('kw-report')?.scrollIntoView(), 50);
    } catch (e: any) {
      showError(e?.message || 'Could not load report.', e?.requestId);
    }
  };

  return (
    <div className="wrap wide">
      <TopBar title="Advertise" home="/" />
      <MockBanner />
      <OfflineBar />
      <h1>Pay for real human attention.</h1>
      <p>Submit your YouTube video. Watchers watch it fully — verified second by second — and you get proof of every view. We sell verified attention, not view counts.</p>

      {!isAdvertiser && (
        <div className="card">
          <h2>Become an advertiser</h2>
          <label htmlFor="company">Company name</label>
          <input id="company" type="text" maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
          <label htmlFor="email">Contact email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <BusyButton className="btn primary" busy={becoming} busyLabel="Creating…" onClick={become}>
            Create advertiser profile
          </BusyButton>
        </div>
      )}

      {isAdvertiser && (
        <>
          <div className="card">
            <div className="between">
              <div>
                <p className="small" style={{ margin: 0 }}>Balance</p>
                <div className="money" style={{ fontSize: 24 }}>{money(balance)}</div>
              </div>
              <button className="btn secondary" onClick={topup}>Add funds</button>
            </div>
          </div>

          <h2>Videos</h2>
          <div className="card">
            <label htmlFor="yturl">YouTube video link</label>
            <input type="url" id="yturl" inputMode="url" placeholder="https://www.youtube.com/watch?v=…" value={ytUrl}
              onChange={(e) => setYtUrl(e.target.value)} style={{ minHeight: 44 }} />
            <p className="hint">Any public YouTube link — watch, share, Shorts, or embed URL. 15–180 seconds works best.</p>
            {subStatus && <div className={`banner ${subStatus.kind}`}>{subStatus.msg}</div>}
            <div>
              <h3>Attention quiz (optional)</h3>
              <p className="small">One multiple-choice question, asked after 70% watched. Wrong answers don&apos;t earn.</p>
              <label htmlFor="q">Question</label>
              <input id="q" type="text" maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} />
              {choices.map((c, i) => (
                <div key={i}>
                  <label htmlFor={`qc${i + 1}`}>Choice {i + 1}</label>
                  <input id={`qc${i + 1}`} type="text" maxLength={160} value={c}
                    onChange={(e) => setChoices((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))} />
                </div>
              ))}
              <label>Correct answer</label>
              <select value={qAnswer} onChange={(e) => setQAnswer(Number(e.target.value))}>
                {[0, 1, 2, 3].map((i) => (
                  <option key={i} value={i}>Choice {i + 1}</option>
                ))}
              </select>
            </div>
            <BusyButton className="btn primary" style={{ marginTop: 12 }} busy={submitting} busyLabel="Submitting…" onClick={submitVideo}>
              Submit video
            </BusyButton>
          </div>
          <div>
            {videos.length ? videos.map((v) => (
              <div className="card" key={v.id}>
                <div className="between">
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    {v.youtube_video_id && (
                      <img
                        src={`https://i.ytimg.com/vi/${v.youtube_video_id}/mqdefault.jpg`}
                        alt=""
                        width={120}
                        height={68}
                        loading="lazy"
                        style={{ borderRadius: 8, objectFit: 'cover' }}
                      />
                    )}
                    <div>
                      <strong>{v.youtube_title || v.youtube_video_id || v.id.slice(0, 8) + '…'}</strong>
                      <p className="small" style={{ margin: 0 }}>
                        {v.youtube_author ? `${v.youtube_author} · ` : ''}{v.duration_s > 0 ? `${Math.round(v.duration_s)}s · ` : ''}youtube.com/watch?v={v.youtube_video_id}
                      </p>
                    </div>
                  </div>
                  <span className={`chip ${v.status === 'approved' ? 'ok' : v.status === 'rejected' ? 'bad' : 'warn'}`}>
                    {v.status.replace('_', ' ').toUpperCase()}
                  </span>
                </div>
                {v.status === 'rejected' && v.rejection_reason && <p className="small">Rejected — {v.rejection_reason}</p>}
                {v.status === 'in_review' && <p className="small">A person checks every video before it goes live.</p>}
              </div>
            )) : <p className="small">No videos yet.</p>}
          </div>

          <h2>Campaigns</h2>
          <button className="btn secondary" onClick={() => setCampFormOpen((o) => !o)}>New campaign</button>
          {campFormOpen && (
            <div className="card">
              <h3>1. Video</h3>
              <select value={cfVideo} onChange={(e) => setCfVideo(e.target.value)}>
                {videos.filter((v) => v.status === 'approved').map((v) => (
                  <option key={v.id} value={v.id}>{(v.youtube_title || v.youtube_video_id || v.id).slice(0, 40)} · {Math.round(v.duration_s)}s</option>
                ))}
                {!videos.some((v) => v.status === 'approved') && <option value="">No approved videos yet</option>}
              </select>
              <h3>2. Budget &amp; pay</h3>
              <label htmlFor="cf-title">Campaign title</label>
              <input id="cf-title" type="text" maxLength={120} value={cfTitle} onChange={(e) => setCfTitle(e.target.value)} />
              <label htmlFor="cf-price">Watcher earns per view: <strong>${(cfPrice / 100).toFixed(2)}</strong></label>
              <input id="cf-price" type="range" min={1} max={3} value={cfPrice} style={{ minHeight: 44 }}
                onChange={(e) => setCfPrice(Number(e.target.value))} />
              <label htmlFor="cf-cpc">You pay per completed view (cents)</label>
              <input id="cf-cpc" type="number" value={cfCpc} min={1} max={100} onChange={(e) => setCfCpc(Number(e.target.value))} />
              <p className="hint">
                You pay ${(cfCpc / 100).toFixed(2)} per completed view. The watcher gets ${(cfPrice / 100).toFixed(2)}.
                KudiWatch keeps ${((cfCpc - cfPrice) / 100).toFixed(2)}.
              </p>
              <label htmlFor="cf-budget">Campaign budget (USD)</label>
              <input id="cf-budget" type="text" inputMode="decimal" value={cfBudget} onChange={(e) => setCfBudget(e.target.value)} />
              <h3>3. Who sees it</h3>
              <label htmlFor="cf-countries">Countries (comma-separated, e.g. NG,KE)</label>
              <input id="cf-countries" type="text" value={cfCountries} onChange={(e) => setCfCountries(e.target.value)} />
              <label htmlFor="cf-daily">Daily limit <span className="hint">— spreads your budget through the day</span></label>
              <input id="cf-daily" type="number" value={cfDaily} min={1} onChange={(e) => setCfDaily(Number(e.target.value))} />
              <label htmlFor="cf-peruser">Views per person <span className="hint">— 1 means every view is a new person</span></label>
              <input id="cf-peruser" type="number" value={cfPerUser} min={1} onChange={(e) => setCfPerUser(Number(e.target.value))} />
              <h3>4. Review &amp; launch</h3>
              <p className="small">Only completed, verified views spend your budget.</p>
              <BusyButton className="btn primary" busy={launching} busyLabel="Launching…" onClick={launch}>
                Launch campaign
              </BusyButton>
            </div>
          )}
          <div>
            {campaigns.length ? campaigns.map((c) => (
              <div className="card" key={c.id}>
                <div className="between">
                  <strong>{c.title}</strong>
                  <span className={`chip ${c.status === 'live' ? 'ok' : c.status === 'paused' ? 'info' : ''}`}>
                    {c.status.toUpperCase()}
                  </span>
                </div>
                <p className="small">Budget {money(c.budget_cents)} · Spent {money(c.spent_cents)} · Reserved {money(c.reserved_cents)}</p>
                <div className="progress">
                  <i style={{ width: `${c.budget_cents ? Math.min(100, (c.spent_cents / c.budget_cents) * 100) : 0}%` }} />
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  {c.status === 'live' && <button className="btn secondary sm" onClick={() => setStatus(c.id, 'paused')}>Pause</button>}
                  {c.status === 'paused' && <button className="btn secondary sm" onClick={() => setStatus(c.id, 'live')}>Resume</button>}
                  {['live', 'paused'].includes(c.status) && (
                    <button className="btn ghost sm" onClick={() => {
                      if (window.confirm('End this campaign? Unspent budget returns to your balance.')) setStatus(c.id, 'ended');
                    }}>End</button>
                  )}
                  <button className="btn ghost sm" onClick={() => showReport(c.id)}>Report</button>
                </div>
              </div>
            )) : <p className="small">No campaigns yet.</p>}
          </div>

          <h2>Proof of attention</h2>
          <div id="kw-report">{report}</div>
        </>
      )}
    </div>
  );
}
