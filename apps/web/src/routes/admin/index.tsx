import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ApiError, api, money } from '../../lib/api';
import { BusyButton, OfflineBar, Sheet, TopBar, useShowError, useToast } from '../../components/ui';

export const Route = createFileRoute('/admin/')({
  component: AdminPage,
});

type Tab = 'payouts' | 'videos' | 'accounts' | 'campaigns' | 'config' | 'audit';

function AdminPage() {
  const toast = useToast();
  const showError = useShowError();
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('payouts');
  const [reauth, setReauth] = useState(false);

  useEffect(() => {
    api<{ user: { roles: string[] } }>('GET', '/v1/me')
      .then((me) => setAllowed(me.user.roles.includes('admin')))
      .catch(() => navigate({ to: '/app/signup' }));
  }, [navigate]);

  const doReauth = async () => {
    await api('POST', '/v1/auth/logout', {});
    navigate({ to: '/app/signup', search: { admin: '1' } as any });
  };

  if (allowed === null) {
    return (
      <div className="wrap wide">
        <p className="small">Loading…</p>
      </div>
    );
  }

  return (
    <div className="wrap wide">
      <TopBar title="Admin" home="/" />
      <OfflineBar />
      <h1>Admin console</h1>
      {!allowed && <div className="banner err">This area needs the admin role.</div>}
      {allowed && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 16 }} role="tablist" aria-label="Admin sections">
            {(['payouts', 'videos', 'accounts', 'campaigns', 'config', 'audit'] as Tab[]).map((t) => (
              <button
                key={t}
                className={`btn secondary sm${tab === t ? ' primary' : ''}`}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
              >
                {t === 'payouts' ? 'Payout queue' : t === 'videos' ? 'Video review' : t === 'accounts' ? 'Flagged accounts' : t === 'campaigns' ? 'Campaigns' : t === 'config' ? 'Config' : 'Audit log'}
              </button>
            ))}
          </div>
          {reauth && (
            <div className="banner warn">
              <span>
                <strong>Session too old for payout decisions.</strong> For safety, sign in again, then retry.{' '}
                <button className="btn primary sm" onClick={doReauth}>
                  Sign in again
                </button>
              </span>
            </div>
          )}
          <div>
            {tab === 'payouts' && <PayoutsTab onReauth={() => setReauth(true)} />}
            {tab === 'videos' && <VideosTab />}
            {tab === 'accounts' && <AccountsTab />}
            {tab === 'campaigns' && <CampaignsTab />}
            {tab === 'config' && <ConfigTab />}
            {tab === 'audit' && <AuditTab />}
          </div>
        </>
      )}
    </div>
  );
}

function useAdminApi() {
  const showError = useShowError();
  return showError;
}

