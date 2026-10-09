// Local dev server: Hono app + node:sqlite + filesystem R2 shim + static web files.
// Zero Cloudflare account, zero spend: `npm run dev` → http://127.0.0.1:8787
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp, scheduled } from '../index.js';
import { openDatabase } from './sqlite.js';
import { FsR2Adapter } from './r2fs.js';
import type { Env } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..', '..'); // ~/workspace/kudiwatch
const DATA = path.join(ROOT, 'data');
const DB_PATH = process.env.KW_DB ?? path.join(DATA, 'kudiwatch.db');
const R2_DIR = path.join(DATA, 'r2');
const WEB_DIR = path.join(ROOT, 'apps', 'web', 'dist', 'client');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
};

async function applyMigrations(db: ReturnType<typeof openDatabase>): Promise<void> {
  const migDir = path.join(ROOT, 'db', 'migrations');
  const files = (await fs.readdir(migDir)).filter((f) => f.endsWith('.sql')).sort();
  await db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER)`);
  for (const f of files) {
    const done = await db.prepare('SELECT 1 FROM _migrations WHERE name = ?').bind(f).first();
    if (done) continue;
    const sql = await fs.readFile(path.join(migDir, f), 'utf8');
    await db.exec(sql);
    await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').bind(f, Math.floor(Date.now() / 1000)).run();
    console.log(`[db] applied migration ${f}`);
  }
  // Static seed (config + ASN reputation) — idempotent.
  const seedSql = await fs.readFile(path.join(ROOT, 'db', 'seed.sql'), 'utf8');
  await db.exec(seedSql);
}

async function serveStatic(pathname: string): Promise<Response | null> {
  let rel = decodeURIComponent(pathname);
  if (rel.includes('..')) return null;
  if (rel === '/') rel = '/index.html';
  let file = path.join(WEB_DIR, rel);
  // Directory → index.html (e.g. /app/ → /app/index.html)
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.html');
  } catch { /* fall through to 404 check */ }
  // SPA-ish fallback for known app prefixes without extension
  if (!path.extname(file)) {
    const tryIndex = file + '/index.html';
    try { await fs.stat(tryIndex); file = tryIndex; } catch { /* 404 below */ }
  }
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) throw new Error('not a file');    const ext = path.extname(file).toLowerCase();
    // Never serve .mp4 from the web dir as video cache — videos stream via /v1/stream only.
    const body = await fs.readFile(file);
    return new Response(body, { headers: { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  } catch {
    // SPA fallback: extensionless deep links (e.g. /app/watch) serve the shell.
    if (!path.extname(pathname)) {
      try {
        const body = await fs.readFile(path.join(WEB_DIR, 'index.html'));
        return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
      } catch { /* fall through */ }
    }
    return null;
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DATA, { recursive: true });
  await fs.mkdir(R2_DIR, { recursive: true });

  const db = openDatabase(DB_PATH);
  await applyMigrations(db);

  const env: Env = {
    DB: db,
    R2: new FsR2Adapter(R2_DIR),
    JWT_SECRET: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me',
    WATCH_TOKEN_SECRET: process.env.WATCH_TOKEN_SECRET ?? 'dev-watch-secret-change-me',
    OTP_PEPPER: process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me',
    ENV_NAME: 'local',
  };

  const app = createApp(env);

  // Static web files (landing + PWA + advertiser + admin) — everything not /v1.
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).pathname.startsWith('/v1')) return next();
    const res = await serveStatic(new URL(c.req.url).pathname);
    if (res) return res;
    return next();
  });

  const port = Number(process.env.PORT ?? 8787);
  console.log(`[kudiwatch] local dev: http://127.0.0.1:${port}`);
  console.log(`[kudiwatch] db: ${DB_PATH}`);
  console.log(`[kudiwatch] r2 shim: ${R2_DIR}`);

  // Cron tick every 60 s (expiry, payouts, retention).
  const tick = async () => {
    try { await scheduled(env); } catch (err) { console.error('[cron] failed', err); }
  };
  setInterval(tick, 60_000);

  // @hono/node-server calls fetch(request) with no env — inject it here.
  serve({ fetch: (request: Request) => app.fetch(request, env), port, hostname: '127.0.0.1' });
}

main().catch((err) => { console.error(err); process.exit(1); });
