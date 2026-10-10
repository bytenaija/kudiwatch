// KudiWatch API — Hono app factory. Workers-compatible: no Node APIs here.
// Local dev wires Env via apps/api/src/local/server.ts; production via wrangler.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, ReqVars } from './types.js';
import { fail, newRequestId, type AppContext } from './lib/http.js';
import { requireAuth } from './middleware.js';
import { verifyWatchToken } from './lib/tokens.js';
// (r2sign lib retained but dormant — decision #39 retired the R2 upload flow.)
import authRoutes, { meApp } from './routes/auth.js';
import watcherRoutes from './routes/watcher.js';
import advertiserRoutes from './routes/advertiser.js';
import adminRoutes from './routes/admin.js';
import devRoutes from './routes/dev.js';
import { runCrons } from './lib/cron.js';

export function createApp(env: Env): Hono<{ Bindings: Env; Variables: ReqVars }> {
  const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();

  app.use('*', async (c, next) => {
    const requestId = newRequestId();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    const url = new URL(c.req.url);
    c.set('isSecure', url.protocol === 'https:');
    c.set('ip', c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim());
    c.set('userAgent', c.req.header('user-agent'));
    // Cloudflare provides request.cf on Workers; local adapter injects via header.
    const rawCf = (c.req.raw as unknown as { cf?: { asn?: unknown; country?: unknown } }).cf;
    const cfAsn = rawCf?.asn ?? c.req.header('x-cf-asn');
    const cfCountry = rawCf?.country ?? c.req.header('x-cf-country');
    if (cfAsn != null || cfCountry != null) {
      c.set('cf', {
        ...(cfAsn != null && cfAsn !== '' ? { asn: Number(cfAsn) } : {}),
        ...(cfCountry ? { country: String(cfCountry) } : {}),
      });
    }
    await next();
  });

  app.use('/v1/*', cors({
    origin: (origin) => origin, // local dev; tighten in prod
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Device-Fp'],
    credentials: true,
  }));

  app.onError((err, c) => {
    console.error(`[${c.get('requestId')}]`, err);
    return fail(c as AppContext, 'internal', 'Something went wrong. Your money is safe — nothing was lost.', 500);
  });
  app.notFound((c) => fail(c as AppContext, 'not_found', 'Not found.', 404));

  app.get('/v1/health', (c) => c.json({ data: { ok: true, env: env.ENV_NAME } }));

  // Watcher routes need auth, but a global app.use() inside the sub-app would
  // leak onto sibling mounts (/v1/_dev/*) — scope by path instead.
  const auth = requireAuth();
  for (const p of [
    '/v1/feed/*', '/v1/assignments/*', '/v1/watch/*',
    '/v1/wallet', '/v1/wallet/*', '/v1/payouts', '/v1/payouts/*',
    '/v1/me',
  ]) {
    app.use(p, auth);
  }

  app.route('/v1/auth', authRoutes);
  app.route('/v1', meApp); // GET /v1/me, PATCH /v1/me
  app.route('/v1', watcherRoutes);       // /feed, /assignments, /watch, /wallet, /payouts
  app.route('/v1/advertiser', advertiserRoutes);
  app.route('/v1/admin', adminRoutes);

  // NOTE (decision #39): the local-dev direct-upload endpoint was removed with
  // the R2 upload flow. Videos are submitted as YouTube URLs; R2 is dormant.

  if (env.ENV_NAME !== 'prod') {
    app.route('/v1/_dev', devRoutes);
  }

  return app;
}

// Workers `scheduled` entrypoint (wrangler [triggers] crons). Local dev uses setInterval.
export async function scheduled(env: Env): Promise<void> {
  const report = await runCrons(env);
  console.log('[cron]', JSON.stringify(report));
}
