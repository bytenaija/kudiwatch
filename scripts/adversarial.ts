// Adversarial QA: scripted attacker probes against the threat model (docs/DEEPDIVE.md §13).
// Each probe either gets BLOCKED or produces review-queue flags. Run: npm run adv
// (server must be up). Uses its own phones/campaign; pauses the seed campaign first.
const BASE = process.env.KW_BASE ?? 'http://127.0.0.1:8787';
const ADMIN_PHONE = '+10000000001';
const ADV_PHONE = '+10000000002';
const RUN = Math.floor(100000 + Math.random() * 899999);
const FP = `adv-device-fingerprint-${RUN}`;
const WATCHER = `+1555${RUN}03`; // fresh phone per run (per_user_cap)

let cookies = '';
function storeCookies(res: Response): void {
  const setCookies = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
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

async function api(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookies ? { Cookie: cookies } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(res);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function signInAs(phone: string, fp = FP): Promise<void> {
  cookies = '';
  await api('POST', '/v1/auth/otp/request', { phone_e164: phone });
  const r = await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(phone)}`);
  const code = r.json.data.code as string;
  const v = await api('POST', '/v1/auth/otp/verify', {
    phone_e164: phone, code, display_name: 'Adv', country_code: 'NG',
    device: { fingerprint: fp, user_agent: 'adv-probe/1.0', platform: 'node' },
  });
  if (v.status !== 200) throw new Error(`signin failed for ${phone}: ${JSON.stringify(v.json)}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// QA-harness privilege: read the quiz answer straight from the local DB.
// The product API never exposes it (watcher.ts deletes answer_idx from payloads).
async function quizAnswerForVideo(videoId: string): Promise<number | null> {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync('data/kudiwatch.db');
    const row = db.prepare('SELECT quiz FROM videos WHERE id = ?').get(videoId) as { quiz: string | null } | undefined;
    db.close();
    if (!row?.quiz) return null;
    const q = JSON.parse(row.quiz) as { answer_idx: number };
    return typeof q.answer_idx === 'number' ? q.answer_idx : null;
  } catch { return null; }
}
let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✘ ${name} ${detail}`); }
}

async function main(): Promise<void> {
  console.log('[adv] probe 6: OTP brute force → lockout');
  {
    const phone = `+1555${RUN}901`;
    await api('POST', '/v1/auth/otp/request', { phone_e164: phone });
    let locked = false;
    for (let i = 0; i < 6; i++) {
      const r = await api('POST', '/v1/auth/otp/verify', { phone_e164: phone, code: '000000' });
      if (r.json?.error?.code === 'otp_locked') { locked = true; break; }
    }
    check('6 wrong codes → locked', locked);
    // Mitigation is the lockout itself; the otp_bruteforce signal is recorded
    // when the number belongs to an existing user (see auth.ts).
  }

  console.log('[adv] probe 4/3: stream authn');
  let seedCampaignId = '';
  {
    await signInAs(ADV_PHONE, 'adv-fp-advertiser');
    const vids = await api('GET', '/v1/advertiser/videos');
    const v30 = (vids.json.data.videos as any[]).find((v) => v.duration_s === 30);
    const vids2 = vids.json.data.videos as any[];
    check('seed videos present', vids2.length >= 3);
    // Pause the seed campaign so probes deterministically get our probe campaign.
    const camps = await api('GET', '/v1/advertiser/campaigns');
    const allCamps = camps.json.data.campaigns as any[];
    const seedCamp = allCamps.find((c) => c.title.includes('Summer Sale'));
    seedCampaignId = seedCamp.id;
    await api('PATCH', `/v1/advertiser/campaigns/${seedCampaignId}`, { status: 'paused' });
    // Cleanup: pause stale probe campaigns from earlier (possibly crashed) runs —
    // matches both the current 'ADV-PROBE-<run>' naming and the older 'ADV probe campaign'.
    for (const c of allCamps) {
      if (c.title.startsWith('ADV') && c.status === 'live') {
        await api('PATCH', `/v1/advertiser/campaigns/${c.id}`, { status: 'paused' });
      }
    }

    // Probe campaign on the 75s video: headroom for anomaly probes.
    const v75 = vids2.find((v) => v.duration_s === 75);
    const pc = await api('POST', '/v1/advertiser/campaigns', {
      video_id: v75.id, title: `ADV-PROBE-${RUN}`, price_per_view_cents: 2,
      advertiser_cpc_cents: 4, budget_cents: 500,
      targeting: { countries: ['NG', 'KE'], device: 'any', languages: [] },
      daily_cap: 1000, per_user_cap: 1,
    });
    check('probe campaign live', pc.status === 201);
    (globalThis as any).__probeCampaign = pc.json.data.campaign.id;

    const noTok = await fetch(`${BASE}/v1/stream/${v30.id}`);
    check('stream without token → 401', noTok.status === 401);
    const badTok = await fetch(`${BASE}/v1/stream/${v30.id}?wt=garbage`);
    check('stream with garbage token → 401', badTok.status === 401);
  }

  console.log('[adv] probe 9: admin cookie replay after logout');
  {
    await signInAs(ADMIN_PHONE, 'adv-fp-admin');
    const stolen = cookies;
    await api('POST', '/v1/auth/logout', {});
    const replay = await fetch(`${BASE}/v1/admin/config`, { headers: { Cookie: stolen } });
    check('replayed admin cookie after logout → 401', replay.status === 401);
  }

  console.log('[adv] probes 2/11: anomalous heartbeats, then concurrent completion');
  let sessionId = '';
  {
    // Fresh watcher on a fresh device: 75s probe campaign (70/75 = 93.3% ≥ 90%
    // even after anomaly probes burn no verified time).
    const ph = `+1555${RUN}11`;
    const fp = `adv-fp2-${RUN}`;
    await api('POST', '/v1/auth/otp/request', { phone_e164: ph });
    {
      const r = await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(ph)}`);
      await api('POST', '/v1/auth/otp/verify', {
        phone_e164: ph, code: r.json.data.code, display_name: 'AdvA', country_code: 'NG',
        device: { fingerprint: fp },
      });
    }
    const feed = await api('GET', '/v1/feed/next');
    const offer = feed.json.data;
    check('got probe offer', offer.video?.duration_s === 75, JSON.stringify(offer.video ?? null).slice(0, 120));
    const claim = await api('POST', `/v1/assignments/${offer.assignment.id}/claim`, {});
    check('claimed', claim.status === 200 || claim.status === 201, `status=${claim.status}`);
    const sid = claim.json.data.session_id as string;
    sessionId = sid;
    const checks = claim.json.data.checks as Array<{ id: string; type: string; scheduled_at_s: number }>;
    const hb = (payload: any) => api('POST', `/v1/watch/${sid}/heartbeat`, payload);

    // 8s wall gaps for +10s position jumps: window allows elapsed*1.25+2 = 12s.
    await sleep(8000);
    let r = await hb({ seq: 1, position_s: 10, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 });
    check('honest beat accepted', r.json.data.ok === true);

    await sleep(8000);
    r = await hb({ seq: 1, position_s: 10, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 });
    check('replayed seq rejected (dup_seq)', r.json.data.ok === false && r.json.data.reject_code === 'dup_seq');

    await sleep(8000);
    r = await hb({ seq: 2, position_s: 10, visible: true, playback_rate: 1.5, client_ts: Date.now() / 1000 });
    check('2x speed rejected (bad_rate)', r.json.data.ok === false && r.json.data.reject_code === 'bad_rate');

    // Hidden beat at the SAME position: rejected, no verified-time burned.
    await sleep(8000);
    r = await hb({ seq: 2, position_s: 10, visible: false, playback_rate: 1, client_ts: Date.now() / 1000 });
    check('hidden playback rejected (hidden)', r.json.data.ok === false && r.json.data.reject_code === 'hidden');

    // Honest run to 70s (seq 3..8 — the hidden beat consumed seq 2).
    for (const [seq, pos] of [[3, 20], [4, 30], [5, 40], [6, 50], [7, 60], [8, 70]] as Array<[number, number]>) {
      await sleep(8000);
      r = await hb({ seq, position_s: pos, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 });
      if (r.json.data.ok !== true) { check(`honest beat seq ${seq} accepted`, false, JSON.stringify(r.json.data).slice(0, 120)); break; }
    }
    check('session survives single anomalies', r.json.data.ok === true, JSON.stringify(r.json.data).slice(0, 100));

    // Answer due attention checks (quiz answers come from the local DB — never the API).
    const quizAnswer = await quizAnswerForVideo(offer.video.id as string);
    for (const chk of checks) {
      if (chk.scheduled_at_s > 70) continue;
      let ar = await api('POST', `/v1/watch/${sid}/attention`, { check_id: chk.id });
      if (ar.json.data?.presented) {
        const response = chk.type === 'quiz' && quizAnswer != null ? { choice_idx: quizAnswer } : {};
        ar = await api('POST', `/v1/watch/${sid}/attention`, { check_id: chk.id, response });
        check(`attention check (${chk.type}) passed`, ar.json.data?.passed === true,
          JSON.stringify(ar.json.data).slice(0, 120));
      }
    }

    // Probe 11: 20 concurrent completes → exactly one credit.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => api('POST', `/v1/watch/${sid}/complete`, {}))
    );
    const allCompleted = results.every((x) => x.json.data?.status === 'completed');
    const credits = new Set(results.map((x) => x.json.data?.credited_cents));
    check('20 concurrent completes → all completed, same credit',
      allCompleted && credits.size === 1 && credits.has(2),
      `completed=${results.filter((x) => x.json.data?.status === 'completed').length}/20 credits=${[...credits]}`);
  }

  console.log('[adv] probe 5: no-repeat (per-user cap)');
  {
    const feed = await api('GET', '/v1/feed/next');
    check('completed campaign not re-offered', feed.json.data.assignment === null,
      JSON.stringify(feed.json.data).slice(0, 120));
  }

  console.log('[adv] probe 1: multi-account device → 3rd claim blocked');
  {
    const phones = [`+1555${RUN}911`, `+1555${RUN}912`, `+1555${RUN}913`];
    let blocked = 0, okClaims = 0;
    for (const ph of phones) {
      await signInAs(ph, `adv-shared-device-${RUN}`);
      const feed = await api('GET', '/v1/feed/next');
      if (!feed.json.data.assignment) continue;
      const cl = await api('POST', `/v1/assignments/${feed.json.data.assignment.id}/claim`, {}, { 'X-Device-Fp': `adv-shared-device-${RUN}` });
      if (cl.status === 200) okClaims++;
      if (cl.json?.error?.code === 'device_blocked') blocked++;
    }
    check('first two claims allowed, third blocked', okClaims === 2 && blocked === 1, `ok=${okClaims} blocked=${blocked}`);
  }

  console.log('[adv] probe 8: clock tampering — skewed client_ts cannot inflate watched %');
  {
    const ph = `+1555${RUN}81`;
    const fp = `adv-fp8-${RUN}`;
    await api('POST', '/v1/auth/otp/request', { phone_e164: ph });
    const r = await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(ph)}`);
    await api('POST', '/v1/auth/otp/verify', {
      phone_e164: ph, code: r.json.data.code, display_name: 'AdvE', country_code: 'NG',
      device: { fingerprint: fp },
    });
    const feed = await api('GET', '/v1/feed/next');
    const offer = feed.json.data;
    if (offer.assignment) {
      const claim = await api('POST', `/v1/assignments/${offer.assignment.id}/claim`, {});
      const sid = claim.json.data.session_id as string;
      const hb = (p2: unknown) => api('POST', `/v1/watch/${sid}/heartbeat`, p2);
      await sleep(8000);
      // client_ts an hour in the future: server still validates on its own clock.
      let r2 = await hb({ seq: 1, position_s: 10, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 + 3600 });
      check('future client_ts does not break validation', r2.json.data.ok === true, JSON.stringify(r2.json.data).slice(0, 100));
      await sleep(8000);
      // client_ts an hour in the past, position jump: still judged by server elapsed.
      r2 = await hb({ seq: 2, position_s: 60, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 - 3600 });
      check('past client_ts + jump still rejected (jump)', r2.json.data.ok === false && r2.json.data.reject_code === 'jump',
        JSON.stringify(r2.json.data).slice(0, 120));
    } else {
      check('probe-8 got an offer', false, 'no assignment offered');
    }
  }

  console.log('[adv] probe 10: advertiser uploads sub-minimum video → rejected');
  {
    await signInAs(ADV_PHONE, 'adv-fp-advertiser');
    const up = await api('POST', '/v1/advertiser/videos/upload-url', {
      filename: 'tiny.mp4', size_bytes: 1000,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    const vid = up.json.data.video_id as string;
    const putUrl = 'http://127.0.0.1:8787' + up.json.data.upload_url as string;
    await fetch(putUrl, { method: 'PUT', headers: { 'Content-Type': 'video/mp4' }, body: new Uint8Array(1000) });
    const cf = await api('POST', `/v1/advertiser/videos/${vid}/confirm`, { duration_s: 5, title: 'Too short' });
    check('5s video rejected (< 15s min)', cf.status === 422 && cf.json.error?.code === 'bad_duration',
      `status=${cf.status} ${JSON.stringify(cf.json).slice(0, 100)}`);
  }

  console.log('[adv] probe 12: refund loop — forced adapter failure → exactly one refund');
  {
    await signInAs(ADMIN_PHONE, 'adv-fp-admin2');
    await api('PUT', '/v1/admin/config', { key: 'payout_mock_failure_rate', value: '1.0' });
    await api('PUT', '/v1/admin/config', { key: 'min_payout_cents', value: '2' });

    // Fresh funded watcher: full honest watch on the 75s probe campaign (70/75 = 93.3%).
    const ph = `+1555${RUN}41`;
    const fp = `adv-fp12-${RUN}`;
    await api('POST', '/v1/auth/otp/request', { phone_e164: ph });
    {
      const r = await api('GET', `/v1/_dev/last-otp?phone=${encodeURIComponent(ph)}`);
      await api('POST', '/v1/auth/otp/verify', {
        phone_e164: ph, code: r.json.data.code, display_name: 'AdvD', country_code: 'NG',
        device: { fingerprint: fp },
      });
    }
    const feed12 = await api('GET', '/v1/feed/next');
    const claim12 = await api('POST', `/v1/assignments/${feed12.json.data.assignment.id}/claim`, {});
    check('probe-12 claimed', claim12.status === 200 || claim12.status === 201, `status=${claim12.status}`);
    const sid12 = claim12.json.data.session_id as string;
    const hb12 = (p2: unknown) => api('POST', `/v1/watch/${sid12}/heartbeat`, p2);
    for (const [seq, pos] of [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50], [6, 60], [7, 70]] as Array<[number, number]>) {
      await sleep(8000);
      await hb12({ seq, position_s: pos, visible: true, playback_rate: 1, client_ts: Date.now() / 1000 });
    }
    const quizAnswer12 = await quizAnswerForVideo(feed12.json.data.video.id as string);
    for (const chk of claim12.json.data.checks as Array<{ id: string; type: string; scheduled_at_s: number }>) {
      if (chk.scheduled_at_s > 70) continue;
      let ar = await api('POST', `/v1/watch/${sid12}/attention`, { check_id: chk.id });
      if (ar.json.data?.presented) {
        const response = chk.type === 'quiz' && quizAnswer12 != null ? { choice_idx: quizAnswer12 } : {};
        ar = await api('POST', `/v1/watch/${sid12}/attention`, { check_id: chk.id, response });
      }
    }
    const done12 = await api('POST', `/v1/watch/${sid12}/complete`, {});
    check('probe-12 completed', done12.json.data?.status === 'completed', JSON.stringify(done12.json.data).slice(0, 120));
    const before = (await api('GET', '/v1/wallet')).json.data.balance_cents as number;
    const idem = crypto.randomUUID();
    const pq = await api('POST', '/v1/payouts', {
      method: 'airtime', destination: { msisdn: '+2348012345678' }, amount_cents: 2, idempotency_key: idem,
    });
    check('payout requested', pq.status === 201, `status=${pq.status} body=${JSON.stringify(pq.json).slice(0, 120)}`);
    const pid = pq.json.data.payout.id as string;
    // Destination is locked: no endpoint can change it (verify detail shows original).
    const detail = await api('GET', `/v1/payouts/${pid}`);
    check('destination locked at request', detail.json.data.payout.destination.label === '+2348012345678');

    await signInAs(ADMIN_PHONE, 'adv-fp-admin2');
    await api('POST', `/v1/admin/payouts/${pid}/decision`, { approve: true, note: 'adv probe' });
    // Probe 7: no endpoint can mutate the destination after approval.
    const patchAttempt = await api('PATCH', `/v1/payouts/${pid}`, { destination: { msisdn: '+9990000000' } });
    check('no destination-mutation endpoint (404)', patchAttempt.status === 404, `status=${patchAttempt.status}`);
    await signInAs(ph, fp);
    const postApproval = await api('GET', `/v1/payouts/${pid}`);
    check('destination unchanged after approval', postApproval.json.data?.payout?.destination?.label === '+2348012345678',
      JSON.stringify(postApproval.json.data?.payout?.destination).slice(0, 80));
    await signInAs(ADMIN_PHONE, 'adv-fp-admin2');
    for (let i = 0; i < 4; i++) await api('POST', '/v1/_dev/cron', {});

    await signInAs(ph, fp);
    const after = await api('GET', `/v1/payouts/${pid}`);
    const status = after.json.data.payout.status;
    const wallet = (await api('GET', '/v1/wallet')).json.data.balance_cents as number;
    check('failed payout → refunded, balance restored exactly once', status === 'refunded' && wallet === before,
      `status=${status} before=${before} after=${wallet}`);

    await signInAs(ADMIN_PHONE, 'adv-fp-admin2');
    await api('PUT', '/v1/admin/config', { key: 'payout_mock_failure_rate', value: '0' });
    await api('PUT', '/v1/admin/config', { key: 'min_payout_cents', value: '100' });
    // Resume seed campaign as the advertiser (admin lacks the role); park the probe campaign.
    await signInAs(ADV_PHONE, 'adv-fp-advertiser');
    await api('PATCH', `/v1/advertiser/campaigns/${seedCampaignId}`, { status: 'live' });
    await api('PATCH', `/v1/advertiser/campaigns/${(globalThis as any).__probeCampaign}`, { status: 'paused' });
  }

  console.log(`\n[adv] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  console.log('[adv] ALL ADVERSARIAL PROBES PASSED ✔');
}

main().catch((err) => { console.error('[adv] FAILED:', err); process.exit(1); });

export {};
