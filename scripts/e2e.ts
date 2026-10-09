// E2E: signup → OTP → feed → claim → real-time heartbeats → attention check
// → completion → credit → payout request → admin approval → cron → completed.
// Run: npm run e2e  (server must be up: npm run dev)
const BASE = process.env.KW_BASE ?? 'http://127.0.0.1:8787';
// Fresh identity per run: the same phone can't re-watch a campaign (per_user_cap),
// and reusing one device fingerprint across runs would trip multi-account limits.
const RUN = Math.floor(100000 + Math.random() * 899999);
const PHONE = process.env.KW_PHONE ?? `+1555${RUN}01`;
const ADMIN_PHONE = '+10000000001';

let cookies = '';
function storeCookies(res: Response): void {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const jar = new Map<string, string>();
  for (const c of cookies.split('; ')) {
    if (!c) continue;
    const i = c.indexOf('=');
    jar.set(c.slice(0, i), c.slice(i + 1));
  }
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const i = pair!.indexOf('=');
    const name = pair!.slice(0, i).trim();
    const val = pair!.slice(i + 1).trim();
    if (sc.toLowerCase().includes('max-age=0')) jar.delete(name);
    else jar.set(name, val);
  }
  cookies = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(res);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const FP = `e2e-device-fingerprint-${RUN}`;
const headers = { 'X-Device-Fp': FP };

