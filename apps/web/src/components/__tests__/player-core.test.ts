// PlayerCore integration test: the ported anti-fraud player logic against the REAL
// local API (server must be up: npm run dev). Mocked <video> element + DOM shims,
// but real signup → claim → heartbeat → attention → complete protocol, driven with
// honest 1x playback in real time.
// Run: npx tsx --tsconfig apps/web/tsconfig.json apps/web/src/components/__tests__/player-core.test.ts
import { DatabaseSync } from 'node:sqlite';
import { PlayerCore } from '../WatchPlayer';

const BASE = 'http://127.0.0.1:8787';
const DB_PATH = `${process.env.HOME}/workspace/kudiwatch/data/kudiwatch.db`;
const FP = `player-core-test-${Date.now()}`;

// ---- fetch → real API with cookie jar + device fingerprint ----
let cookies = '';
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = typeof input === 'string' ? (input.startsWith('/') ? BASE + input : input) : input;
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (cookies) headers['Cookie'] = cookies;
  if (!headers['X-Device-Fp']) headers['X-Device-Fp'] = FP;
  const res: Response = await realFetch(url, { ...init, headers });
  const setCookies = (res.headers as any).getSetCookie?.() ?? [];
  const jar = new Map<string, string>();
  for (const c of cookies.split('; ')) { if (!c) continue; const i = c.indexOf('='); jar.set(c.slice(0, i), c.slice(i + 1)); }
  for (const sc of setCookies) {
    const [pair] = sc.split(';'); const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim(); const val = pair.slice(i + 1).trim();
    if (sc.toLowerCase().includes('max-age=0')) jar.delete(name); else jar.set(name, val);
  }
  cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return res;
};

// ---- DOM shims ----
type Handler = (...args: any[]) => void;
function makeEmitter() {
  const map = new Map<string, Handler[]>();
  return {
    addEventListener: (t: string, h: Handler) => { map.set(t, [...(map.get(t) ?? []), h]); },
    removeEventListener: (t: string, h: Handler) => { map.set(t, (map.get(t) ?? []).filter((x) => x !== h)); },
    fire: (t: string, e: any = {}) => { for (const h of map.get(t) ?? []) h(e); },
  };
}
const winEvents = makeEmitter();
const docEvents = makeEmitter();
(globalThis as any).window = { addEventListener: winEvents.addEventListener, removeEventListener: winEvents.removeEventListener };
const mockDoc: any = {
  hidden: false, visibilityState: 'visible', fullscreenElement: null,
  addEventListener: docEvents.addEventListener, removeEventListener: docEvents.removeEventListener,
};
(globalThis as any).document = mockDoc;
try { Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }); } catch { /* guarded in core */ }

