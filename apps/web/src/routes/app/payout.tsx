import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { api, money } from '../../lib/api';
import {
  BusyButton,
  MockBanner,
  OfflineBar,
  Sheet,
  TabBar,
  TopBar,
  useRequireAuth,
  useShowError,
  useToast,
} from '../../components/ui';

export const Route = createFileRoute('/app/payout')({
  component: PayoutPage,
});

const METHODS = [
  {
    id: 'mpesa',
    name: 'M-Pesa',
    icon: '📱',
    fee: 'Fee 1.5% · Arrives in ~5 minutes',
    fields: [{ k: 'msisdn', label: 'M-Pesa phone number', hint: 'e.g. +254712345678' }],
  },
  {
    id: 'airtime',
    name: 'Airtime',
    icon: '⚡',
    fee: 'No fee · Arrives in ~5 minutes',
    fields: [{ k: 'msisdn', label: 'Phone number for airtime', hint: 'e.g. +2348012345678' }],
  },
  {
    id: 'bank',
    name: 'Bank transfer',
    icon: '🏦',
    fee: 'Fee $0.30 · Arrives in ~1 day',
    fields: [
      { k: 'bank', label: 'Bank', hint: 'e.g. GTBank' },
      { k: 'account_number', label: 'Account number', hint: '10 digits' },
    ],
  },
  {
    id: 'usdt',
    name: 'USDT',
    icon: '🔗',
    fee: 'Network fee $1.00 · Arrives in ~10 minutes',
    fields: [
      { k: 'address', label: 'USDT wallet address', hint: '0x… / T… / …' },
      { k: 'network', label: 'Network', hint: 'ERC20, TRC20, BEP20 or Polygon' },
    ],
  },
] as const;

const MIN = 100;

interface Payout {
  id: string;
  method: string;
  amount_cents: number;
  fee_cents: number;
  status: string;
  created_at: number;
  decision_note?: string;
  destination: { label?: string };
}

const STEP_LABELS: Array<[string, string, string]> = [
  ['pending_review', 'Under review', 'A reviewer checks every payout. This usually takes under 24 hours.'],
  ['approved', 'Approved', 'Approved — waiting to be sent.'],
  ['processing', 'Sending', 'Sending it now.'],
  ['completed', 'Paid', 'Done.'],
];

function feeFor(method: string, cents: number): number {
  if (method === 'mpesa') return Math.max(1, Math.round(cents * 0.015));
  if (method === 'bank') return 30;
  if (method === 'usdt') return 100;
  return 0;
}

