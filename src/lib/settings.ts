import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { one, q } from '../db.js';
import { env } from '../env.js';

/**
 * Server-only settings in the `app_settings` table. Secrets (like the OpenAI key) are encrypted with
 * AES-256-GCM using SETTINGS_SECRET (set it on the server; without it a key derived from DATABASE_URL is
 * used, so a database copy alone doesn't reveal them). Values never leave the server.
 */
const key = () => createHash('sha256').update(`towerbites-settings:${process.env.SETTINGS_SECRET || env.databaseUrl}`).digest();

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(stored: string): string | null {
  const [v, iv, tag, data] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // SETTINGS_SECRET changed: the key has to be entered again
  }
}

export async function getSetting(name: string) {
  return (await one<{ value: string }>(`select value from app_settings where key = $1`, [name]))?.value ?? null;
}

export async function setSetting(name: string, value: string | null, by: string | null) {
  if (value === null) {
    await q(`delete from app_settings where key = $1`, [name]);
    return;
  }
  await q(
    `insert into app_settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [name, value, by],
  );
}
