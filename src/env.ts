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
};

export const supabaseConfigured = () =>
  !!env.supabaseUrl && !!env.supabaseServiceKey && !env.supabaseUrl.includes('YOUR-PROJECT');