function makeVideo() {
  const em = makeEmitter();
  return {
    ...em, currentTime: 0, duration: 75, playbackRate: 1, paused: true,
    muted: false, readyState: 4, src: '', preload: '', playCalls: 0, pauseCalls: 0,
    async play(this: any) { this.playCalls++; this.paused = false; },
    pause(this: any) { this.pauseCalls++; this.paused = true; },
    setAttribute() {}, requestFullscreen() {},
  } as any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

async function main() {
  const RUN = Math.floor(100000 + Math.random() * 899999);
  const phone = `+1555${RUN}03`;

  console.log('[setup] signup + claim via real API');
  let r = await fetch(`${BASE}/v1/auth/otp/request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_e164: phone }) });
  if (!r.ok) throw new Error('otp request failed');
  r = await fetch(`${BASE}/v1/_dev/last-otp?phone=${encodeURIComponent(phone)}`);
  const code = (await r.json()).data.code as string;
  r = await fetch(`${BASE}/v1/auth/otp/verify`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_e164: phone, code, display_name: 'PCTest', country_code: 'NG', device: { fingerprint: FP, user_agent: 'node-test', platform: 'node' } }),
  });
  if (!r.ok) throw new Error('otp verify failed: ' + (await r.text()).slice(0, 200));

  r = await fetch(`${BASE}/v1/feed/next`);
  const feed = (await r.json()).data;
  if (!feed.assignment) { console.log('  SKIP: no assignment offered'); process.exit(2); }
  r = await fetch(`${BASE}/v1/assignments/${feed.assignment.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const claim = (await r.json()).data;
  check('claim ok', !!claim.session_id && !!claim.watch_token, JSON.stringify(claim).slice(0, 100));
  const duration: number = claim.video.duration_s;
  const checks: Array<{ id: string; type: 'tap' | 'quiz'; scheduled_at_s: number }> = claim.checks ?? [];
  console.log(`  session=${claim.session_id} duration=${duration}s checks=${checks.length} ${checks.map((c) => `${c.type}@${c.scheduled_at_s}s`).join(',')}`);

  // quiz answers live server-side only (never sent to the client); the test may peek at the local DB
  const db = new DatabaseSync(DB_PATH);
  const quizAnswer = (checkId: string): number | undefined => {
    try {
      const row = db.prepare('SELECT payload FROM attention_checks WHERE id = ?').get(checkId) as any;
      const p = JSON.parse(row?.payload ?? '{}');
      return typeof p.answer_idx === 'number' ? p.answer_idx : undefined;
    } catch { return undefined; }
  };

  const sinkCalls: Record<string, any[]> = { attention: [], done: [], fail: [], hidden: [], intervals: [] };
  const ui = {
    setIntervals: (iv: any) => sinkCalls.intervals.push(iv),
    setPosition: () => {},
    setChecklist: () => {},
    setHidden: (b: boolean) => sinkCalls.hidden.push(b),
    setAttention: (a: any) => sinkCalls.attention.push(a),
    onDone: (d: any) => sinkCalls.done.push(d),
    onFail: (reason: string, msg: string) => sinkCalls.fail.push({ reason, msg }),
    toast: () => {},
  };

  const video = makeVideo();
  video.duration = duration;
  const core = new PlayerCore({
    sessionId: claim.session_id, videoEl: video,
    streamUrl: `${claim.stream_url}?wt=${encodeURIComponent(claim.watch_token)}`,
    checks, duration, ui,
  });

  console.log('[test] start()');
  await core.start();
  check('stream url set', String(video.src).startsWith('/v1/stream/'));
  check('play attempted', video.playCalls >= 1);
  video.fire('loadedmetadata');

  console.log('[test] client-side enforcement (seek clamp, rate lock, visibility)');
  // advance a little so maxPos is non-trivial
  for (let t = 1; t <= 4; t++) { video.currentTime = t; video.fire('timeupdate'); await sleep(700); }
  const maxPos = video.currentTime;
  video.currentTime = maxPos + 30; video.fire('seeking');
  check('forward seek clamped to maxPos', Math.abs(video.currentTime - maxPos) < 0.01, `ct=${video.currentTime}`);
  video.currentTime = 2; video.fire('seeking');
  check('backward seek allowed', video.currentTime === 2);
  video.currentTime = maxPos;
  video.playbackRate = 2; video.fire('ratechange');
  check('rate forced back to 1x', video.playbackRate === 1);
  check('paused on rate violation', video.pauseCalls >= 1);
  await video.play();
  mockDoc.hidden = true; mockDoc.visibilityState = 'hidden'; docEvents.fire('visibilitychange');
  await sleep(1200);
  check('paused when tab hidden', video.pauseCalls >= 1);
  check('ui.setHidden(true)', sinkCalls.hidden.includes(true));
  mockDoc.hidden = false; mockDoc.visibilityState = 'visible'; docEvents.fire('visibilitychange');
  await video.play();

  console.log('[test] honest full playback with attention checks');
  const answered = new Set<string>();
  const t0 = Date.now();
  let t = Math.floor(maxPos) + 1;
  // hold just before the end until every scheduled check is presented+answered
  while (t <= duration) {
    const hold = t >= duration && answered.size < checks.length;
    video.currentTime = hold ? duration - 0.5 : Math.min(t, duration);
    video.fire('timeupdate');
    // answer anything presented
    const att = sinkCalls.attention[sinkCalls.attention.length - 1];
    if (att && !answered.has(att.chk.id)) {
      const idx = att.chk.type === 'quiz' ? quizAnswer(att.chk.id) : undefined;
      console.log(`  presenting ${att.chk.type} check ${att.chk.id.slice(0, 8)} (answer_idx=${idx})`);
      await (core as any).answerCheck(att.chk, idx);
      answered.add(att.chk.id);
      await sleep(600);
    }
    if (!hold) t++;
    await sleep(850);
    if (Date.now() - t0 > (duration + 60) * 1000) break; // safety
  }
  check('all scheduled checks answered', answered.size === checks.length, `answered=${answered.size}/${checks.length}`);
  check('no fail during playback', sinkCalls.fail.length === 0, JSON.stringify(sinkCalls.fail));
  const iv = sinkCalls.intervals[sinkCalls.intervals.length - 1];
  check('server verified intervals', Array.isArray(iv) && iv.length > 0);

  console.log('[test] finish() → complete → credited');
  video.currentTime = duration;
  video.fire('ended');
  await sleep(2500);
  const done = sinkCalls.done[0];
  check('onDone fired', !!done, JSON.stringify(sinkCalls.fail));
  check('status completed', done?.status === 'completed', JSON.stringify(done));
  check('credited_cents > 0', (done?.credited_cents ?? 0) > 0);

  console.log('[test] destroy() detaches');
  core.destroy();
  const pb = video.pauseCalls;
  mockDoc.hidden = true; docEvents.fire('visibilitychange');
  await sleep(300);
  check('no reaction after destroy', video.pauseCalls === pb);
  mockDoc.hidden = false;
  db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
