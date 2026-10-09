// KudiWatch API client — port of apps/web/public/js/kw.js.
// Same /v1/* contract, same cookies (kw_at/kw_rt), same X-Device-Fp header.

export class ApiError extends Error {
  code?: string;
  status: number;
  requestId?: string;
  constructor(message: string, opts: { code?: string; status: number; requestId?: string }) {
    super(message);
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

export async function api<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const fp = deviceFp();
  if (fp) headers['X-Device-Fp'] = fp;
  const res = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
  });
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    throw new ApiError(json?.error?.message || `Request failed (${res.status})`, {
      code: json?.error?.code,
      status: res.status,
      requestId: json?.error?.request_id,
    });
  }
  return json.data as T;
}

/** Stable per-device id (survives cookie clear; not reinstall). Hashed server-side. */
export function deviceFp(): string {
  try {
    let id = localStorage.getItem('kw_device_id');
    if (!id) {
      id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('kw_device_id', id);
    }
    const ua = navigator.userAgent || '';
    const screen = `${window.screen.width}x${window.screen.height}`;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    return [id, ua, screen, tz].join('|');
  } catch {
    return '';
  }
}

export function money(cents: number): string {
  return '$' + (cents / 100).toFixed(2);
}

export function moneyA11y(cents: number): string {
  const d = Math.floor(cents / 100);
  const c = cents % 100;
  return `${d} dollar${d === 1 ? '' : 's'}${c ? ` ${c} cent${c === 1 ? '' : 's'}` : ''}`;
}

export function fmtTime(s: number): string {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Auth guard for protected routes. Throws RedirectToSignup on 401/403. */
export class RedirectToSignup extends Error {}
export async function requireAuth(): Promise<MeResponse> {
  try {
    return await api<MeResponse>('GET', '/v1/me');
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
      throw new RedirectToSignup();
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Offline queue: heartbeats wait in IndexedDB and flush in order.
// Port of kw.js OfflineQ (same store name 'kw-offline', same semantics).
// ---------------------------------------------------------------------------

interface QueuedItem {
  kind: string;
  sid: string;
  payload: unknown;
  queuedAt?: number;
}

class OfflineQueue {
  private db: IDBDatabase | null = null;

  open(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      if (this.db) return resolve(this.db);
      try {
        const req = indexedDB.open('kw-offline', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('queue', { autoIncrement: true });
        req.onsuccess = () => {
          this.db = req.result;
          resolve(this.db);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async push(item: QueuedItem): Promise<boolean> {
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction('queue', 'readwrite');
      tx.objectStore('queue').add({ ...item, queuedAt: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async count(): Promise<number> {
    const db = await this.open();
    if (!db) return 0;
    return new Promise((resolve) => {
      const tx = db.transaction('queue', 'readonly');
      const req = tx.objectStore('queue').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(0);
    });
  }

  async flush(send: (item: QueuedItem) => Promise<void>): Promise<void> {
    const db = await this.open();
    if (!db) return;
    const items: QueuedItem[] = await new Promise((resolve) => {
      const tx = db.transaction('queue', 'readonly');
      const req = tx.objectStore('queue').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    for (const item of items) {
      try {
        await send(item);
        await new Promise<void>((resolve) => {
          const tx = db.transaction('queue', 'readwrite');
          // delete by re-listing (autoIncrement keys unknown) — clear+re-add rest
          tx.objectStore('queue').clear();
          tx.oncomplete = () => resolve();
        });
        // re-queue the remainder after clearing
        const rest = items.slice(items.indexOf(item) + 1);
        for (const r of rest) await this.push(r);
        break;
      } catch {
        break;
      }
    }
  }
}

export const OfflineQ = new OfflineQueue();

// ---------------------------------------------------------------------------
// API response types (subset of the /v1/* contract used by the frontend)
// ---------------------------------------------------------------------------

export interface MeResponse {
  user: {
    id: string;
    display_name: string;
    country_code: string;
    roles: string[];
    status: string;
  };
  wallet: { balance_cents: number };
}

export interface FeedResponse {
  assignment: {
    id: string;
    claim_deadline: number;
  } | null;
  video: { id: string; duration_s: number } | null;
  campaign: {
    title: string;
    advertiser: string;
    price_per_view_cents: number;
  } | null;
  message?: string;
}

export interface ClaimResponse {
  session_id: string;
  stream_url: string;
  watch_token: string;
  checks: AttentionCheck[];
  video: { duration_s: number };
  campaign: { title: string; price_per_view_cents: number };
}

export interface AttentionCheck {
  id: string;
  type: 'tap' | 'quiz';
  scheduled_at_s: number;
}

export interface WalletResponse {
  balance_cents: number;
  pending_payout_cents: number;
  views_today: number;
  max_views_per_day: number;
  views_completed: number;
  lifetime_earned_cents: number;
  avg_attention_pct: number | null;
}

export function getClaim(): ClaimResponse | null {
  try {
    const raw = sessionStorage.getItem('kw_claim');
    return raw ? (JSON.parse(raw) as ClaimResponse) : null;
  } catch {
    return null;
  }
}

export function setClaim(c: ClaimResponse | null) {
  try {
    if (c) sessionStorage.setItem('kw_claim', JSON.stringify(c));
    else sessionStorage.removeItem('kw_claim');
  } catch {
    /* noop */
  }
}
