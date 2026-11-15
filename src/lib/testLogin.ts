import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/** Test numbers (TEST_LOGIN_NUMBERS, or every Indian number during TEST_LOGIN_ALL_UNTIL) log in with the test code, no SMS. */

export const normPhone = (raw: string) => {
  const d = raw.replace(/[\s-]/g, '');
  return d.startsWith('+') ? d : d.length === 10 ? `+91${d}` : `+${d}`;
};
/** Listed numbers always; during an open testing period (TEST_LOGIN_ALL_UNTIL) every Indian mobile number. */
export const isTestNumber = (phone: string) => {
  const p = normPhone(phone);
  if (env.testLogin.numbers.includes(p)) return true;
  return env.testLogin.allUntil !== null && Date.now() < env.testLogin.allUntil && /^\+91[6-9]\d{9}$/.test(p);
};
export const testLoginOn = () => env.testLogin.numbers.length > 0 || (env.testLogin.allUntil !== null && Date.now() < env.testLogin.allUntil);

/** Stable user id for a test number (its own namespace, so it never matches a dev or Supabase id). */
export function testUserId(phone: string) {
  const h = createHash('sha256').update(`towerbites-test:${phone}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-b${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function codeMatches(code: string) {
  const a = Buffer.from(code.padEnd(6).slice(0, 6));
  const b = Buffer.from(env.testLogin.otp);
  return a.length === b.length && timingSafeEqual(a, b);
}
