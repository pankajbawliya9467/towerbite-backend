import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { HttpError } from './errors.js';

/**
 * Authenticator-app codes (TOTP, RFC 6238: SHA-1, 6 digits, 30 s), the same codes Google Authenticator,
 * Microsoft Authenticator and Authy show. No outside library: built on Node's crypto.
 */
const STEP = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits), as the authenticator apps expect. */
export const newSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/**
 * The 30-second step the code belongs to (the current one, or one step before/after for a slow phone clock),
 * or null when it is wrong. Steps at or before `afterStep` are refused, so a code works only once.
 */
export function checkCode(secretB32: string, code: string, afterStep = 0, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const cur = stepAt(now);
  let hit: number | null = null;
  for (const s of [cur - 1, cur, cur + 1]) {
    // Compare every window (no early exit), so timing doesn't tell which one matched.
    if (timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code)) && s > afterStep) hit = s;
  }
  return hit;
}

export function otpauthUrl(email: string, secretB32: string) {
  const label = `TowerBites:${encodeURIComponent(email)}`;
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=TowerBites&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
}

// ---- Secret encryption (AES-256-GCM with TOTP_KEY) ----

function key() {
  if (!env.totpKey) throw new HttpError(503, 'Admin login is not set up on the server yet (TOTP_KEY is missing). Ask the developer.');
  return env.totpKey;
}

export function encryptSecret(secretB32: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decryptSecret(stored: string) {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new HttpError(500, 'Stored 2-step secret is not readable');
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    // Wrong TOTP_KEY (changed on the server): the secret can't be read. A super admin must reset 2-step for this admin.
    throw new HttpError(503, '2-step login could not be checked (the server key changed). Ask a super admin to reset your 2-step login.');
  }
}

// ---- Backup codes ----

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
/** "K7PQX-M2RTA": 10 characters (~49 bits), shown with a dash. */
export const newBackupCode = () => {
  const s = Array.from({ length: 10 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  return `${s.slice(0, 5)}-${s.slice(5)}`;
};
export const normBackupCode = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
export const looksLikeBackupCode = (s: string) => /^[A-Z0-9]{10}$/.test(normBackupCode(s));
export const hashBackupCode = (adminId: string, code: string) =>
  createHash('sha256').update(`towerbites-backup:${adminId}:${normBackupCode(code)}`).digest('hex');
