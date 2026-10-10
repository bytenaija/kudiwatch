// Assignment engine (§6): feed/next offer selection with budget pacing,
// targeting, per-user caps, velocity caps, and no-repeat rules.
import { nowSec, uuid, type DbAdapter } from './db.js';
import { getConfigNum } from './config.js';
import { checkVelocity } from './fraud.js';

export interface Targeting {
  countries?: string[];
  device?: 'any' | 'android' | 'ios';
  languages?: string[];
}

export interface FeedOffer {
  assignment: { id: string; claim_deadline: number };
  video: { id: string; duration_s: number; youtube_video_id: string | null; youtube_title: string | null };
  campaign: { id: string; title: string; price_per_view_cents: number; advertiser: string };
}

export interface FeedEmpty {
  assignment: null;
  reason: 'empty' | 'capped' | 'velocity';
}

function deviceClass(ua: string | undefined): 'android' | 'ios' | 'other' {
  const s = (ua ?? '').toLowerCase();
  if (s.includes('android')) return 'android';
  if (s.includes('iphone') || s.includes('ipad') || s.includes('ios')) return 'ios';
  return 'other';
}

function parseTargeting(raw: string): Targeting {
  try {
    const v = JSON.parse(raw);
    return {
      countries: Array.isArray(v.countries) ? v.countries : undefined,
      device: v.device === 'android' || v.device === 'ios' ? v.device : 'any',
      languages: Array.isArray(v.languages) ? v.languages : undefined,
    };
  } catch { return {}; }
}

interface CampaignCandidate {
  id: string; title: string; price_per_view_cents: number;
  video_id: string; duration_s: number; youtube_video_id: string | null; youtube_title: string | null; targeting: string;
  daily_cap: number; per_user_cap: number; priority: number;
  advertiser: string; views_today: number;
}

/**
 * Run the assignment query and pick a winner by largest pacing deficit
 * (daily_cap − views_today, weighted by priority, random tiebreak).
 * Creates the `offered` assignment row.
 */
export async function nextOffer(
  db: DbAdapter,
  userId: string,
  userCountry: string,
  opts: { ua?: string; cfCountry?: string; ip?: string }
): Promise<FeedOffer | FeedEmpty> {
  const now = nowSec();
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  const country = (opts.cfCountry || userCountry || '').toUpperCase();

  // Velocity caps first (fail fast with a clear reason).
  const maxHour = await getConfigNum(db, 'max_views_per_hour');
  const maxDay = await getConfigNum(db, 'max_views_per_day');
  const h = await checkVelocity(db, `user:${userId}:completions:3600`, 3600, maxHour);
  const d = await checkVelocity(db, `user:${userId}:completions:86400`, 86400, maxDay);
  if (!h.allowed || !d.allowed) return { assignment: null, reason: 'velocity' };

  const rows = await db.prepare(
    `SELECT c.id, c.title, c.price_per_view_cents, c.video_id, c.targeting,
            c.daily_cap, c.per_user_cap, c.priority,
            v.duration_s, v.youtube_video_id, v.youtube_title,
            COALESCE(ap.company_name, 'Advertiser') AS advertiser,
            COALESCE((SELECT SUM(views) FROM campaign_daily_spend
                      WHERE campaign_id = c.id AND day = ?), 0) AS views_today
     FROM campaigns c
     JOIN videos v ON v.id = c.video_id
     LEFT JOIN advertiser_profiles ap ON ap.user_id = c.advertiser_id
     WHERE c.status = 'live'
       AND c.advertiser_id != ?
       AND (c.starts_at IS NULL OR c.starts_at <= ?)
       AND (c.ends_at IS NULL OR c.ends_at > ?)
       AND c.spent_cents + c.reserved_cents < c.budget_cents
       AND COALESCE((SELECT SUM(views) FROM campaign_daily_spend
                     WHERE campaign_id = c.id AND day = ?), 0) < c.daily_cap
       AND NOT EXISTS (SELECT 1 FROM assignments a
                       WHERE a.campaign_id = c.id AND a.user_id = ?
                         AND a.status IN ('claimed', 'completed'))
     ORDER BY c.priority DESC LIMIT 24`
  ).bind(today, userId, now, now, today, userId).all<CampaignCandidate & { targeting: string }>();

  const skipCooldown = await getConfigNum(db, 'skip_cooldown_s');
  const dev = deviceClass(opts.ua);
  const eligible: CampaignCandidate[] = [];

  for (const c of rows.results) {
    const t = parseTargeting(c.targeting);
    if (t.countries && t.countries.length > 0 && country && !t.countries.map((x) => x.toUpperCase()).includes(country)) continue;
    if (t.device && t.device !== 'any' && dev !== 'other' && t.device !== dev) continue;

    // Per-user cap: completed views of this campaign.
    const done = await db.prepare(
      `SELECT COUNT(*) AS n FROM assignments WHERE campaign_id = ? AND user_id = ? AND status = 'completed'`
    ).bind(c.id, userId).first<{ n: number }>();
    if ((done?.n ?? 0) >= c.per_user_cap) continue;

    // Skip cooldown: a skipped assignment re-offers only after skip_cooldown_s.
    const skipped = await db.prepare(
      `SELECT offered_at FROM assignments WHERE campaign_id = ? AND user_id = ? AND status = 'skipped'
       ORDER BY offered_at DESC LIMIT 1`
    ).bind(c.id, userId).first<{ offered_at: number }>();
    if (skipped && now - skipped.offered_at < skipCooldown) continue;

    eligible.push(c);
  }

  if (eligible.length === 0) {
    // Distinguish "nothing live for you" from "you hit your caps".
    const live = await db.prepare(`SELECT COUNT(*) AS n FROM campaigns WHERE status = 'live'`)
      .first<{ n: number }>();
    return { assignment: null, reason: (live?.n ?? 0) > 0 ? 'capped' : 'empty' };
  }

  // Pacing deficit: largest (daily_cap − views_today) × (1 + priority), random tiebreak.
  let best = eligible[0]!;
  let bestScore = -Infinity;
  for (const c of eligible) {
    const score = (c.daily_cap - c.views_today) * (1 + c.priority) + Math.random();
    if (score > bestScore) { bestScore = score; best = c; }
  }

  const claimTtl = await getConfigNum(db, 'claim_ttl_s');
  const assignmentId = uuid();
  await db.prepare(
    `INSERT INTO assignments (id, campaign_id, user_id, status, offered_at, claim_deadline)
     VALUES (?, ?, ?, 'offered', ?, ?)`
  ).bind(assignmentId, best.id, userId, now, now + claimTtl).run();

  return {
    assignment: { id: assignmentId, claim_deadline: now + claimTtl },
    video: { id: best.video_id, duration_s: best.duration_s, youtube_video_id: best.youtube_video_id, youtube_title: best.youtube_title },
    campaign: { id: best.id, title: best.title, price_per_view_cents: best.price_per_view_cents, advertiser: best.advertiser },
  };
}
