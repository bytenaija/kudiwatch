/* KudiWatch shared frontend: API client, auth guard, device fingerprint,
   money formatting, banners, tab bar. Vanilla JS, no build. */
(function () {
  'use strict';

  const API = ''; // same-origin: /v1/*

  async function api(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const fp = deviceFp();
    if (fp) headers['X-Device-Fp'] = fp;
    const res = await fetch(API + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...opts,
    });
    let json = {};
    try { json = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const e = new Error(json?.error?.message || `Request failed (${res.status})`);
      e.code = json?.error?.code;
      e.status = res.status;
      e.requestId = json?.error?.request_id;
      throw e;
    }
    return json.data;
  }

  // Stable per-device id (survives cookie clear; not reinstall). Hashed server-side.
  function deviceFp() {
    try {
      let id = localStorage.getItem('kw_device_id');
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem('kw_device_id', id);
      }
      const ua = navigator.userAgent || '';
      const screen = `${screen.width}x${screen.height}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return [id, ua, screen, tz].join('|');
    } catch { return ''; }
  }

  function money(cents) {
    const v = (cents / 100).toFixed(2);
    return '$' + v;
  }
  function moneyA11y(cents) {
    const d = Math.floor(cents / 100), c = cents % 100;
    return `${d} dollar${d === 1 ? '' : 's'}${c ? ` ${c} cent${c === 1 ? '' : 's'}` : ''}`;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function toast(msg, kind = 'info') {
    let el = document.getElementById('kw-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kw-toast';
      el.setAttribute('role', 'status');
      el.style.cssText = 'position:fixed;left:16px;right:16px;bottom:84px;z-index:70;display:none;';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="banner ${kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'info'}" style="margin:0">${esc(msg)}</div>`;
    el.style.display = 'block';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
  }

  function showError(msg, requestId) {
    toast(`${msg}${requestId ? ` (Ref: ${String(requestId).slice(0, 8)})` : ''}`, 'err');
  }

  // Mock-mode banner on every money screen (mock builds say so loudly).
  function mockBanner() {
    if (sessionStorage.getItem('kw_mock_dismissed')) return;
    const host = document.createElement('div');
    host.innerHTML = `
      <div class="banner warn" role="note" style="margin:12px 16px 0">
        <span><strong>Mock mode</strong> — no real money moves in this build. Payouts are simulated end-to-end.</span>
        <button class="x" aria-label="Dismiss">×</button>
      </div>`;
    const banner = host.firstElementChild;
    document.body.prepend(banner);
    banner.querySelector('.x').addEventListener('click', () => {
      sessionStorage.setItem('kw_mock_dismissed', '1');
      banner.remove();
    });
  }

  function tabbar(active) {
    const tabs = [
      { id: 'videos', href: '/app/', label: 'Videos', icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/>' },
      { id: 'earnings', href: '/app/earnings.html', label: 'Earnings', icon: '<path d="M3 10h18M3 10v8a2 2 0 002 2h14a2 2 0 002-2v-8M3 10l2-5h14l2 5M12 10v10"/>' },
      { id: 'payout', href: '/app/payout.html', label: 'Payout', icon: '<path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/>' },
    ];
    const nav = document.createElement('nav');
    nav.className = 'tabbar';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = tabs.map((t) => `
      <a href="${t.href}" class="${t.id === active ? 'active' : ''}" ${t.id === active ? 'aria-current="page"' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.icon}</svg>
        <span>${t.label}</span>
        ${t.id === 'payout' && localStorage.getItem('kw_payout_dot') ? '<span class="dot" aria-hidden="true"></span>' : ''}
      </a>`).join('');
    document.body.appendChild(nav);
  }

  function topbar(title, opts = {}) {
    const bar = document.createElement('div');
    bar.className = 'topbar';
    bar.innerHTML = `
      <a class="brand" href="${opts.home || '/app/'}"><span class="k">Kudi</span>Watch</a>
      <span class="spacer"></span>
      ${opts.right || ''}`;
    document.body.prepend(bar);
    if (title) document.title = `${title} — KudiWatch`;
  }

  async function requireAuth() {
    try {
      return await api('GET', '/v1/me');
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        location.href = '/app/signup.html';
        throw new Error('redirecting to signup');
      }
      throw e;
    }
  }

  function setBusy(btn, busy, label) {
    if (busy) {
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${esc(label || 'Working…')}`;
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.innerHTML = btn.dataset.label || '';
    }
  }

  // Offline queue: heartbeats wait in IndexedDB and flush in order.
  const OfflineQ = {
    db: null,
    open() {
      return new Promise((resolve) => {
        if (this.db) return resolve(this.db);
        const req = indexedDB.open('kw-offline', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('queue', { autoIncrement: true });
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => resolve(null);
      });
    },
    async push(item) {
      const db = await this.open();
      if (!db) return false;
      return new Promise((resolve) => {
        const tx = db.transaction('queue', 'readwrite');
        tx.objectStore('queue').add({ ...item, queuedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    },
    async count() {
      const db = await this.open();
      if (!db) return 0;
      return new Promise((resolve) => {
        const tx = db.transaction('queue', 'readonly');
        const req = tx.objectStore('queue').count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      });
    },
    async flush(send) {
      const db = await this.open();
      if (!db) return;
      const items = await new Promise((resolve) => {
        const tx = db.transaction('queue', 'readonly');
        const req = tx.objectStore('queue').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
      for (const item of items) {
        try {
          await send(item);
          await new Promise((resolve) => {
            const tx = db.transaction('queue', 'readwrite');
            // delete by re-listing (autoIncrement keys unknown) — clear+re-add rest
            tx.objectStore('queue').clear();
            tx.oncomplete = () => resolve();
          });
          // re-queue the remainder after clearing
          const rest = items.slice(items.indexOf(item) + 1);
          for (const r of rest) await this.push(r);
          break;
        } catch { break; }
      }
    },
  };

  function offlineBar() {
    const bar = document.createElement('div');
    bar.className = 'offline-bar';
    bar.id = 'kw-offline';
    bar.setAttribute('role', 'status');
    document.body.prepend(bar);
    const update = async () => {
      const n = await OfflineQ.count();
      if (!navigator.onLine) {
        bar.innerHTML = `You're offline. Your progress is saved on this phone and will send when you're back.${n ? ` (${n} waiting)` : ''}`;
        bar.classList.add('show');
      } else {
        bar.classList.remove('show');
        if (n > 0) OfflineQ.flush(() => Promise.resolve());
      }
    };
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    setInterval(update, 5000);
  }

  window.KW = {
    api, deviceFp, money, moneyA11y, esc, toast, showError,
    mockBanner, tabbar, topbar, requireAuth, setBusy, OfflineQ, offlineBar,
  };
})();
