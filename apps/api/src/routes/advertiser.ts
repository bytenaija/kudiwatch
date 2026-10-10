// Advertiser routes: profile, video ingest (presigned upload), funding, campaigns, reports.
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, ReqVars } from '../types.js';
import { ok, fail, pathId, pathSid, type AppContext } from '../lib/http.js';
import { nowSec, uuid, queryOne, queryAll } from '../lib/db.js';
import { getConfigNum } from '../lib/config.js';
import { postEntries, getBalance, accountIdForUser, accountIdForCampaign, MOCK_FUNDING_ACCOUNT, LedgerError } from '../lib/ledger.js';
import { MockCardAdapter } from '../lib/payouts.js';
import { extractYouTubeId, fetchYouTubeMeta } from '../lib/youtube.js';
import { requireAuth, requireRole, authedUser } from '../middleware.js';
import { recordSignal } from '../lib/fraud.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();
app.use(requireAuth());

app.post('/profile', async (c: AppContext) => {
  const user = authedUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    company_name: z.string().min(2).max(120),
    contact_email: z.string().email().max(160).optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Give your company a name (2+ characters).');

  const now = nowSec();
  const existing = await queryOne(c.env.DB, 'SELECT user_id FROM advertiser_profiles WHERE user_id = ?', user.id);
  if (!existing) {
    await c.env.DB.prepare(
      'INSERT INTO advertiser_profiles (user_id, company_name, contact_email, created_at) VALUES (?, ?, ?, ?)'
    ).bind(user.id, parsed.data.company_name.trim(), parsed.data.contact_email ?? null, now).run();
  } else {
    await c.env.DB.prepare(
      'UPDATE advertiser_profiles SET company_name = ?, contact_email = ? WHERE user_id = ?'
    ).bind(parsed.data.company_name.trim(), parsed.data.contact_email ?? null, user.id).run();
  }
  // Grant the advertiser role (idempotent).
  const roles = user.roles.includes('advertiser') ? user.roles : [...user.roles, 'advertiser'];
  await c.env.DB.prepare('UPDATE users SET roles = ? WHERE id = ?').bind(JSON.stringify(roles), user.id).run();
  return ok(c, { ok: true, roles });
});

// Everything below needs the advertiser role.
app.use(requireRole('advertiser'));

// ---------- Video ingest (YouTube) ----------
// Decision #39: advertisers submit YouTube videos by URL. No file uploads, no
// R2. Title/author come from YouTube's no-key oEmbed endpoint at submit time;
// duration is unknown until the admin reviews the embedded preview (required
// to approve). Embedding-disabled / private videos surface at playback time
// via the player's onError → /watch/:sid/player-error.

const quizSchema = z.object({
  q: z.string().min(4).max(300),
  choices: z.array(z.string().min(1).max(160)).length(4),
  answer_idx: z.number().int().min(0).max(3),
});

app.post('/videos/submit', async (c: AppContext) => {
  const user = authedUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    youtube_url: z.string().min(4).max(500),
    quiz: quizSchema.nullable().optional(),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Paste a YouTube link — watch, share, Shorts, or embed URL.');

  const ytId = extractYouTubeId(parsed.data.youtube_url);
  if (!ytId) {
    return fail(c, 'bad_url', 'That doesn\u2019t look like a YouTube video link. Check it and try again.', 422);
  }

  const dup = await queryOne<{ id: string; status: string }>(
    c.env.DB, 'SELECT id, status FROM videos WHERE advertiser_id = ? AND youtube_video_id = ?', user.id, ytId);
  if (dup) return fail(c, 'duplicate', 'You already submitted this video.', 409);

  const meta = await fetchYouTubeMeta(ytId);
  if (!meta) {
    return fail(c, 'unresolvable',
      'We couldn\u2019t reach that video on YouTube — it may be private, deleted, or the link is wrong.', 422);
  }

  const videoId = uuid();
  const now = nowSec();
  // r2_key/sha256/size_bytes are legacy NOT NULL columns, unused for YouTube
  // inventory — placeholder values keep old rows and constraints intact.
  await c.env.DB.prepare(
    `INSERT INTO videos (id, advertiser_id, r2_key, sha256, duration_s, size_bytes, status, quiz,
       youtube_video_id, youtube_title, youtube_author, created_at)
     VALUES (?, ?, ?, ?, 0, 0, 'in_review', ?, ?, ?, ?, ?)`
  ).bind(videoId, user.id, `yt:${ytId}`, `youtube:${ytId}`,
    parsed.data.quiz ? JSON.stringify(parsed.data.quiz) : null,
    ytId, meta.title, meta.author, now).run();

  return ok(c, {
    video_id: videoId,
    youtube_video_id: ytId,
    title: meta.title,
    author: meta.author,
    status: 'in_review',
    note: 'A person checks every video before it goes live.',
  }, 201);
});

