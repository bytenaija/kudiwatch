// Shared UI primitives — React port of kw.js chrome helpers
// (topbar, tabbar, toast, banners, sheets, offline bar).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { OfflineQ, RedirectToSignup, money, requireAuth, type MeResponse } from '../lib/api';

// ---------------------------------------------------------------- toast ---
type ToastKind = 'info' | 'warn' | 'err';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const idRef = useRef(0);
  const push = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        id="kw-toast"
        role="status"
        style={{ position: 'fixed', left: 16, right: 16, bottom: 84, zIndex: 70, display: toasts.length ? 'block' : 'none' }}
      >
        {toasts.map((t) => (
          <div key={t.id} className={`banner ${t.kind === 'err' ? 'err' : t.kind === 'warn' ? 'warn' : 'info'}`} style={{ margin: '0 0 8px' }}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

export function useShowError() {
  const toast = useToast();
  return useCallback(
    (msg: string, requestId?: string) =>
      toast(`${msg}${requestId ? ` (Ref: ${String(requestId).slice(0, 8)})` : ''}`, 'err'),
    [toast],
  );
}

// ---------------------------------------------------------------- topbar --
export function TopBar({ title, home = '/app/', right }: { title?: string; home?: string; right?: ReactNode }) {
  useEffect(() => {
    if (title) document.title = `${title} — KudiWatch`;
  }, [title]);
  return (
    <div className="topbar">
      <Link className="brand" to={home}>
        <span className="k">Kudi</span>Watch
      </Link>
      <span className="spacer" />
      {right}
    </div>
  );
}

// ---------------------------------------------------------------- tabbar --
const TABS = [
  {
    id: 'videos',
    to: '/app',
    label: 'Videos',
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none" />
      </>
    ),
  },
  {
    id: 'earnings',
    to: '/app/earnings',
    label: 'Earnings',
    icon: <path d="M3 10h18M3 10v8a2 2 0 002 2h14a2 2 0 002-2v-8M3 10l2-5h14l2 5M12 10v10" />,
  },
  {
    id: 'payout',
    to: '/app/payout',
    label: 'Payout',
    icon: <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />,
  },
];

export function TabBar({ active }: { active: string }) {
  const [dot, setDot] = useState(false);
  useEffect(() => {
    try {
      setDot(!!localStorage.getItem('kw_payout_dot'));
    } catch {
      /* noop */
    }
  }, []);
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.id} to={t.to} className={t.id === active ? 'active' : ''} aria-current={t.id === active ? 'page' : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {t.icon}
          </svg>
          <span>{t.label}</span>
          {t.id === 'payout' && dot && <span className="dot" aria-hidden="true" />}
        </Link>
      ))}
    </nav>
  );
}

// ------------------------------------------------------------- mock banner
export function MockBanner() {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(!!sessionStorage.getItem('kw_mock_dismissed'));
    } catch {
      /* noop */
    }
  }, []);
  if (dismissed) return null;
  return (
    <div className="banner warn" role="note" style={{ margin: '12px 16px 0' }}>
      <span>
        <strong>Mock mode</strong> — no real money moves in this build. Payouts are simulated end-to-end.
      </span>
      <button
        className="x"
        aria-label="Dismiss"
        onClick={() => {
          try {
            sessionStorage.setItem('kw_mock_dismissed', '1');
          } catch {
            /* noop */
          }
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}

// ------------------------------------------------------------- offline bar
export function OfflineBar() {
  const [state, setState] = useState<{ online: boolean; n: number }>({ online: true, n: 0 });
  useEffect(() => {
    let alive = true;
    const update = async () => {
      const n = await OfflineQ.count();
      if (!alive) return;
      if (!navigator.onLine) {
        setState({ online: false, n });
      } else {
        setState({ online: true, n });
        if (n > 0) OfflineQ.flush(() => Promise.resolve());
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    const t = setInterval(update, 5000);
    return () => {
      alive = false;
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      clearInterval(t);
    };
  }, []);
  if (state.online) return null;
  return (
    <div className="offline-bar show" role="status">
      You&apos;re offline. Your progress is saved on this phone and will send when you&apos;re back.
      {state.n ? ` (${state.n} waiting)` : ''}
    </div>
  );
}

// ------------------------------------------------------------ busy button
export function BusyButton({
  busy,
  busyLabel = 'Working…',
  children,
  ...rest
}: {
  busy: boolean;
  busyLabel?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button disabled={busy} aria-busy={busy || undefined} {...rest}>
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ------------------------------------------------------------------ sheet
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="sheet-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="grab" />
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- misc
export function Money({ cents, className = 'money' }: { cents: number; className?: string }) {
  return <span className={className}>{money(cents)}</span>;
}

export function Chip({ kind = '', children }: { kind?: 'ok' | 'warn' | 'bad' | 'info' | ''; children: ReactNode }) {
  return <span className={`chip ${kind}`.trim()}>{children}</span>;
}

export function Banner({ kind, children }: { kind: 'warn' | 'err' | 'info' | 'neutral'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'err' ? 'alert' : 'note'}>
      <span>{children}</span>
    </div>
  );
}

/** Auth guard hook — mirrors kw.js requireAuth(): redirects to signup on 401/403. */
export function useRequireAuth() {
  const navigate = useNavigate();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    requireAuth()
      .then((m) => {
        if (alive) setMe(m);
      })
      .catch((e) => {
        if (e instanceof RedirectToSignup) navigate({ to: '/app/signup' });
        else if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [navigate]);
  return { me, error };
}
