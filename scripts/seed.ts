// Seed: demo admin, advertiser (+funded campaign + approved videos), watcher accounts.
// Idempotent-ish: skips creation when the seed marker user exists, but always
// ensures videos/campaign are present. Dev-only demo data.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { openDatabase } from '../apps/api/src/local/sqlite.js';
import { FsR2Adapter } from '../apps/api/src/local/r2fs.js';
import { postEntries, accountIdForUser, accountIdForCampaign, MOCK_FUNDING_ACCOUNT, getBalance } from '../apps/api/src/lib/ledger.js';
import { nowSec, uuid } from '../apps/api/src/lib/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = process.env.KW_DB ?? path.join(DATA, 'kudiwatch.db');
const R2_DIR = path.join(DATA, 'r2');

const ADMIN_PHONE = '+10000000001';
const ADV_PHONE = '+10000000002';
const WATCHERS = [
  { phone: '+15551230001', name: 'Adaeze', cc: 'NG' },
  { phone: '+15551230002', name: 'Brian', cc: 'KE' },
  { phone: '+15551230003', name: 'Chidi', cc: 'NG' },
];

const VIDEOS = [
  { file: 'demo-30s.mp4', title: 'Demo Brand — 30s spot', duration: 30, quiz: null as null | object },
  {
    file: 'demo-75s.mp4', title: 'Demo Brand — Summer Sale', duration: 75,
    quiz: {
      q: 'What was this ad about?',
      choices: ['A summer sale', 'A new phone', 'A football match', 'A cooking show'],
      answer_idx: 0,
    },
  },
  { file: 'demo-120s.mp4', title: 'Demo Brand — Brand story', duration: 120, quiz: null },
];

async function sha256File(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return createHash('sha256').update(buf).digest('hex');
}

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
  const r2 = new FsR2Adapter(R2_DIR);

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

  // Videos: copy seed MP4s into the R2 shim, mark approved.
  const videoIds: string[] = [];
  for (const v of VIDEOS) {
    const src = path.join(DATA, 'seed-videos', v.file);
    try { await fs.stat(src); } catch {
      console.error(`[seed] missing ${src} — run: npm run gen:videos`);
      process.exit(1);
    }
    const existing = await db.prepare('SELECT id, r2_key FROM videos WHERE advertiser_id = ? AND duration_s = ?')
      .bind(advId, v.duration).first<{ id: string; r2_key: string }>();
    let videoId: string;
    let r2Key: string;
    if (existing) {
      videoId = existing.id; r2Key = existing.r2_key;
    } else {
      videoId = uuid();
      r2Key = `videos/${videoId}/source.mp4`;
      await db.prepare(
        `INSERT INTO videos (id, advertiser_id, r2_key, sha256, duration_s, width, height, size_bytes, status, quiz, reviewed_by, reviewed_at, created_at)
         VALUES (?, ?, ?, ?, ?, 480, 270, ?, 'approved', ?, ?, ?, ?)`
      ).bind(videoId, advId, r2Key, await sha256File(src), v.duration,
        (await fs.stat(src)).size, v.quiz ? JSON.stringify(v.quiz) : null, adminId, now, now).run();
    }
    const bytes = await fs.readFile(src);
    await r2.put(r2Key, bytes, { contentType: 'video/mp4' });
    videoIds.push(videoId);
    console.log(`[seed] video ${v.title} → ${videoId} (${(bytes.length / 1024).toFixed(0)} KB)`);
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