function PayoutPage() {
  const toast = useToast();
  const showError = useShowError();
  const { me, error } = useRequireAuth();
  const [method, setMethod] = useState<string>('mpesa');
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState<Record<string, string>>({});
  const [balance, setBalance] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [payouts, setPayouts] = useState<Payout[]>([]);

  useEffect(() => {
    if (!me) return;
    setBalance(me.wallet.balance_cents);
  }, [me]);

  const loadTrack = useCallback(async () => {
    try {
      const data = await api<{ payouts: Payout[] }>('GET', '/v1/payouts');
      setPayouts(data.payouts || []);
      try {
        localStorage.removeItem('kw_payout_dot');
      } catch {
        /* noop */
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (me) loadTrack();
  }, [me, loadTrack]);

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

  const m = METHODS.find((x) => x.id === method)!;
  const cents = (() => {
    const v = Number(String(amount).replace(/[^0-9.]/g, ''));
    return Number.isFinite(v) ? Math.round(v * 100) : 0;
  })();
  const fee = feeFor(method, cents);
  const hint =
    cents > 0 && cents < MIN
      ? `Minimum payout is $1.00. You're at ${money(cents)} — ${money(MIN - cents)} to go.`
      : cents > balance
        ? `That's more than your ${money(balance)} balance.`
        : '';

  const submit = async () => {
    if (cents < MIN) {
      toast('Minimum payout is $1.00.', 'warn');
      return;
    }
    if (cents > balance) {
      toast(`That's more than your ${money(balance)} balance.`, 'warn');
      return;
    }
    if (Object.values(dest).some((v) => !v)) {
      toast('Fill in the destination details.', 'warn');
      return;
    }
    setConfirming(true);
  };

  const confirm = async () => {
    setRequesting(true);
    try {
      await api('POST', '/v1/payouts', {
        method,
        destination: dest,
        amount_cents: cents,
        idempotency_key: crypto.randomUUID(),
      });
      setConfirming(false);
      try {
        localStorage.setItem('kw_payout_dot', '1');
      } catch {
        /* noop */
      }
      toast('Payout requested. It\u2019s under review now.');
      setBalance((b) => b - cents);
      loadTrack();
    } catch (e: any) {
      showError(e?.message || 'Could not request payout.', e?.requestId);
    }
    setRequesting(false);
  };

  const activeP = payouts.find((p) => !['completed', 'rejected', 'refunded', 'failed'].includes(p.status));
  const past = payouts.filter((p) => ['completed', 'rejected', 'refunded', 'failed'].includes(p.status));
  const activeIdx = activeP ? ({ pending_review: 0, approved: 1, processing: 2, completed: 3 } as Record<string, number>)[activeP.status] ?? 0 : 0;

  return (
    <div className="wrap">
      <TopBar title="Payout" />
      <TabBar active="payout" />
      <MockBanner />
      <OfflineBar />
      <h1>Get your money</h1>

      <div className="card">
        <label htmlFor="amount">How much? (minimum $1.00)</label>
        <input id="amount" type="text" inputMode="decimal" placeholder="1.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <p className="hint">{hint}</p>
        <p className="small">Available: {money(balance)}</p>
      </div>

      <h2>How should we send it?</h2>
      <div>
        {METHODS.map((mm) => (
          <button
            key={mm.id}
            className={`method-card${mm.id === method ? ' sel' : ''}`}
            aria-pressed={mm.id === method}
            onClick={() => {
              setMethod(mm.id);
              setDest({});
            }}
          >
            <span className="ic" aria-hidden="true">
              {mm.icon}
            </span>
            <span>
              <strong>{mm.name}</strong>
              <br />
              <span className="meta">{mm.fee}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="tiny">Fees are estimates for this demo. Real fees will be shown before you confirm.</p>

      <div className="card">
        {m.fields.map((f) => (
          <div key={f.k}>
            <label htmlFor={`dest-${f.k}`}>{f.label}</label>
            <input
              id={`dest-${f.k}`}
              type="text"
              placeholder={f.hint}
              value={dest[f.k] || ''}
              onChange={(e) => setDest((d) => ({ ...d, [f.k]: e.target.value }))}
            />
          </div>
        ))}
      </div>

      <div className="card">
        <div className="between">
          <span>You&apos;ll receive</span>
          <strong className="money" style={{ fontSize: 20 }}>
            {money(Math.max(0, cents - fee))}
          </strong>
        </div>
      </div>

      <button className="btn primary" onClick={submit}>
        Request payout
      </button>

      <h2>Track payouts</h2>
      {activeP ? (
        <div className="card">
          <div className="between">
            <strong>
              {money(activeP.amount_cents)} via {activeP.method}
            </strong>
            <span className={`chip ${activeP.status === 'pending_review' ? 'warn' : 'info'}`}>
              {activeP.status.replace('_', ' ')}
            </span>
          </div>
          <ol className="stepper">
            {STEP_LABELS.map(([s, label, sub], i) => (
              <li key={s} className={i < activeIdx ? 'done' : i === activeIdx ? 'now' : ''}>
                <span className="n">{i < activeIdx ? '✓' : i + 1}</span>
                <span>
                  <span className="t">{label}</span>
                  <br />
                  <span className="s">{i === activeIdx ? sub : ''}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="tiny mono">
            state: {activeP.status} · id {activeP.id.slice(0, 8)}…
          </p>
        </div>
      ) : (
        <p className="small">No payout in flight.</p>
      )}

      <h2>Past payouts</h2>
      {past.length ? (
        past.map((p) => (
          <div className="card" key={p.id}>
            <div className="between">
              <strong>{money(p.amount_cents)}</strong>
              <span className={`chip ${p.status === 'completed' ? 'ok' : p.status === 'refunded' ? '' : 'bad'}`}>
                {p.status.toUpperCase()}
              </span>
            </div>
            <p className="small">
              {p.status === 'completed' ? 'Paid.' : p.status === 'refunded' ? 'Returned to your balance.' : 'Not sent.'}
              {p.decision_note ? ` — ${p.decision_note}` : ''}
            </p>
            <p className="tiny">{new Date(p.created_at * 1000).toLocaleString()}</p>
          </div>
        ))
      ) : (
        <p className="small">No payouts yet. When you request a payout it will be tracked here, step by step.</p>
      )}

      {confirming && (
        <Sheet title="Confirm payout" onClose={() => setConfirming(false)}>
          <div className="between">
            <span>Amount</span>
            <strong className="money">{money(cents)}</strong>
          </div>
          <div className="between">
            <span>Fee</span>
            <span>{money(fee)}</span>
          </div>
          <div className="between">
            <span>You&apos;ll receive</span>
            <strong className="money">{money(cents - fee)}</strong>
          </div>
          <div className="between">
            <span>To</span>
            <span className="small">{Object.values(dest).join(' · ')}</span>
          </div>
          <p className="small">A person reviews every payout before money moves. This usually takes under 24 hours.</p>
          <BusyButton className="btn primary" busy={requesting} busyLabel="Requesting…" onClick={confirm}>
            Confirm payout
          </BusyButton>
          <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
