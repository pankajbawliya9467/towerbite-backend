import { createHash, randomBytes } from 'node:crypto';
import { one, q } from '../db.js';

/**
 * Login sessions issued by the API: `tbs_<random>`. Only the SHA-256 of the token is stored, so a database
 * leak doesn't give working logins. 60 days, extended while used; logout or deleting the row ends it.
 */
const DAYS = 60;
/**
 * How long a login lasts. `idle`: ends after this long without use. `max`: ends this long after login,
 * however much it is used. Admin logins are short (a stolen admin token stops working soon).
 */
export type SessionKind = 'user' | 'cafe' | 'admin';
const LIMITS: Record<SessionKind, { idle: string; max: string; ms: number }> = {
  user: { idle: '60 days', max: '180 days', ms: DAYS * 86400_000 },
  cafe: { idle: '30 days', max: '90 days', ms: 30 * 86400_000 },
  admin: { idle: '12 hours', max: '7 days', ms: 12 * 3600_000 },
};
const hash = (t: string) => createHash('sha256').update(t).digest('hex');
type Row = { userId: string; phone: string | null; email: string | null; viaTest: boolean };
const cache = new Map<string, Row & { until: number }>();

export async function createSession(
  userId: string, phone: string | null, userAgent = '', viaTest = false, email: string | null = null, kind: SessionKind = 'user',
) {
  const token = `tbs_${randomBytes(32).toString('base64url')}`;
  const expires = new Date(Date.now() + LIMITS[kind].ms);
  await q(
    `insert into sessions (token_hash, user_id, phone, user_agent, expires_at, via_test, email, kind) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [hash(token), userId, phone, userAgent.slice(0, 200), expires, viaTest, email, kind],
  );
  // Old expired sessions are cleaned up now and then.
  if (Math.random() < 0.05) void q(`delete from sessions where expires_at < now()`).catch(() => undefined);
  return { token, expiresAt: expires.toISOString() };
}

/** The user for a session token, or null. Cached for a minute so most requests skip the lookup. */
export async function verifySession(token: string): Promise<{ id: string; phone: string | null; email: string | null; viaTest: boolean } | null> {
  const h = hash(token);
  const hit = cache.get(h);
  if (hit && hit.until > Date.now()) return { id: hit.userId, phone: hit.phone, email: hit.email, viaTest: hit.viaTest };
  const row = await one<{ user_id: string; phone: string | null; email: string | null; via_test: boolean }>(
    `update sessions set last_used_at = now(),
       expires_at = least(created_at + (case kind ${Object.entries(LIMITS).map(([k, v]) => `when '${k}' then interval '${v.max}'`).join(' ')} end),
         greatest(expires_at, now() + (case kind ${Object.entries(LIMITS).map(([k, v]) => `when '${k}' then interval '${v.idle}'`).join(' ')} end)))
     where token_hash = $1 and expires_at > now()
       and created_at + (case kind ${Object.entries(LIMITS).map(([k, v]) => `when '${k}' then interval '${v.max}'`).join(' ')} end) > now()
     returning user_id, phone, email, via_test`,
    [h],
  );
  if (!row) {
    cache.delete(h);
    return null;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(h, { userId: row.user_id, phone: row.phone, email: row.email, viaTest: row.via_test, until: Date.now() + 60_000 });
  return { id: row.user_id, phone: row.phone, email: row.email, viaTest: row.via_test };
}

export async function endSession(token: string) {
  const h = hash(token);
  cache.delete(h);
  await q(`delete from sessions where token_hash = $1`, [h]);
}

/** Ends every session of a user (e.g. account deleted, or test logins when a testing period ends). */
export async function endUserSessions(userId: string) {
  for (const [k, v] of cache) if (v.userId === userId) cache.delete(k);
  await q(`delete from sessions where user_id = $1`, [userId]);
}

/** Ends every session of a user except the one making the request (password changed: log out other devices). */
export async function endOtherSessions(userId: string, keepToken: string) {
  const keep = hash(keepToken);
  for (const [k, v] of cache) if (v.userId === userId && k !== keep) cache.delete(k);
  await q(`delete from sessions where user_id = $1 and token_hash <> $2`, [userId, keep]);
}
