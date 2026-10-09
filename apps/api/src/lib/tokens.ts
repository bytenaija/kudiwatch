// JWTs (HS256 via jose). Three token kinds:
//   - access: 15 min, cookie kw_at, claims {sub, roles}
//   - refresh: opaque random hex (NOT a JWT), SHA-256 stored in auth_sessions, cookie kw_rt
//   - watch:  per-session token, claims {jti, sub, sid, vid, cid, fp}, exp = now + duration + grace
import { SignJWT, jwtVerify } from 'jose';
import { sha256Hex, randomTokenHex } from './crypto.js';

export interface AccessClaims { sub: string; roles: string[]; sid: string }
export interface WatchClaims {
  jti: string; sub: string; sid: string; vid: string; cid: string; fp: string;
}

const enc = new TextEncoder();

export async function signAccessToken(secret: string, claims: AccessClaims): Promise<string> {
  return new SignJWT({ roles: claims.roles, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(enc.encode(secret));
}

export async function verifyAccessToken(secret: string, token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, enc.encode(secret), { algorithms: ['HS256'] });
    if (!payload.sub || typeof payload.sid !== 'string') return null;
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
    return { sub: payload.sub, roles, sid: payload.sid as string };
  } catch {
    return null;
  }
}

export async function signWatchToken(
  secret: string, claims: WatchClaims, expiresAtSec: number
): Promise<string> {
  return new SignJWT({ jti: claims.jti, sid: claims.sid, vid: claims.vid, cid: claims.cid, fp: claims.fp })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAtSec)
    .sign(enc.encode(secret));
}

export async function verifyWatchToken(secret: string, token: string): Promise<WatchClaims | null> {
  try {
    const { payload } = await jwtVerify(token, enc.encode(secret), { algorithms: ['HS256'] });
    const { jti, sub, sid, vid, cid, fp } = payload as Record<string, unknown>;
    if (!jti || !sub || !sid || !vid || !cid || !fp) return null;
    return { jti: String(jti), sub: String(sub), sid: String(sid), vid: String(vid), cid: String(cid), fp: String(fp) };
  } catch {
    return null;
  }
}

export function newRefreshToken(): { token: string; hash: Promise<string> } {
  const token = 'kwrt_' + randomTokenHex(32);
  return { token, hash: sha256Hex(token) };
}
