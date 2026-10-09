// R2 upload URL minting.
// Production (Workers with R2_S3_* secrets): real SigV4 presigned PUT URLs
// against the R2 S3-compatible endpoint — bytes go browser→R2 directly.
// Local dev (no R2_S3 secrets): HMAC-signed URL pointing at the local shim
// upload endpoint (POSTed bytes land in ./data/r2). Same flow, zero spend.
import { hmacSha256Hex } from './crypto.js';
import type { Env } from '../types.js';

export interface UploadGrant {
  uploadUrl: string;
  r2Key: string;
  method: 'PUT' | 'POST';
  expiresAt: number;
}

/** True SigV4 presigned PUT for R2's S3-compatible API. */
export async function presignR2Put(env: Env, r2Key: string, contentType: string): Promise<UploadGrant> {
  const endpoint = env.R2_S3_ENDPOINT!;
  const accessKey = env.R2_S3_ACCESS_KEY_ID!;
  const secretKey = env.R2_S3_SECRET_ACCESS_KEY!;
  const bucket = env.R2_S3_BUCKET!;
  const region = env.R2_S3_REGION ?? 'auto';

  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(endpoint).host;
  const expiresAt = Math.floor(now.getTime() / 1000) + 900;

  const canonicalUri = `/${bucket}/${r2Key}`;
  const credential = `${accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'content-type;host',
  });
  const canonicalQuery = params.toString();
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\n`;
  const canonicalRequest = [
    'PUT', canonicalUri, canonicalQuery, canonicalHeaders, 'content-type;host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const enc = new TextEncoder();
  const hashHex = async (s: string) => {
    const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const hmac = async (key: ArrayBuffer | Uint8Array, msg: string) => {
    const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  };
  const kDate = await hmac(enc.encode('AWS4' + secretKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, `${dateStamp}/${region}/s3/aws4_request`, await hashHex(canonicalRequest)].join('\n');
  const signatureBytes = await hmac(kSigning, stringToSign);
  const signature = [...signatureBytes].map((b) => b.toString(16).padStart(2, '0')).join('');

  return {
    uploadUrl: `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    r2Key, method: 'PUT', expiresAt,
  };
}

/** Local-dev shim: HMAC-signed URL for the in-process upload endpoint. */
export async function localUploadGrant(env: Env, r2Key: string, videoId: string): Promise<UploadGrant> {
  const expiresAt = Math.floor(Date.now() / 1000) + 900;
  const sig = await hmacSha256Hex(env.OTP_PEPPER, `upload:${r2Key}:${videoId}:${expiresAt}`);
  const params = new URLSearchParams({ key: r2Key, video: videoId, exp: String(expiresAt), sig });
  return { uploadUrl: `/v1/_local-upload?${params.toString()}`, r2Key, method: 'PUT', expiresAt };
}

export function hasR2S3(env: Env): boolean {
  return !!(env.R2_S3_ENDPOINT && env.R2_S3_ACCESS_KEY_ID && env.R2_S3_SECRET_ACCESS_KEY && env.R2_S3_BUCKET);
}

export async function mintUploadGrant(
  env: Env, r2Key: string, videoId: string, contentType: string
): Promise<UploadGrant> {
  if (hasR2S3(env)) return presignR2Put(env, r2Key, contentType);
  return localUploadGrant(env, r2Key, videoId);
}

/** Verify the local shim's HMAC signature (called by the upload endpoint). */
export async function verifyLocalUploadSig(
  env: Env, r2Key: string, videoId: string, exp: string, sig: string
): Promise<boolean> {
  if (Math.floor(Date.now() / 1000) > Number(exp)) return false;
  const expected = await hmacSha256Hex(env.OTP_PEPPER, `upload:${r2Key}:${videoId}:${exp}`);
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}
