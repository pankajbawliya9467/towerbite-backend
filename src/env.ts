import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

/** `npm start` runs the compiled build in dist/. That is always treated as production, even if NODE_ENV was forgotten. */
const compiled = /[\\/]dist[\\/]/.test(new URL(import.meta.url).pathname);
const production = process.env.NODE_ENV === 'production' || compiled;

if (production && process.env.DEV_AUTH === 'true') {
  // Fail loudly instead of silently ignoring it: someone meant to turn it on, and it must never be on in production.
  throw new Error('DEV_AUTH=true is not allowed in production. Remove it from the server env.');
}

/** Optional CA certificate for the database (PEM text or a path to a .crt file), so TLS is fully verified. */
function databaseCa(): string | undefined {
  const v = process.env.DATABASE_CA_CERT?.trim();
  if (!v) return undefined;
  if (v.includes('BEGIN CERTIFICATE')) return v.replace(/\\n/g, '\n');
  if (existsSync(v)) return readFileSync(v, 'utf8');
  throw new Error('DATABASE_CA_CERT must be the certificate text or a path to the .crt file');
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  databaseUrl: req('DATABASE_URL'),
  databaseCa: databaseCa(),
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  bucket: process.env.STORAGE_BUCKET ?? 'menu-images',
  production,
  devAuth: process.env.DEV_AUTH === 'true' && !production,
  /**
   * How many proxies sit in front of the API (Render/Railway = 1, Cloudflare + Render = 2).
   * Only those hops' X-Forwarded-For entries are trusted, so a client cannot fake its IP to dodge rate limits.
   */
  trustProxy: Math.max(0, Number(process.env.TRUST_PROXY ?? 1) || 0),
  /** Employees must log in with a phone number starting with one of these (comma separated). Empty = any country. */
  allowedPhonePrefixes: (process.env.ALLOWED_PHONE_PREFIXES ?? '+91').split(',').map((s) => s.trim()).filter(Boolean),
  /**
   * Test login (testers, Play Store reviewer, no SMS): numbers in TEST_LOGIN_NUMBERS log in with TEST_LOGIN_OTP.
   * TEST_LOGIN_ALL_UNTIL=YYYY-MM-DD opens it to every Indian number until that date (max 45 days ahead).
   * Test-code sessions end as soon as the number stops being a test number.
   */
  testLogin: testLoginConfig(),
};

function testLoginConfig() {
  const numbers = (process.env.TEST_LOGIN_NUMBERS ?? '')
    .split(',')
    .map((s) => s.replace(/[\s-]/g, ''))
    .filter(Boolean)
    .map((s) => (s.startsWith('+') ? s : s.length === 10 ? `+91${s}` : `+${s}`));
  const otp = (process.env.TEST_LOGIN_OTP ?? '123456').trim();
  if (!/^\d{6}$/.test(otp)) throw new Error('TEST_LOGIN_OTP must be 6 digits');
  let allUntil: number | null = null;
  const until = (process.env.TEST_LOGIN_ALL_UNTIL ?? '').trim();
  if (until) {
    const t = Date.parse(`${until}T23:59:59+05:30`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(t)) throw new Error('TEST_LOGIN_ALL_UNTIL must be a date like 2026-12-05');
    if (t - Date.now() > 45 * 86400_000) console.warn('TEST_LOGIN_ALL_UNTIL is more than 45 days away: ignored.');
    else if (t > Date.now()) {
      allUntil = t;
      console.warn(`TEST LOGIN IS OPEN FOR ALL NUMBERS until ${until}: anyone can log in to any account with the test code.`);
    }
  }
  return { numbers, otp, allUntil };
}

export const supabaseConfigured = () =>
  !!env.supabaseUrl && !!env.supabaseServiceKey && !env.supabaseUrl.includes('YOUR-PROJECT');
