// Shared API types: Env (bindings + secrets) and per-request context vars.
import type { DbAdapter } from './lib/db.js';
import type { R2Adapter } from './lib/r2.js';

export interface CfInfo {
  asn?: number;
  country?: string;
}

export interface Env {
  DB: DbAdapter;
  R2: R2Adapter;
  JWT_SECRET: string;
  WATCH_TOKEN_SECRET: string;
  OTP_PEPPER: string;
  /** 'local' | 'preview' | 'prod'. Dev routes mount unless prod. */
  ENV_NAME: string;
  /** Optional S3-compatible credentials for real presigned R2 uploads (prod). */
  R2_S3_ENDPOINT?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_S3_BUCKET?: string;
  R2_S3_REGION?: string;
}

export interface ReqVars {
  requestId: string;
  userId?: string;
  userRoles?: string[];
  cf?: CfInfo;
  ip?: string;
  userAgent?: string;
  isSecure: boolean;
  sessionCreatedAt?: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; request_id: string };
}

export type AuthedUser = {
  id: string;
  phone_e164: string;
  country_code: string;
  display_name: string;
  roles: string[];
  status: string;
};