async function signInAs(phone: string): Promise<void> {
  cookies = '';
  let r = await api('POST', '/v1/auth/otp/request', { phone_e164: phone });
  if (r.status !== 200) throw new Error(`otp request failed: ${JSON.stringify(r.json)}`);
  r = await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(phone)}`);
  const code = r.json.data.code as string;
  r = await api('POST', '/v1/auth/otp/verify', {
    phone_e164: phone, code, display_name: 'E2E', country_code: 'NG',
    device: { fingerprint: FP, user_agent: 'kudiwatch-e2e/1.0', platform: 'node' },
  });
  if (r.status !== 200) throw new Error(`otp verify failed: ${JSON.stringify(r.json)}`);
  console.log(`[e2e] signed in as ${phone}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // --- Watcher: feed → claim ---
  await signInAs(PHONE);
  let r = await api('GET', '/v1/feed/next', undefined, headers);
  if (!r.json.data?.assignment) throw new Error(`no offer: ${JSON.stringify(r.json.data)}`);
  const offer = r.json.data;
  console.log(`[e2e] offer: ${offer.campaign.title} pays $${(offer.campaign.price_per_view_cents / 100).toFixed(2)}`);

  r = await api('POST', `/v1/assignments/${offer.assignment.id}/claim`, {}, headers);
  if (r.status !== 200) throw new Error(`claim failed: ${JSON.stringify(r.json)}`);
  const claim = r.json.data;
  const sid: string = claim.session_id;
  const watchToken: string = claim.watch_token;
  const checks: Array<{ id: string; type: string; scheduled_at_s: number }> = claim.checks;
  console.log(`[e2e] claimed session ${sid}, ${checks.length} attention check(s) scheduled`);

  // --- Stream sanity: range request with the watch token ---
  const streamRes = await fetch(`${BASE}/v1/stream/${offer.video.id}?wt=${watchToken}`, {
    headers: { Range: 'bytes=0-1023' },
  });
  const firstBytes = new Uint8Array(await streamRes.arrayBuffer());
  if (streamRes.status !== 206 || firstBytes.length !== 1024) {
    throw new Error(`stream range failed: ${streamRes.status} len=${firstBytes.length}`);
  }
  console.log(`[e2e] stream 206 partial content OK (${firstBytes.length} bytes)`);

  // --- Real-time heartbeats (10 s cadence, honest positions) ---
  const answered = new Set<string>();
  let seq = 0;
  let position = 0;
  const DURATION = offer.video.duration_s as number;
  const step = 10;
  for (let t = step; t <= DURATION; t += step) {
    await sleep(10_000);
    seq++;
    position = Math.min(DURATION, t);
    r = await api('POST', `/v1/watch/${sid}/heartbeat`, {
      seq, position_s: position, visible: true, playback_rate: 1, client_ts: Date.now() / 1000,
    }, headers);
    const hb = r.json.data;
    if (!hb.ok) throw new Error(`heartbeat ${seq} rejected: ${hb.reject_code}`);
    console.log(`[e2e] heartbeat ${seq}: pos=${position}s watched=${hb.watched_pct.toFixed(1)}%`);

    // Present + answer any due attention checks.
    for (const chk of checks) {
      if (answered.has(chk.id) || chk.scheduled_at_s > position) continue;
      let ar = await api('POST', `/v1/watch/${sid}/attention`, { check_id: chk.id }, headers);
      if (ar.json.data?.presented) {
        console.log(`[e2e] attention check presented (${chk.type})`);
        // Seed quiz answer is choice 0; tap checks take an empty response.
        const response = chk.type === 'quiz' ? { choice_idx: 0 } : {};
        ar = await api('POST', `/v1/watch/${sid}/attention`, { check_id: chk.id, response }, headers);
        if (!ar.json.data?.passed) throw new Error(`attention check failed: ${JSON.stringify(ar.json)}`);
        console.log('[e2e] attention check passed');
      }
      answered.add(chk.id);
    }
  }

  // --- Completion ---
  r = await api('POST', `/v1/watch/${sid}/complete`, {}, headers);
  if (r.json.data?.status !== 'completed') throw new Error(`complete failed: ${JSON.stringify(r.json)}`);
  const credited = r.json.data.credited_cents;
  console.log(`[e2e] completed — credited ${credited}c`);

  // Idempotent re-complete.
  r = await api('POST', `/v1/watch/${sid}/complete`, {}, headers);
  if (r.json.data?.status !== 'completed' || r.json.data?.credited_cents !== credited) {
    throw new Error('double-complete not idempotent');
  }
  console.log('[e2e] double-complete idempotent OK');

  // --- Wallet ---
  r = await api('GET', '/v1/wallet', undefined, headers);
  console.log(`[e2e] wallet: balance=${r.json.data.balance_cents}c pending=${r.json.data.pending_payout_cents}c lifetime=${r.json.data.lifetime_earned_cents}c`);

  // --- Receipt ---
  r = await api('GET', `/v1/watch/${sid}/receipt`, undefined, headers);
  if (!r.json.data?.receipt) throw new Error('no receipt');
  console.log(`[e2e] receipt: watched ${r.json.data.receipt.watched_pct}% attention ${r.json.data.receipt.attention_score}%`);

  // --- Payout: temporarily lower the $1.00 min via admin config ---
  await signInAs(ADMIN_PHONE);
  r = await api('PUT', '/v1/admin/config', { key: 'min_payout_cents', value: String(credited) });
  if (r.status !== 200) throw new Error(`config set failed: ${JSON.stringify(r.json)}`);
  console.log(`[e2e] admin lowered min_payout_cents to ${credited} for the test`);

  await signInAs(PHONE);
  const idemKey = crypto.randomUUID();
  r = await api('POST', '/v1/payouts', {
    method: 'mpesa',
    destination: { msisdn: '+254712345678' },
    amount_cents: credited,
    idempotency_key: idemKey,
  }, headers);
  if (r.status !== 201) throw new Error(`payout request failed: ${JSON.stringify(r.json)}`);
  const payoutId = r.json.data.payout.id as string;
  console.log(`[e2e] payout requested: ${payoutId} (fee ${r.json.data.payout.fee_cents}c)`);

  // Double-POST same idempotency key → one payout.
  r = await api('POST', '/v1/payouts', {
    method: 'mpesa', destination: { msisdn: '+254712345678' },
    amount_cents: credited, idempotency_key: idemKey,
  }, headers);
  if (r.json.data?.payout?.id !== payoutId) throw new Error('idempotency key created a second payout!');
  console.log('[e2e] payout idempotency OK');

  // --- Admin approves; cron processes; mock adapter completes ---
  await signInAs(ADMIN_PHONE);
  r = await api('POST', `/v1/admin/payouts/${payoutId}/decision`, { approve: true, note: 'e2e test' });
  if (r.status !== 200) throw new Error(`approve failed: ${JSON.stringify(r.json)}`);
  console.log('[e2e] admin approved payout');

  r = await api('POST', '/v1/_dev/cron', {});
  console.log(`[e2e] cron: ${JSON.stringify(r.json.data)}`);

  await signInAs(PHONE);
  r = await api('GET', `/v1/payouts/${payoutId}`, undefined, headers);
  const payout = r.json.data.payout;
  if (payout.status !== 'completed') throw new Error(`payout not completed: ${payout.status}`);
  console.log(`[e2e] payout completed. attempts: ${JSON.stringify(r.json.data.attempts.map((a: any) => a.response))}`);

  // Restore the $1.00 min.
  await signInAs(ADMIN_PHONE);
  await api('PUT', '/v1/admin/config', { key: 'min_payout_cents', value: '100' });

  console.log('\n[e2e] ALL CHECKS PASSED ✔');
}

main().catch((err) => { console.error('[e2e] FAILED:', err.message); process.exit(1); });

export {};
