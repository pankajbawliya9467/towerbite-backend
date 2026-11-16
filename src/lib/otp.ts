import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { one, q } from '../db.js';
import { env } from '../env.js';
import { HttpError } from './errors.js';
import { supabase, supabaseAuthCheck } from '../supabase.js';

/**
 * Who sends and checks the SMS code. The app only ever talks to our API; this is the one place to change
 * when moving off Supabase (e.g. MSG91 / Twilio + our own code table).
 */
export interface OtpProvider {
  send(phone: string): Promise<void>;
  /** Throws when the code is wrong. May return the provider's user id (kept for existing accounts). */
  verify(phone: string, code: string): Promise<{ providerUserId?: string }>;
}

export const supabaseOtp: OtpProvider = {
  async send(phone) {
    const { error } = await supabase().auth.signInWithOtp({ phone });
    if (error) throw new Error(error.message);
  },
  async verify(phone, code) {
    const { data, error } = await supabaseAuthCheck().auth.verifyOtp({ phone, token: code, type: 'sms' });
    if (error || !data.user) throw new Error('Wrong or expired code');
    return { providerUserId: data.user.id };
  },
};

/**
 * Our own codes, delivered by 2Factor.in. The code is made and checked here (only a salted hash is stored),
 * so 2Factor (or any later SMS service) only has to deliver a text. Codes last 10 minutes, 5 tries each.
 */
const CODE_MINUTES = 10;
const MAX_TRIES = 5;
const hashCode = (salt: string, phone: string, code: string) => createHmac('sha256', salt).update(`${phone}:${code}`).digest('hex');

async function sendWith2Factor(phone: string, code: string) {
  const { apiKey, template } = env.twoFactor;
  if (!apiKey) throw new HttpError(503, 'SMS login is not set up yet. Please try again later.');
  const to = phone.replace(/^\+/, ''); // 91XXXXXXXXXX
  const url = `https://2factor.in/API/V1/${encodeURIComponent(apiKey)}/SMS/${to}/${code}${template ? `/${encodeURIComponent(template)}` : ''}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await res.json().catch(() => null)) as { Status?: string; Details?: string } | null;
  if (!res.ok || data?.Status !== 'Success') {
    // Never log the URL: it contains the API key.
    console.warn('2factor send failed', res.status, data?.Details ?? '');
    throw new HttpError(503, 'Could not send the SMS right now. Please try again in a minute.');
  }
}

export const ownCodes = (deliver: (phone: string, code: string) => Promise<void>): OtpProvider => ({
  async send(phone) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    await q(
      `insert into otp_codes (phone, salt, code_hash, attempts, expires_at) values ($1, $2, $3, 0, now() + make_interval(mins => ${CODE_MINUTES}))
       on conflict (phone) do update set salt = excluded.salt, code_hash = excluded.code_hash, attempts = 0,
         expires_at = excluded.expires_at, created_at = now()`,
      [phone, salt, hashCode(salt, phone, code)],
    );
    if (Math.random() < 0.05) void q(`delete from otp_codes where expires_at < now()`).catch(() => undefined);
    await deliver(phone, code);
  },
  async verify(phone, code) {
    // Count the try first, so parallel guesses can't get more than MAX_TRIES.
    const row = await one<{ salt: string; code_hash: string }>(
      `update otp_codes set attempts = attempts + 1 where phone = $1 and expires_at > now() and attempts < ${MAX_TRIES}
       returning salt, code_hash`,
      [phone],
    );
    if (!row) throw new Error('Wrong or expired code');
    const got = Buffer.from(hashCode(row.salt, phone, code), 'hex');
    const want = Buffer.from(row.code_hash, 'hex');
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('Wrong or expired code');
    await q(`delete from otp_codes where phone = $1`, [phone]); // a code works once
    return {};
  },
});

export const twoFactorOtp = ownCodes(sendWith2Factor);

/** Swappable in tests. */
export let otpProvider: OtpProvider = env.otpProvider === '2factor' ? twoFactorOtp : supabaseOtp;
export const setOtpProvider = (p: OtpProvider) => {
  otpProvider = p;
};

/**
 * Checks a staff password with the old login system, once per person: used only until their password is
 * stored in our own database (staff.password_hash). Returns the user id, or null when it is wrong.
 */
export interface PasswordProvider {
  verify(email: string, password: string): Promise<string | null>;
}
export const supabasePassword: PasswordProvider = {
  async verify(email, password) {
    const { data, error } = await supabaseAuthCheck().auth.signInWithPassword({ email, password });
    return error || !data.user ? null : data.user.id;
  },
};
export let passwordProvider: PasswordProvider = supabasePassword;
export const setPasswordProvider = (p: PasswordProvider) => {
  passwordProvider = p;
};
