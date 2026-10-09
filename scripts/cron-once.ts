// Run cron tasks once against the local DB (no server needed).
// Usage: npm run cron
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../apps/api/src/local/sqlite.js';
import { FsR2Adapter } from '../apps/api/src/local/r2fs.js';
import { runCrons } from '../apps/api/src/lib/cron.js';
import type { Env } from '../apps/api/src/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DATA = path.join(ROOT, 'data');

async function main(): Promise<void> {
  const env: Env = {
    DB: openDatabase(process.env.KW_DB ?? path.join(DATA, 'kudiwatch.db')),
    R2: new FsR2Adapter(path.join(DATA, 'r2')),
    JWT_SECRET: 'dev-jwt-secret-change-me',
    WATCH_TOKEN_SECRET: 'dev-watch-secret-change-me',
    OTP_PEPPER: 'dev-otp-pepper-change-me',
    ENV_NAME: 'local',
  };
  const report = await runCrons(env);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });

export {};
