// Focused adversarial probe: player-path tampering must be rejected server-side.
// Covers: dup_seq, bad_rate (2x), hidden playback, position jump, future/past client_ts.
// Run: npx tsx scripts/adv-player.ts (server must be up)
const BASE = process.env.KW_BASE ?? 'http://127.0.0.1:8787';
const RUN = Math.floor(100000 + Math.random() * 899999);
const FP = `adv-player-${RUN}`;

let cookies = '';
async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
      'X-Device-Fp': FP,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const scs = (res.headers as any).getSetCookie?.() ?? [];
  const jar = new Map<string, string>();
  for (const c of cookies.split('; ')) { if (!c) continue; const i = c.indexOf('='); jar.set(c.slice(0, i), c.slice(i + 1)); }
  for (const sc of scs) {
    const [pair] = sc.split(';'); const i = pair.indexOf('=');
    const n = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
    if (sc.toLowerCase().includes('max-age=0')) jar.delete(n); else jar.set(n, v);
  }
  cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let passed = 0, failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (n: string, c: boolean, d = '') => {
  if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${d}`); }
};

async function newSession(): Promise<string> {
  cookies = '';
  const phone = `+1555${Math.floor(100000 + Math.random() * 899999)}${Math.floor(Math.random() * 90 + 10)}`;
  await api('POST', '/v1/auth/otp/request', { phone_e164: phone });
  const code = (await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(phone)}`)).json.data.code;
  const fp = `${FP}-${Math.random().toString(36).slice(2, 8)}`;
  // per-session fingerprint: swap the header for this session's calls
  const v = await api('POST', '/v1/auth/otp/verify', {
    phone_e164: phone, code, display_name: 'AdvP', country_code: 'NG',
    device: { fingerprint: fp, user_agent: 'adv-player/1.0', platform: 'node' },
  });
  if (v.status !== 200) throw new Error('signin failed');
  const feed = (await api('GET', '/v1/feed/next')).json.data;
  if (!feed.assignment) throw new Error('no offer');
  // claim with this session's fingerprint
  const res = await fetch(BASE + `/v1/assignments/${feed.assignment.id}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}), 'X-Device-Fp': fp },
    body: '{}',
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 && res.status !== 201) throw new Error('claim failed: ' + res.status + ' ' + JSON.stringify(json).slice(0, 150));
  const sid = json.data.session_id as string;
  // stash fp for subsequent heartbeat calls
  (globalThis as any).__advFp = fp;
  return sid;
}

function hb(sid: string, seq: number, pos: number, extra: Record<string, unknown> = {}) {
  const fp = (globalThis as any).__advFp as string;
  return fetch(BASE + `/v1/watch/${sid}/heartbeat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookies ? { Cookie: cookies } : {}),
      'X-Device-Fp': fp,
    },
    body: JSON.stringify({
      seq, position_s: pos, visible: true, playback_rate: 1,
      client_ts: Date.now() / 1000, buffering_s: 0, ...extra,
    }),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => ({})) }));
}

async function main() {
  console.log('[probe] honest beat accepted, seq chain enforced');
  let sid = await newSession();
  let r = await hb(sid, 1, 5);
  check('honest seq=1 accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));
  r = await hb(sid, 1, 5);
  check('replayed seq rejected (dup_seq)', r.json.data?.ok === false && r.json.data?.reject_code === 'dup_seq', JSON.stringify(r.json.data));
  await sleep(5500);
  r = await hb(sid, 2, 6);
  check('seq=2 accepted after dup', r.json.data?.ok === true, JSON.stringify(r.json.data));

  console.log('[probe] speed tampering');
  sid = await newSession();
  r = await hb(sid, 1, 5);
  check('baseline accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));
  r = await hb(sid, 2, 10, { playback_rate: 2 });
  check('2x speed rejected (bad_rate)', r.json.data?.ok === false && r.json.data?.reject_code === 'bad_rate', JSON.stringify(r.json.data));

  console.log('[probe] visibility tampering');
  sid = await newSession();
  r = await hb(sid, 1, 5);
  check('baseline accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));
  r = await hb(sid, 2, 10, { visible: false });
  check('hidden playback rejected (hidden)', r.json.data?.ok === false && r.json.data?.reject_code === 'hidden', JSON.stringify(r.json.data));

  console.log('[probe] position jump (skip-ahead)');
  sid = await newSession();
  r = await hb(sid, 1, 5);
  check('baseline accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));
  r = await hb(sid, 2, 60);
  check('forward jump rejected (jump)', r.json.data?.ok === false && r.json.data?.reject_code === 'jump', JSON.stringify(r.json.data));

  console.log('[probe] clock tampering');
  sid = await newSession();
  r = await hb(sid, 1, 5);
  check('baseline accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));
  await sleep(5500);
  r = await hb(sid, 2, 6, { client_ts: Date.now() / 1000 + 3600 });
  check('future client_ts tolerated', r.json.data?.ok === true, JSON.stringify(r.json.data));
  await sleep(5500);
  r = await hb(sid, 3, 7, { client_ts: Date.now() / 1000 - 3600 });
  check('past client_ts honest pos accepted', r.json.data?.ok === true, JSON.stringify(r.json.data));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
