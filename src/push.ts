import { q } from './db.js';

/**
 * Sends an Expo push notification to every device of a user. Failures are logged, never thrown.
 * Tokens Expo reports as no longer registered (app uninstalled) are removed.
 */
export async function pushToUser(userId: string, title: string, body: string, data: Record<string, unknown> = {}) {
  const tokens = await q<{ token: string }>(`select token from push_tokens where user_id = $1`, [userId]);
  if (!tokens.length) return;
  try {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(
        // channelId matches the Android channel the app creates (src/lib/push.ts), so it shows as a heads-up alert.
        tokens.map((t) => ({ to: t.token, title, body, data, sound: 'default', priority: 'high', channelId: 'orders' })),
      ),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null;
    if (!res.ok) return console.warn('push failed', res.status, json);
    const dead = (json?.data ?? [])
      .map((r, i) => (r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? tokens[i].token : null))
      .filter(Boolean);
    if (dead.length) await q(`delete from push_tokens where token = any($1)`, [dead]);
  } catch (e) {
    console.warn('push failed', e);
  }
}

/**
 * Sends one notification to many users (announcements). Expo takes up to 100 messages per request,
 * so tokens are sent in batches. Returns how many devices it was sent to.
 */
export async function pushToUsers(userIds: string[], title: string, body: string, data: Record<string, unknown> = {}) {
  if (!userIds.length) return 0;
  const tokens = await q<{ token: string }>(`select token from push_tokens where user_id = any($1::uuid[])`, [userIds]);
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(batch.map((t) => ({ to: t.token, title, body, data, sound: 'default', priority: 'high', channelId: 'orders' }))),
        signal: AbortSignal.timeout(15000),
      });
      const json = (await res.json().catch(() => null)) as { data?: { status: string; details?: { error?: string } }[] } | null;
      if (!res.ok) {
        console.warn('push batch failed', res.status, json);
        continue;
      }
      const dead = (json?.data ?? [])
        .map((r, j) => (r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? batch[j].token : null))
        .filter(Boolean);
      if (dead.length) await q(`delete from push_tokens where token = any($1)`, [dead]);
    } catch (e) {
      console.warn('push batch failed', e);
    }
  }
  return tokens.length;
}
