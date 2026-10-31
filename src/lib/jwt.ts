import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject, type webcrypto } from 'node:crypto';
import { env } from '../env.js';

/**
 * Verifies Supabase access tokens inside the API, without a network call per request.
 * - Asymmetric keys (ES256/RS256, Supabase "JWT signing keys"): public keys from the project's JWKS,
 *   fetched once and cached for 10 minutes.
 * - Legacy HS256 tokens: verified with SUPABASE_JWT_SECRET when it is set.
 * Returns null when the token can't be checked locally, so the caller falls back to asking Supabase.
 * Throws when the token is definitely invalid (bad signature, expired, wrong issuer/audience).
 */

export type Claims = { sub: string; phone?: string; email?: string; exp: number; aud?: string | string[]; iss?: string; role?: string };

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let jwks: { at: number; keys: Map<string, { key: KeyObject; alg: string }> } | null = null;
let jwksLoading: Promise<void> | null = null;

async function loadJwks(force = false) {
  if (!force && jwks && Date.now() - jwks.at < 10 * 60_000) return;
  jwksLoading ??= (async () => {
    try {
      const res = await fetch(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`JWKS ${res.status}`);
      const body = (await res.json()) as { keys: (webcrypto.JsonWebKey & { kid: string; alg: string })[] };
      const keys = new Map<string, { key: KeyObject; alg: string }>();
      for (const k of body.keys ?? []) {
        if (!k.kid || !k.alg || k.alg.startsWith('HS')) continue;
        keys.set(k.kid, { key: createPublicKey({ key: k, format: 'jwk' }), alg: k.alg });
      }
      jwks = { at: Date.now(), keys };
    } catch (e) {
      console.warn('Could not load Supabase JWKS, falling back to Supabase for token checks', (e as Error).message);
      jwks = { at: Date.now() - 9 * 60_000, keys: jwks?.keys ?? new Map() }; // retry in ~1 minute
    } finally {
      jwksLoading = null;
    }
  })();
  await jwksLoading;
}

export class InvalidToken extends Error {}

export async function verifyLocally(token: string): Promise<Claims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new InvalidToken('malformed');
  let header: { alg?: string; kid?: string };
  let claims: Claims;
  try {
    header = JSON.parse(b64(parts[0]).toString('utf8'));
    claims = JSON.parse(b64(parts[1]).toString('utf8'));
  } catch {
    throw new InvalidToken('malformed');
  }
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = b64(parts[2]);

  let checked = false;
  if (header.alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) return null;
    const expected = createHmac('sha256', secret).update(data).digest();
    if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) throw new InvalidToken('signature');
    checked = true;
  } else if (header.alg === 'ES256' || header.alg === 'RS256') {
    if (!header.kid) return null;
    await loadJwks();
    let entry = jwks?.keys.get(header.kid);
    if (!entry) {
      await loadJwks(true); // keys may have been rotated
      entry = jwks?.keys.get(header.kid);
    }
    if (!entry || entry.alg !== header.alg) return null;
    const ok = header.alg === 'ES256'
      ? verify('sha256', data, { key: entry.key, dsaEncoding: 'ieee-p1363' }, sig)
      : verify('sha256', data, entry.key, sig);
    if (!ok) throw new InvalidToken('signature');
    checked = true;
  } else {
    return null;
  }

  if (!checked) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!claims.sub || typeof claims.exp !== 'number' || claims.exp < now - 5) throw new InvalidToken('expired');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes('authenticated')) throw new InvalidToken('audience');
  if (claims.iss && claims.iss !== `${env.supabaseUrl.replace(/\/$/, '')}/auth/v1`) throw new InvalidToken('issuer');
  return claims;
}
