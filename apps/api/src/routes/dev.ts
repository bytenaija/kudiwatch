// Dev-only routes. NOT mounted when ENV_NAME=prod.
import { Hono } from 'hono';
import type { Env, ReqVars } from '../types.js';
import { ok, fail, type AppContext } from '../lib/http.js';
import { queryAll } from '../lib/db.js';
import { getLastDevOtp } from '../lib/sms.js';
import { runCrons } from '../lib/cron.js';

const app = new Hono<{ Bindings: Env; Variables: ReqVars }>();

app.get('/last-otp', async (c: AppContext) => {
  const phone = c.req.query('phone');
  if (!phone) return fail(c, 'bad_request', 'phone query param required.');
  const code = await getLastDevOtp(c.env.DB, phone);
  if (!code) return fail(c, 'not_found', 'No OTP issued for that number yet.', 404);
  return ok(c, { phone_e164: phone, code, warning: 'dev-only: never exposed in prod' });
});

app.get('/fraud', async (c: AppContext) => {
  const rows = await queryAll(
    c.env.DB,
    'SELECT id, user_id, session_id, signal_type, severity, created_at FROM fraud_signals ORDER BY created_at DESC LIMIT 50');
  return ok(c, { signals: rows });
});

app.post('/cron', async (c: AppContext) => {
  const res = await runCrons(c.env);
  return ok(c, res);
});

export default app;
