// PlayerCore integration test: the anti-fraud player logic against the REAL
// local API (server must be up: npm run dev). FakeDriver stands in for the
// YouTube IFrame player (headless CI can't load youtube.com); the protocol
// under test — claim → heartbeat → attention → complete — is player-agnostic.
// Run: npx tsx --tsconfig apps/web/tsconfig.json apps/web/src/components/__tests__/player-core.test.ts
import { DatabaseSync } from 'node:sqlite';
import { PlayerCore, type PlayerDriver } from '../WatchPlayer';

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

// ---- DOM shims (document/window only; no <video> anymore) ----
const docEvents = new Map<string, Array<(...a: any[]) => void>>();
const winEvents = new Map<string, Array<(...a: any[]) => void>>();
(globalThis as any).window = {
  addEventListener: (t: string, h: any) => { winEvents.set(t, [...(winEvents.get(t) ?? []), h]); },
  removeEventListener: (t: string, h: any) => { winEvents.set(t, (winEvents.get(t) ?? []).filter((x) => x !== h)); },
};
(globalThis as any).document = {
  hidden: false, visibilityState: 'visible', fullscreenElement: null,
  addEventListener: (t: string, h: any) => { docEvents.set(t, [...(docEvents.get(t) ?? []), h]); },
  removeEventListener: (t: string, h: any) => { docEvents.set(t, (docEvents.get(t) ?? []).filter((x) => x !== h)); },
};
try { Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true }); } catch { /* guarded in core */ }

// ---- FakeDriver: scriptable stand-in for the YouTube IFrame player ----
class FakeDriver implements PlayerDriver {
  position = 0;
  rate = 1;
  duration: number;
  playing = false;
  playCalls = 0;
  pauseCalls = 0;
  seeks: number[] = [];
  private tickCb: ((p: number) => void) | null = null;
  private rateCb: (() => void) | null = null;
  private endedCb: (() => void) | null = null;
  private errorCb: ((c: number | string) => void) | null = null;
  constructor(duration: number) { this.duration = duration; }
  async init(_c: any, _v: string): Promise<number> { return this.duration; }
  play() { this.playCalls++; this.playing = true; }
  pause() { this.pauseCalls++; this.playing = false; }
  isPlaying() { return this.playing; }
  getPosition() { return this.position; }
  getRate() { return this.rate; }
  seekTo(s: number) { this.seeks.push(s); this.position = s; this.tick(); }
  setRate(r: number) { this.rate = r; }
  onTick(cb: (p: number) => void) { this.tickCb = cb; }
  onRateChange(cb: () => void) { this.rateCb = cb; }
  onEnded(cb: () => void) { this.endedCb = cb; }
  onError(cb: (c: number | string) => void) { this.errorCb = cb; }
  destroy() { this.tickCb = null; }
  // test controls
  tick() { this.tickCb?.(this.position); }
  fireRateChange() { this.rateCb?.(); }
  fireEnded() { this.endedCb?.(); }
  fireError(c: number | string) { this.errorCb?.(c); }
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
  check('claim ok', !!claim.session_id && !!claim.youtube_video_id, JSON.stringify(claim).slice(0, 120));
  const duration: number = claim.video.duration_s;
  const checks: Array<{ id: string; type: 'tap' | 'quiz'; scheduled_at_s: number }> = claim.checks ?? [];
  console.log(`  session=${claim.session_id} yt=${claim.youtube_video_id} duration=${duration}s checks=${checks.length}`);

  const db = new DatabaseSync(DB_PATH);
  const quizAnswer = (checkId: string): number | undefined => {
    try {
      const row = db.prepare('SELECT payload FROM attention_checks WHERE id = ?').get(checkId) as any;
      const p = JSON.parse(row?.payload ?? '{}');
      return typeof p.answer_idx === 'number' ? p.answer_idx : undefined;
    } catch { return undefined; }
  };

  const sinkCalls: Record<string, any[]> = { attention: [], done: [], fail: [], hidden: [], intervals: [], durations: [] };
  const ui = {
    setIntervals: (iv: any) => sinkCalls.intervals.push(iv),
    setPosition: () => {},
    setDuration: (d: number) => sinkCalls.durations.push(d),
    setChecklist: () => {},
    setHidden: (b: boolean) => sinkCalls.hidden.push(b),
    setAttention: (a: any) => sinkCalls.attention.push(a),
    onDone: (d: any) => sinkCalls.done.push(d),
    onFail: (reason: string, msg: string) => sinkCalls.fail.push({ reason, msg }),
    toast: () => {},
  };

  const driver = new FakeDriver(duration);
  const core = new PlayerCore({ sessionId: claim.session_id, driver, checks, duration, ui });

  console.log('[test] start()');
  await core.start({} as any, claim.youtube_video_id);
  check('play attempted', driver.playCalls >= 1);

  console.log('[test] client-side enforcement (seek clamp, rate lock, visibility)');
  for (let t = 1; t <= 4; t++) { driver.position = t; driver.tick(); await sleep(700); }
  const maxPos = driver.position;
  driver.position = maxPos + 30; driver.tick();
  check('forward seek clamped to maxPos', Math.abs(driver.position - maxPos) < 0.01 && driver.seeks.length > 0, `pos=${driver.position}`);
  driver.position = 2; driver.tick();
  check('backward seek allowed', driver.position === 2);
  driver.position = maxPos;
  driver.rate = 2; driver.fireRateChange();
  check('rate forced back to 1x', driver.rate === 1);
  check('paused on rate violation', driver.pauseCalls >= 1);
  driver.play();
  (globalThis as any).document.hidden = true;
  for (const h of docEvents.get('visibilitychange') ?? []) h();
  await sleep(1200);
  check('paused when tab hidden', driver.pauseCalls >= 1);
  check('ui.setHidden(true)', sinkCalls.hidden.includes(true));
  (globalThis as any).document.hidden = false;
  for (const h of docEvents.get('visibilitychange') ?? []) h();
  driver.play();

  console.log('[test] honest full playback with attention checks');
  const answered = new Set<string>();
  const t0 = Date.now();
  let t = Math.floor(maxPos) + 1;
  while (t <= duration) {
    const hold = t >= duration && answered.size < checks.length;
    driver.position = hold ? duration - 0.5 : Math.min(t, duration);
    driver.tick();
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
    if (Date.now() - t0 > (duration + 60) * 1000) break;
  }
  check('all scheduled checks answered', answered.size === checks.length, `answered=${answered.size}/${checks.length}`);
  check('no fail during playback', sinkCalls.fail.length === 0, JSON.stringify(sinkCalls.fail));
  const iv = sinkCalls.intervals[sinkCalls.intervals.length - 1];
  check('server verified intervals', Array.isArray(iv) && iv.length > 0);

  console.log('[test] finish() → complete → credited');
  driver.position = duration;
  driver.fireEnded();
  await sleep(2500);
  const done = sinkCalls.done[0];
  check('onDone fired', !!done, JSON.stringify(sinkCalls.fail));
  check('status completed', done?.status === 'completed', JSON.stringify(done));
  check('credited_cents > 0', (done?.credited_cents ?? 0) > 0);

  console.log('[test] destroy() detaches');
  core.destroy();
  const pb = driver.pauseCalls;
  (globalThis as any).document.hidden = true;
  for (const h of docEvents.get('visibilitychange') ?? []) h();
  await sleep(300);
  check('no reaction after destroy', driver.pauseCalls === pb);
  db.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
