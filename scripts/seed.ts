// Seed: demo admin, advertiser (+funded campaign + approved videos), watcher accounts.
// Idempotent-ish: skips creation when the seed marker user exists, but always
// ensures videos/campaign are present. Dev-only demo data.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../apps/api/src/local/sqlite.js';
import { postEntries, accountIdForUser, accountIdForCampaign, MOCK_FUNDING_ACCOUNT, getBalance } from '../apps/api/src/lib/ledger.js';
import { nowSec, uuid } from '../apps/api/src/lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = process.env.KW_DB ?? path.join(DATA, 'kudiwatch.db');

const ADMIN_PHONE = '+10000000001';
const ADV_PHONE = '+10000000002';
const WATCHERS = [
  { phone: '+15551230001', name: 'Adaeze', cc: 'NG' },
  { phone: '+15551230002', name: 'Brian', cc: 'KE' },
  { phone: '+15551230003', name: 'Chidi', cc: 'NG' },
];

// Decision #39: seed inventory is YouTube videos. IDs are real (oEmbed-verified);
// durations are demo-declared for fast local e2e (the real videos are longer) —
///staging is never seeded; the founder supplies real videos there.
const VIDEOS = [
  { yt: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', author: 'Rick Astley', duration: 30, quiz: null as null | object },
  {
    yt: '9bZkp7q19f0', title: 'PSY - GANGNAM STYLE M/V', author: 'officialpsy', duration: 75,
    quiz: {
      q: 'What was this ad about?',
      choices: ['A summer sale', 'A new phone', 'A football match', 'A cooking show'],
      answer_idx: 0,
    },
  },
  { yt: 'aqz-KE-bpKQ', title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film', author: 'Blender', duration: 120, quiz: null },
];

async function ensureUser(db: ReturnType<typeof openDatabase>, phone: string, name: string, cc: string, roles: string[]): Promise<string> {
  const existing = await db.prepare('SELECT id FROM users WHERE phone_e164 = ?').bind(phone).first<{ id: string }>();
  if (existing) return existing.id;
  const id = uuid();
  const now = nowSec();
  await db.prepare(
    `INSERT INTO users (id, phone_e164, phone_verified_at, country_code, display_name, roles, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(id, phone, now, cc, name, JSON.stringify(roles), now, now).run();
  return id;
}

async function main(): Promise<void> {
  await fs.mkdir(DATA, { recursive: true });
  const db = openDatabase(DB_PATH);

  // Ensure schema (same as server).
  const migDir = path.join(ROOT, 'db', 'migrations');
  const files = (await fs.readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();
  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)');
  for (const f of files) {
    const done = await db.prepare('SELECT 1 FROM _migrations WHERE name = ?').bind(f).first();
    if (done) continue;
    await db.exec(await fs.readFile(path.join(migDir, f), 'utf8'));
    await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(f, nowSec()).run();
  }
  await db.exec(await fs.readFile(path.join(ROOT, 'db', 'seed.sql'), 'utf8'));

  const now = nowSec();

  const adminId = await ensureUser(db, ADMIN_PHONE, 'Admin', 'NG', ['watcher', 'admin']);
  const advId = await ensureUser(db, ADV_PHONE, 'Demo Brand', 'NG', ['watcher', 'advertiser']);
  const watcherIds: string[] = [];
  for (const w of WATCHERS) watcherIds.push(await ensureUser(db, w.phone, w.name, w.cc, ['watcher']));

  await db.prepare(
    `INSERT OR IGNORE INTO advertiser_profiles (user_id, company_name, contact_email, created_at)
     VALUES (?, 'Demo Brand Ltd', 'demo@demo-brand.example', ?)`
  ).bind(advId, now).run();

  // Fund the advertiser with $250 mock money (if balance is low).
  const advBal = await getBalance(db, accountIdForUser(advId));
  if (advBal < 25000) {
    const ref = `SEED-${uuid().slice(0, 8).toUpperCase()}`;
    await postEntries(db, `funding:${ref}`, [
      { accountId: MOCK_FUNDING_ACCOUNT, side: 'debit', amountCents: 25000, entryType: 'FUND_TOPUP', refType: 'funding', refId: ref, memo: 'Seed funding (demo money)' },
      { accountId: accountIdForUser(advId), side: 'credit', amountCents: 25000, entryType: 'FUND_TOPUP', refType: 'funding', refId: ref, memo: 'Seed funding (demo money)' },
    ], now);
  }

  // Videos: YouTube inventory — direct insert as approved (admin-equivalent).
  const videoIds: string[] = [];
  for (const v of VIDEOS) {
    const existing = await db.prepare('SELECT id FROM videos WHERE advertiser_id = ? AND youtube_video_id = ?')
      .bind(advId, v.yt).first<{ id: string }>();
    let videoId: string;
    if (existing) {
      videoId = existing.id;
    } else {
      videoId = uuid();
      await db.prepare(
        `INSERT INTO videos (id, advertiser_id, r2_key, sha256, duration_s, size_bytes, status, quiz,
           youtube_video_id, youtube_title, youtube_author, reviewed_by, reviewed_at, created_at)
         VALUES (?, ?, ?, ?, ?, 0, 'approved', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(videoId, advId, `yt:${v.yt}`, `youtube:${v.yt}`, v.duration,
        v.quiz ? JSON.stringify(v.quiz) : null, v.yt, v.title, v.author, adminId, now, now).run();
    }
    videoIds.push(videoId);
    console.log(`[seed] video ${v.title} → ${videoId} (yt:${v.yt}, ${v.duration}s declared)`);
  }

  // Campaign: live, $10 budget, 2¢/view, targeting NG+KE.
  const existingCampaign = await db.prepare(
    `SELECT id FROM campaigns WHERE advertiser_id = ? AND title = 'Demo Brand — Summer Sale' AND status = 'live'`)
    .bind(advId).first<{ id: string }>();
  let campaignId: string;
  if (existingCampaign) {
    campaignId = existingCampaign.id;
    console.log(`[seed] campaign exists: ${campaignId}`);
  } else {
    campaignId = uuid();
    const budget = 1000; // $10.00
    await postEntries(db, `escrow:${campaignId}`, [
      { accountId: accountIdForUser(advId), side: 'debit', amountCents: budget, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: 'Seed campaign escrow' },
      { accountId: accountIdForCampaign(campaignId), side: 'credit', amountCents: budget, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: 'Seed campaign escrow' },
    ], now);
    await db.prepare(
      `INSERT INTO campaigns (id, advertiser_id, video_id, title, price_per_view_cents, advertiser_cpc_cents,
        budget_cents, status, targeting, daily_cap, per_user_cap, priority, created_at)
       VALUES (?, ?, ?, 'Demo Brand — Summer Sale', 2, 4, ?, 'live', ?, 100, 1, 0, ?)`
    ).bind(campaignId, advId, videoIds[1], budget,
      JSON.stringify({ countries: ['NG', 'KE'], device: 'any', languages: [] }), now).run();
    console.log(`[seed] campaign live: ${campaignId} ($10.00 budget, $0.02/view)`);
  }

  console.log('\n[seed] done. Demo credentials (DEV ONLY):');
  console.log(`  admin:      ${ADMIN_PHONE}  (role: admin — sign in via OTP, code from /v1/_dev/last-otp?phone=...)`);
  console.log(`  advertiser: ${ADV_PHONE}  (Demo Brand Ltd, $250 mock balance)`);
  for (const w of WATCHERS) console.log(`  watcher:    ${w.phone}  (${w.name}, ${w.cc})`);
  console.log('  OTP flow: POST /v1/auth/otp/request {phone_e164} → GET /v1/_dev/last-otp?phone=<phone> → POST /v1/auth/otp/verify');
}

main().catch((err) => { console.error(err); process.exit(1); });

export {};