function PayoutsTab({ onReauth }: { onReauth: () => void }) {
  const showError = useAdminApi();
  const toast = useToast();
  const [payouts, setPayouts] = useState<any[]>([]);
  const [rejectFor, setRejectFor] = useState<{ id: string; amt: number } | null>(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);

  const load = async () => {
    try {
      const data = await api<{ payouts: any[] }>('GET', '/v1/admin/payouts/queue');
      setPayouts(data.payouts || []);
    } catch (e: any) {
      showError(e?.message || 'Could not load queue.', e?.requestId);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approve = async (id: string) => {
    try {
      await api('POST', `/v1/admin/payouts/${id}/decision`, { approve: true });
      toast('Approved — the mock adapter will send it on the next run.');
      load();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_required') return onReauth();
      showError(e?.message || 'Could not approve.', e?.requestId);
    }
  };

  const reject = async () => {
    if (!rejectFor) return;
    if (!note.trim()) {
      toast('Give a reason — the watcher will see it.', 'warn');
      return;
    }
    setWorking(true);
    try {
      await api('POST', `/v1/admin/payouts/${rejectFor.id}/decision`, { approve: false, note: note.trim() });
      setRejectFor(null);
      setNote('');
      load();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_required') {
        setRejectFor(null);
        return onReauth();
      }
      showError(e?.message || 'Could not reject.', e?.requestId);
    }
    setWorking(false);
  };

  if (!payouts.length) return <p className="small">Payout queue is empty.</p>;
  return (
    <>
      <table className="data responsive">
        <thead>
          <tr><th>Amount</th><th>Method</th><th>To</th><th>Account</th><th>Requested</th><th></th></tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.id}>
              <td data-th="Amount">
                <strong className="money">{money(p.amount_cents)}</strong>
                <br />
                <span className="tiny">fee {money(p.fee_cents)}</span>
              </td>
              <td data-th="Method">{p.method}</td>
              <td data-th="To" className="mono">{p.destination?.label || ''}</td>
              <td data-th="Account" className="small">
                Account {p.account_age_days} days old · {p.completions} completions · {p.high_signals} high signals
              </td>
              <td data-th="Requested" className="small">{new Date(p.created_at * 1000).toLocaleString()}</td>
              <td data-th="">
                <div className="row">
                  <button className="btn primary sm" onClick={() => approve(p.id)}>
                    Approve {money(p.amount_cents)}
                  </button>
                  <button className="btn ghost sm" onClick={() => setRejectFor({ id: p.id, amt: p.amount_cents })}>
                    Reject…
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rejectFor && (
        <Sheet title="Reject payout" onClose={() => setRejectFor(null)}>
          <p>Reject payout — {money(rejectFor.amt)} returns to the watcher.</p>
          <label htmlFor="sheet-note">Reason (the watcher will see this)</label>
          <input id="sheet-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <BusyButton className="btn danger" busy={working} busyLabel="Working…" onClick={reject}>
            Reject payout — {money(rejectFor.amt)} returns to the watcher
          </BusyButton>
          <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setRejectFor(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </>
  );
}

function VideosTab() {
  const showError = useAdminApi();
  const toast = useToast();
  const [videos, setVideos] = useState<any[]>([]);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);

  const load = async () => {
    try {
      const data = await api<{ videos: any[] }>('GET', '/v1/admin/videos/review-queue');
      setVideos(data.videos || []);
    } catch (e: any) {
      showError(e?.message || 'Could not load queue.', e?.requestId);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const review = async (id: string, approve: boolean, reason?: string) => {
    try {
      await api('POST', `/v1/admin/videos/${id}/review`, { approve, reason });
      toast(approve ? 'Video approved.' : 'Video rejected.');
      load();
    } catch (e: any) {
      showError(e?.message || 'Could not review.', e?.requestId);
    }
  };

  const reject = async () => {
    if (!rejectFor) return;
    if (!note.trim()) {
      toast('Give a reason — the advertiser will see it.', 'warn');
      return;
    }
    setWorking(true);
    await review(rejectFor, false, note.trim());
    setRejectFor(null);
    setNote('');
    setWorking(false);
  };

  if (!videos.length) return <p className="small">Review queue is empty.</p>;
  return (
    <>
      {videos.map((v) => (
        <div className="card" key={v.id}>
          <div className="between">
            <div>
              <strong className="mono">{v.id.slice(0, 8)}…</strong>
              <p className="small" style={{ margin: 0 }}>
                {v.advertiser || ''} · {v.duration_s}s · {(v.size_bytes / 1048576).toFixed(1)} MB · {v.advertiser_video_count} videos
              </p>
            </div>
            <span className="chip warn">IN REVIEW</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary sm" onClick={() => review(v.id, true)}>Approve</button>
            <button className="btn ghost sm" onClick={() => setRejectFor(v.id)}>Reject…</button>
          </div>
        </div>
      ))}
      {rejectFor && (
        <Sheet title="Reject video" onClose={() => setRejectFor(null)}>
          <p>Reason (the advertiser will see this)</p>
          <label htmlFor="sheet-note">Reason (the advertiser will see this)</label>
          <input id="sheet-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <BusyButton className="btn danger" busy={working} busyLabel="Working…" onClick={reject}>
            Reject video
          </BusyButton>
          <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setRejectFor(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </>
  );
}

function AccountsTab() {
  const showError = useAdminApi();
  const toast = useToast();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [flagFor, setFlagFor] = useState<{ id: string; action: string; label: string; danger: boolean; desc: string } | null>(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [signals, setSignals] = useState<any[] | null>(null);

  const load = async () => {
    try {
      const data = await api<{ accounts: any[] }>('GET', '/v1/admin/accounts/flagged');
      setAccounts(data.accounts || []);
    } catch (e: any) {
      showError(e?.message || 'Could not load accounts.', e?.requestId);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flag = async () => {
    if (!flagFor) return;
    if (!note.trim()) {
      toast('Give a reason.', 'warn');
      return;
    }
    setWorking(true);
    try {
      await api('POST', `/v1/admin/accounts/${flagFor.id}/flag`, { action: flagFor.action, reason: note.trim() });
      setFlagFor(null);
      setNote('');
      load();
    } catch (e: any) {
      showError(e?.message || 'Could not flag.', e?.requestId);
    }
    setWorking(false);
  };

  const clear = async (id: string) => {
    try {
      await api('POST', `/v1/admin/accounts/${id}/clear`, {});
      toast('Account cleared.');
      load();
    } catch (e: any) {
      showError(e?.message || 'Could not clear.', e?.requestId);
    }
  };

  const showSignals = async (id: string) => {
    try {
      const s = await api<{ signals: any[] }>('GET', `/v1/admin/accounts/${id}/signals`);
      setSignals(s.signals || []);
    } catch (e: any) {
      showError(e?.message || 'Could not load signals.', e?.requestId);
    }
  };

  const openFlag = (id: string, action: string, label: string, danger: boolean) => {
    const desc =
      action === 'warn'
        ? 'the user sees a warning.'
        : action === 'suspend'
          ? 'blocks watching and payouts immediately.'
          : 'permanent. Use for fraud.';
    setFlagFor({ id, action, label, danger, desc });
  };

  if (!accounts.length) return <p className="small">No flagged accounts.</p>;
  return (
    <>
      <table className="data responsive">
        <thead>
          <tr><th>Account</th><th>Status</th><th>Signals</th><th>Open flag</th><th></th></tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td data-th="Account">
                <strong>{a.display_name}</strong>
                <br />
                <span className="mono tiny">{a.phone_masked}</span>
                <br />
                <span className="tiny">{a.country_code}</span>
              </td>
              <td data-th="Status">
                <span className={`chip ${a.status === 'active' ? 'ok' : a.status === 'banned' ? 'bad' : 'warn'}`}>
                  {a.status.toUpperCase()}
                </span>
              </td>
              <td data-th="Signals">{a.signal_count} total · {a.high_signals} high</td>
              <td data-th="Open flag">{a.open_flag ? a.open_flag : '—'}</td>
              <td data-th="">
                <div className="row">
                  <button className="btn ghost sm" onClick={() => showSignals(a.id)}>Signals</button>
                  <button className="btn secondary sm" onClick={() => openFlag(a.id, 'warn', 'Warn account', false)}>Warn</button>
                  <button className="btn secondary sm" onClick={() => openFlag(a.id, 'suspend', 'Suspend account', true)}>Suspend</button>
                  <button className="btn danger sm" onClick={() => openFlag(a.id, 'ban', 'Ban account', true)}>Ban</button>
                  {a.open_flag && (
                    <button className="btn ghost sm" onClick={() => clear(a.id)}>Clear</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {flagFor && (
        <Sheet title={flagFor.label} onClose={() => setFlagFor(null)}>
          <p>{flagFor.label} — {flagFor.desc}</p>
          <label htmlFor="sheet-note">Reason</label>
          <input id="sheet-note" type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          <BusyButton className={`btn ${flagFor.danger ? 'danger' : 'primary'}`} busy={working} busyLabel="Working…" onClick={flag}>
            {flagFor.label}
          </BusyButton>
          <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setFlagFor(null)}>
            Cancel
          </button>
        </Sheet>
      )}
      {signals !== null && (
        <Sheet title="Fraud signals" onClose={() => setSignals(null)}>
          {signals.length ? (
            signals.map((x: any, i: number) => (
              <p key={i}>
                <span className={`chip ${x.severity === 'high' ? 'bad' : x.severity === 'medium' ? 'warn' : ''}`}>{x.severity}</span>{' '}
                <span className="mono">{x.signal_type}</span>
                <br />
                <span className="tiny">{new Date(x.created_at * 1000).toLocaleString()}</span>
              </p>
            ))
          ) : (
            <p className="small">None.</p>
          )}
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => setSignals(null)}>
            Close
          </button>
        </Sheet>
      )}
    </>
  );
}

function CampaignsTab() {
  const showError = useAdminApi();
  const [campaigns, setCampaigns] = useState<any[]>([]);
  useEffect(() => {
    api<{ campaigns: any[] }>('GET', '/v1/admin/campaigns')
      .then((d) => setCampaigns(d.campaigns || []))
      .catch((e: any) => showError(e?.message || 'Could not load campaigns.', e?.requestId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <table className="data responsive">
      <thead>
        <tr><th>Campaign</th><th>Advertiser</th><th>Status</th><th>Views</th><th>Completion</th><th>Spend</th></tr>
      </thead>
      <tbody>
        {campaigns.map((c) => {
          const cr = c.views ? Math.round((c.completions / c.views) * 100) : 0;
          const flag = cr > 90 && c.views >= 10;
          return (
            <tr key={c.id}>
              <td data-th="Campaign">
                <strong>{c.title}</strong>
                <br />
                <span className="tiny mono">{c.id.slice(0, 8)}…</span>
              </td>
              <td data-th="Advertiser">{c.advertiser || ''}</td>
              <td data-th="Status">
                <span className={`chip ${c.status === 'live' ? 'ok' : ''}`}>{c.status.toUpperCase()}</span>
              </td>
              <td data-th="Views">{c.views}</td>
              <td data-th="Completion">
                {cr}% {flag && <span className="chip warn">ABNORMAL</span>}
              </td>
              <td data-th="Spend" className="money">
                {money(c.spent_cents)} / {money(c.budget_cents)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ConfigTab() {
  const showError = useAdminApi();
  const toast = useToast();
  const [entries, setEntries] = useState<Array<[string, string]>>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    api<{ config: Record<string, string> }>('GET', '/v1/admin/config')
      .then((d) => {
        const e = Object.entries(d.config).sort(([a], [b]) => a.localeCompare(b));
        setEntries(e);
        setValues(Object.fromEntries(e));
      })
      .catch((e: any) => showError(e?.message || 'Could not load config.', e?.requestId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const set = async (k: string) => {
    try {
      await api('PUT', '/v1/admin/config', { key: k, value: values[k] });
      toast('Config updated.');
    } catch (e: any) {
      showError(e?.message || 'Could not update.', e?.requestId);
    }
  };
  return (
    <>
      <p className="small">Changes apply immediately — no redeploy.</p>
      <table className="data responsive">
        <thead>
          <tr><th>Key</th><th>Value</th><th></th></tr>
        </thead>
        <tbody>
          {entries.map(([k]) => (
            <tr key={k}>
              <td data-th="Key" className="mono">{k}</td>
              <td data-th="Value">
                <input
                  type="text"
                  value={values[k] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [k]: e.target.value }))}
                  style={{ margin: 0, minHeight: 44 }}
                />
              </td>
              <td data-th="">
                <button className="btn secondary sm" onClick={() => set(k)}>
                  Set
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AuditTab() {
  const showError = useAdminApi();
  const [entries, setEntries] = useState<any[]>([]);
  useEffect(() => {
    api<{ entries: any[] }>('GET', '/v1/admin/audit-log?limit=50')
      .then((d) => setEntries(d.entries || []))
      .catch((e: any) => showError(e?.message || 'Could not load audit log.', e?.requestId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <p className="small">Every admin action is recorded here, permanently.</p>
      {entries.length ? (
        entries.map((e: any, i: number) => (
          <div className="card" key={i}>
            <div className="between">
              <strong className="mono">{e.action}</strong>
              <span className="tiny">{new Date(e.created_at * 1000).toLocaleString()}</span>
            </div>
            <p className="small">
              by {e.admin_name || e.admin_id} · {e.target_type || ''} {(e.target_id || '').slice(0, 8)}
            </p>
            <pre className="tiny mono" style={{ whiteSpace: 'pre-wrap' }}>
              {JSON.stringify(e.diff, null, 1)}
            </pre>
          </div>
        ))
      ) : (
        <p className="small">No audit entries yet.</p>
      )}
    </>
  );
}
