// Token-validated video streaming. R2 is private — every byte flows through
// here after watch-token validation (anti-hotlink/anti-rip boundary).
// Supports Range requests (206 partial content) for seeking.
import { Hono } from 'hono';
import type { Env, ReqVars } from '../types.js';
import { fail, type AppContext } from '../lib/http.js';
import { queryOne } from '../lib/db.js';
import { verifyWatchToken } from '../lib/tokens.js';
import { parseRangeHeader as parseRange } from '../lib/r2.js';
import { recordSignal } from '../lib/fraud.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();

app.get('/:videoId', async (c: AppContext) => {
  const videoId = c.req.param('videoId') as string;
  const token = c.req.query('wt');
  if (!token) return fail(c, 'unauthorized', 'A watch token is required.', 401);

  const claims = await verifyWatchToken(c.env.WATCH_TOKEN_SECRET, token);
  if (!claims) return fail(c, 'unauthorized', 'Watch token invalid or expired.', 401);
  if (claims.vid !== videoId) return fail(c, 'forbidden', 'Token is for a different video.', 403);

  const session = await queryOne<{
    id: string; user_id: string; status: string; token_jti: string; video_id: string; bytes_served: number; duration_s: number;
  }>(c.env.DB, 'SELECT id, user_id, status, token_jti, video_id, bytes_served, duration_s FROM watch_sessions WHERE id = ?', claims.sid);
  if (!session || session.token_jti !== claims.jti) {
    return fail(c, 'forbidden', 'Session not found.', 403);
  }
  if (session.status !== 'active') {
    return fail(c, 'forbidden', `This watch is ${session.status}.`, 403);
  }
  // Device binding is a signal, not a hard fail (fingerprints drift on cheap Androids).
  const reqFp = c.req.header('x-device-fp');
  if (reqFp && claims.fp !== 'unknown') {
    const { sha256Hex } = await import('../lib/crypto.js');
    const fpHash = await sha256Hex(reqFp);
    if (fpHash !== claims.fp) {
      await recordSignal(c.env.DB, claims.sub, 'device_change', 'low', { session_id: session.id });
    }
  }

  const video = await queryOne<{ r2_key: string; status: string }>(
    c.env.DB, 'SELECT r2_key, status FROM videos WHERE id = ?', videoId);
  if (!video) return fail(c, 'not_found', 'Video not found.', 404);

  const head = await c.env.R2.head(video.r2_key);
  if (!head) return fail(c, 'not_found', 'Video bytes missing.', 404);
  const size = head.size;

  const range = parseRange(c.req.header('range'), size);
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = end - start + 1;

  const obj = await c.env.R2.get(video.r2_key, { offset: start, length });
  if (!obj || !obj.body) return fail(c, 'not_found', 'Video bytes missing.', 404);

  // Ripper signal: bytes served > 3× duration×bitrate estimate.
  const newBytes = session.bytes_served + length;
  await c.env.DB.prepare('UPDATE watch_sessions SET bytes_served = ? WHERE id = ?').bind(newBytes, session.id).run();
  const estBytes = Math.max(1, session.duration_s * 200_000); // ~1.6 Mbps ceiling estimate
  if (newBytes > estBytes * 3) {
    await recordSignal(c.env.DB, claims.sub, 'ripper', 'high',
      { session_id: session.id, bytes_served: newBytes, est_bytes: estBytes });
  }

  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Type': head.contentType ?? 'video/mp4',
    'Content-Length': String(length),
  };
  if (range) {
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(obj.body as unknown as BodyInit, { status: 206, headers });
  }
  return new Response(obj.body as unknown as BodyInit, { status: 200, headers });
});

export default app;