app.get('/videos', async (c: AppContext) => {
  const user = authedUser(c);
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT id, youtube_video_id, youtube_title, youtube_author, duration_s, status, rejection_reason, created_at
     FROM videos WHERE advertiser_id = ? ORDER BY created_at DESC LIMIT 100`, user.id);
  return ok(c, { videos: rows });
});

// ---------- Funding (mock) ----------

app.post('/wallet/topup', async (c: AppContext) => {
  const user = authedUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    amount_cents: z.number().int().min(100),
    method: z.literal('mock_card'),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'amount_cents (≥ $1.00) and method "mock_card" required.');

  const funding = new MockCardAdapter();
  const res = await funding.topUp(user.id, parsed.data.amount_cents);
  if (!res.ok) return fail(c, 'funding_failed', res.error ?? 'Top-up failed.', 422);

  const now = nowSec();
  // Double-entry for mock money: the fake processor "owes" us (debit receivable),
  // the advertiser's wallet is credited. No real money moves — demo only.
  await postEntries(c.env.DB, `funding:${res.reference}`, [
    { accountId: MOCK_FUNDING_ACCOUNT, side: 'debit', amountCents: parsed.data.amount_cents, entryType: 'FUND_TOPUP', refType: 'funding', refId: res.reference, memo: 'Mock card receivable (demo money — no real charge)' },
    { accountId: accountIdForUser(user.id), side: 'credit', amountCents: parsed.data.amount_cents, entryType: 'FUND_TOPUP', refType: 'funding', refId: res.reference, memo: 'Mock card top-up (demo money — no real charge)' },
  ], now);

  return ok(c, {
    balance_cents: await getBalance(c.env.DB, accountIdForUser(user.id)),
    reference: res.reference,
    mock: true,
  });
});

app.get('/wallet', async (c: AppContext) => {
  const user = authedUser(c);
  return ok(c, { balance_cents: await getBalance(c.env.DB, accountIdForUser(user.id)) });
});

// ---------- Campaigns ----------

const targetingSchema = z.object({
  countries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(50).default([]),
  device: z.enum(['any', 'android', 'ios']).default('any'),
  languages: z.array(z.string().max(16)).max(20).default([]),
});

app.post('/campaigns', async (c: AppContext) => {
  const user = authedUser(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({
    video_id: z.string().uuid(),
    title: z.string().min(3).max(120),
    price_per_view_cents: z.number().int().min(1).max(3),
    advertiser_cpc_cents: z.number().int().min(1).max(100),
    budget_cents: z.number().int().min(100),
    targeting: targetingSchema.optional(),
    daily_cap: z.number().int().min(1).max(100000).default(1000),
    per_user_cap: z.number().int().min(1).max(100).default(1),
    starts_at: z.number().int().optional(),
    ends_at: z.number().int().optional(),
    priority: z.number().int().min(0).max(100).default(0),
  }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'Check the campaign fields and try again.');

  const d = parsed.data;
  if (d.advertiser_cpc_cents < d.price_per_view_cents) {
    return fail(c, 'bad_price', 'What you pay per view must be at least what the watcher earns.', 422);
  }

  const video = await queryOne<{ id: string; advertiser_id: string; status: string }>(
    c.env.DB, 'SELECT id, advertiser_id, status FROM videos WHERE id = ?', d.video_id);
  if (!video || video.advertiser_id !== user.id) return fail(c, 'not_found', 'Video not found.', 404);
  if (video.status !== 'approved') {
    return fail(c, 'video_not_approved', `Video is ${video.status} — campaigns need an approved video.`, 422);
  }

  const now = nowSec();
  const campaignId = uuid();
  const escrowGroup = `escrow:${campaignId}`;
  try {
    await postEntries(c.env.DB, escrowGroup, [
      { accountId: accountIdForUser(user.id), side: 'debit', amountCents: d.budget_cents, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: `Escrow for campaign "${d.title}"` },
      { accountId: accountIdForCampaign(campaignId), side: 'credit', amountCents: d.budget_cents, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: `Escrow for campaign "${d.title}"` },
    ], now);
  } catch (err) {
    if (err instanceof LedgerError && err.code === 'insufficient_funds') {
      return fail(c, 'insufficient_funds', 'Your advertiser balance does not cover that budget. Top up first.', 422);
    }
    throw err;
  }

  await c.env.DB.prepare(
    `INSERT INTO campaigns
       (id, advertiser_id, video_id, title, price_per_view_cents, advertiser_cpc_cents,
        budget_cents, status, targeting, daily_cap, per_user_cap, starts_at, ends_at, priority, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?)`
  ).bind(campaignId, user.id, d.video_id, d.title.trim(), d.price_per_view_cents,
    d.advertiser_cpc_cents, d.budget_cents, JSON.stringify(d.targeting ?? {}),
    d.daily_cap, d.per_user_cap, d.starts_at ?? null, d.ends_at ?? null, d.priority, now).run();

  return ok(c, {
    campaign: { id: campaignId, status: 'live', escrowed_cents: d.budget_cents },
    spread_note: `You pay $${(d.advertiser_cpc_cents / 100).toFixed(2)} per completed view. The watcher gets $${(d.price_per_view_cents / 100).toFixed(2)}. KudiWatch keeps $${((d.advertiser_cpc_cents - d.price_per_view_cents) / 100).toFixed(2)}.`,
  }, 201);
});

app.get('/campaigns', async (c: AppContext) => {
  const user = authedUser(c);
  const rows = await queryAll<Record<string, unknown>>(
    c.env.DB, 'SELECT * FROM campaigns WHERE advertiser_id = ? ORDER BY created_at DESC LIMIT 100', user.id);
  return ok(c, { campaigns: rows });
});

app.patch('/campaigns/:id', async (c: AppContext) => {
  const user = authedUser(c);
  const campaignId = pathId(c);
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ status: z.enum(['paused', 'live', 'ended']) }).safeParse(body);
  if (!parsed.success) return fail(c, 'bad_request', 'status must be paused, live, or ended.');

  const campaign = await queryOne<{ id: string; advertiser_id: string; status: string; budget_cents: number; spent_cents: number }>(
    c.env.DB, 'SELECT * FROM campaigns WHERE id = ?', campaignId);
  if (!campaign || campaign.advertiser_id !== user.id) return fail(c, 'not_found', 'Campaign not found.', 404);

  const now = nowSec();
  if (parsed.data.status === 'ended' && campaign.status !== 'ended') {
    // Release unspent escrow back to the advertiser.
    const unspent = campaign.budget_cents - campaign.spent_cents;
    if (unspent > 0) {
      await postEntries(c.env.DB, `escrow-release:${campaignId}`, [
        { accountId: accountIdForCampaign(campaignId), side: 'debit', amountCents: unspent, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: 'Unspent escrow released' },
        { accountId: accountIdForUser(user.id), side: 'credit', amountCents: unspent, entryType: 'CAMPAIGN_ESCROW', refType: 'campaign', refId: campaignId, memo: 'Unspent escrow released' },
      ], now);
    }
    // Platform margin (the spread) sweeps to platform:fees.
    const remaining = await getBalance(c.env.DB, accountIdForCampaign(campaignId));
    if (remaining > 0) {
      await postEntries(c.env.DB, `platform-fee:${campaignId}`, [
        { accountId: accountIdForCampaign(campaignId), side: 'debit', amountCents: remaining, entryType: 'PLATFORM_FEE', refType: 'campaign', refId: campaignId, memo: 'Platform margin sweep' },
        { accountId: 'platform:fees', side: 'credit', amountCents: remaining, entryType: 'PLATFORM_FEE', refType: 'campaign', refId: campaignId, memo: 'Platform margin sweep' },
      ], now);
    }
  }
  if (parsed.data.status === 'live' && campaign.status === 'paused') {
    // Resume only if budget remains.
    const remaining = campaign.budget_cents - campaign.spent_cents;
    if (remaining <= 0) return fail(c, 'budget_exhausted', 'No budget left to resume with.', 422);
  }

  await c.env.DB.prepare('UPDATE campaigns SET status = ? WHERE id = ?').bind(parsed.data.status, campaignId).run();
  return ok(c, { campaign: { id: campaignId, status: parsed.data.status } });
});

app.get('/campaigns/:id/report', async (c: AppContext) => {
  const user = authedUser(c);
  const campaignId = pathId(c);
  const campaign = await queryOne<Record<string, unknown>>(
    c.env.DB, 'SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?', campaignId, user.id);
  if (!campaign) return fail(c, 'not_found', 'Campaign not found.', 404);

  const sessions = await queryAll<{
    id: string; status: string; watched_pct: number; attention_score: number | null; ended_at: number | null; device_fp: string | null;
  }>(c.env.DB,
    `SELECT ws.id, ws.status, ws.watched_pct, ws.attention_score, ws.ended_at, ws.device_fp, u.country_code
     FROM watch_sessions ws JOIN users u ON u.id = ws.user_id
     WHERE ws.campaign_id = ?`, campaignId);

  const completed = sessions.filter((s) => s.status === 'completed');
  const views = sessions.length;
  const completionRate = views > 0 ? Math.round((completed.length / views) * 1000) / 10 : 0;
  const avgAttention = completed.length > 0
    ? Math.round((completed.reduce((s, x) => s + (x.attention_score ?? 0), 0) / completed.length) * 100)
    : null;

  const byCountry: Record<string, number> = {};
  for (const s of completed) {
    const cc = (s as unknown as { country_code: string }).country_code ?? '??';
    byCountry[cc] = (byCountry[cc] ?? 0) + 1;
  }

  return ok(c, {
    campaign: {
      id: campaign.id, title: campaign.title, status: campaign.status,
      budget_cents: campaign.budget_cents, spent_cents: campaign.spent_cents,
      reserved_cents: campaign.reserved_cents,
      remaining_cents: Number(campaign.budget_cents) - Number(campaign.spent_cents),
    },
    views, completions: completed.length, completion_rate_pct: completionRate,
    avg_attention_pct: avgAttention,
    by_country: byCountry,
  });
});

app.get('/campaigns/:id/receipts', async (c: AppContext) => {
  const user = authedUser(c);
  const campaignId = pathId(c);
  const campaign = await queryOne<{ id: string }>(
    c.env.DB, 'SELECT id FROM campaigns WHERE id = ? AND advertiser_id = ?', campaignId, user.id);
  if (!campaign) return fail(c, 'not_found', 'Campaign not found.', 404);

  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const sessions = await queryAll<Record<string, unknown>>(
    c.env.DB,
    `SELECT ws.id AS session_id, ws.watched_pct, ws.attention_score, ws.ended_at AS completed_at,
            u.country_code AS country,
            (SELECT COUNT(*) FROM attention_checks ac WHERE ac.session_id = ws.id AND ac.passed = 1) AS checks_passed,
            (SELECT COUNT(*) FROM attention_checks ac WHERE ac.session_id = ws.id) AS checks_total
     FROM watch_sessions ws JOIN users u ON u.id = ws.user_id
     WHERE ws.campaign_id = ? AND ws.status = 'completed'
     ORDER BY ws.ended_at DESC LIMIT ?`, campaignId, limit);

  if (c.req.query('format') === 'csv') {
    const header = 'session_id,watched_pct,attention_pct,checks_passed,checks_total,country,completed_at\n';
    const lines = sessions.map((s) =>
      [s.session_id, s.watched_pct, s.attention_score == null ? '' : Math.round(Number(s.attention_score) * 100),
       s.checks_passed, s.checks_total, s.country,
       s.completed_at ? new Date(Number(s.completed_at) * 1000).toISOString() : ''].join(','));
    return new Response(header + lines.join('\n') + '\n', {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="receipts-${campaignId}.csv"` },
    });
  }
  return ok(c, { receipts: sessions });
});

export default app;
