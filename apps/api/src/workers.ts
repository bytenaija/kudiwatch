// Cloudflare Workers entrypoint for REAL deploys (wrangler.toml main).
// Local dev uses apps/api/src/local/server.ts instead (no account needed).
import { createApp, scheduled } from './index.js';
import type { Env } from './types.js';
import { D1Adapter } from './local/prod-bindings.js';
import { R2BucketAdapter } from './local/prod-bindings.js';

interface WorkerBindings {
  DB: D1Database;
  R2: R2Bucket;
  JWT_SECRET: string;
  WATCH_TOKEN_SECRET: string;
  OTP_PEPPER: string;
  ENV_NAME?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_S3_BUCKET?: string;
  R2_S3_REGION?: string;
}

function toEnv(b: WorkerBindings): Env {
  return {
    DB: new D1Adapter(b.DB),
    R2: new R2BucketAdapter(b.R2),
    JWT_SECRET: b.JWT_SECRET,
    WATCH_TOKEN_SECRET: b.WATCH_TOKEN_SECRET,
    OTP_PEPPER: b.OTP_PEPPER,
    ENV_NAME: b.ENV_NAME ?? 'prod',
    R2_S3_ENDPOINT: b.R2_S3_ENDPOINT,
    R2_S3_ACCESS_KEY_ID: b.R2_S3_ACCESS_KEY_ID,
    R2_S3_SECRET_ACCESS_KEY: b.R2_S3_SECRET_ACCESS_KEY,
    R2_S3_BUCKET: b.R2_S3_BUCKET,
    R2_S3_REGION: b.R2_S3_REGION,
  };
}

export default {
  async fetch(request: Request, bindings: WorkerBindings, ctx: WorkerExecutionContext): Promise<Response> {
    const env = toEnv(bindings);
    const app = createApp(env);
    // Attach real request.cf (country/ASN) for the fraud layer.
    return app.fetch(request, env, ctx as unknown as never);
  },
  async scheduled(_event: ScheduledEvent, bindings: WorkerBindings, _ctx: WorkerExecutionContext): Promise<void> {
    await scheduled(toEnv(bindings));
  },
};
