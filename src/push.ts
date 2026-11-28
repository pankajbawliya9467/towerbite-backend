import { q } from './db.js';

/** With Expo "Enhanced push security" on, only requests with this token can send to our app's devices. */
const headers = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  ...(process.env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` } : {}),
});

type Ticket = { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } };
type Receipt = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

/** What a failed send most likely means, so the server log says what to fix. */
function hint(statusOrError: number | string | undefined) {
  switch (statusOrError) {
    case 401:
    case 403:
      return 'Expo "Enhanced push security" is on: set EXPO_ACCESS_TOKEN on the server (expo.dev → Account settings → Access tokens).';
    case 'InvalidCredentials':
      return 'Android: the FCM V1 service account key is missing or wrong. Upload it at expo.dev → project → Credentials → Android → FCM V1.';
    case 'DeviceNotRegistered':
      return 'The app was uninstalled or its notifications reset; this phone token is removed.';
    case 'MessageRateExceeded':
      return 'Too many notifications to one phone in a short time.';
    case 'MismatchSenderId':
      return 'google-services.json in the app build is from a different Firebase project than the FCM key on expo.dev.';
    default:
      return '';
  }
}

/**
 * After a send: removes tokens of uninstalled apps, logs every other error with what it means, and checks the
 * delivery receipts a little later (Android credential problems show up only there).
 */
async function afterSend(tokens: string[], tickets: Ticket[]) {
  const dead: string[] = [];
  const ids: string[] = [];
  tickets.forEach((t, i) => {
    if (t.status === 'ok' && t.id) ids.push(t.id);
    else if (t.details?.error === 'DeviceNotRegistered') dead.push(tokens[i]);
    else if (t.status === 'error') console.warn('push not sent:', t.details?.error ?? '', t.message ?? '', hint(t.details?.error));
  });
  if (dead.length) await q(`delete from push_tokens where token = any($1)`, [dead]).catch(() => undefined);
  if (ids.length) setTimeout(() => void checkReceipts(ids).catch(() => undefined), 20_000).unref?.();
}

/** Expo's delivery receipts: whether Google / Apple accepted each notification. */
async function fetchReceipts(ids: string[]): Promise<Record<string, Receipt>> {
  const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ ids: ids.slice(0, 1000) }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as { data?: Record<string, Receipt> } | null;
  return json?.data ?? {};
}

async function checkReceipts(ids: string[]) {
  const receipts = await fetchReceipts(ids);
  for (const r of Object.values(receipts)) {
    if (r.status === 'error') console.warn('push not delivered:', r.details?.error ?? '', r.message ?? '', hint(r.details?.error));
  }
}

/**
 * Admin "Send test notification": sends to one user's phones and waits a few seconds for the receipts, so the
 * CRM can show exactly what happened (no phone registered, a credentials problem, or delivered).
 */
export async function pushTest(userId: string) {
  const tokens = await q<{ token: string; platform: string; created_at: Date }>(
    `select token, platform, created_at from push_tokens where user_id = $1 order by created_at desc`,
    [userId],
  );
  if (!tokens.length) {
    return { devices: 0, results: [], summary: 'This user has no phone registered for notifications. They must open the app (an EAS build, not Expo Go), allow notifications, and stay logged in.' };
  }
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(tokens.map((t) => ({
      to: t.token, title: 'Test from TowerBites', body: 'Notifications are working on this phone.', sound: 'default', priority: 'high', channelId: 'orders',
    }))),
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => null)) as { data?: Ticket[]; errors?: { message?: string }[] } | null;
  if (!res.ok) {
    return { devices: tokens.length, results: [], summary: `Expo refused the request (${res.status}). ${hint(res.status) || json?.errors?.[0]?.message || ''}`.trim() };
  }
  const tickets = json?.data ?? [];
  const ids = tickets.map((t) => t.id).filter((x): x is string => !!x);
  // Receipts are ready a few seconds after sending.
  let receipts: Record<string, Receipt> = {};
  if (ids.length) {
    await new Promise((r) => setTimeout(r, 6000));
    receipts = await fetchReceipts(ids).catch(() => ({}));
  }
  const results = tokens.map((t, i) => {
    const ticket = tickets[i];
    const receipt = ticket?.id ? receipts[ticket.id] : undefined;
    const error = ticket?.status === 'error' ? ticket.details?.error ?? ticket.message : receipt?.status === 'error' ? receipt.details?.error ?? receipt.message : undefined;
    const state = error ? 'failed' : receipt?.status === 'ok' ? 'delivered' : ticket?.status === 'ok' ? 'sent' : 'unknown';
    return { platform: t.platform, registeredAt: t.created_at, state, error: error ?? null, fix: error ? hint(error) || null : null };
  });
  const dead = tokens.filter((_, i) => results[i].error === 'DeviceNotRegistered').map((t) => t.token);
  if (dead.length) await q(`delete from push_tokens where token = any($1)`, [dead]).catch(() => undefined);
  const failed = results.filter((r) => r.state === 'failed');
  const summary = failed.length
    ? `${failed.length} of ${results.length} phone(s) failed: ${failed[0].error}. ${failed[0].fix ?? ''}`.trim()
    : `Sent to ${results.length} phone(s). If nothing shows, check the phone's notification settings for TowerBites.`;
  return { devices: tokens.length, results, summary };
}

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
      headers: headers(),
      body: JSON.stringify(
        // channelId matches the Android channel the app creates (src/lib/push.ts), so it shows as a heads-up alert.
        tokens.map((t) => ({ to: t.token, title, body, data, sound: 'default', priority: 'high', channelId: 'orders' })),
      ),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => null)) as { data?: Ticket[] } | null;
    if (!res.ok) return console.warn('push failed', res.status, hint(res.status), JSON.stringify(json));
    await afterSend(tokens.map((t) => t.token), json?.data ?? []);
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
        headers: headers(),
        body: JSON.stringify(batch.map((t) => ({ to: t.token, title, body, data, sound: 'default', priority: 'high', channelId: 'orders' }))),
        signal: AbortSignal.timeout(15000),
      });
      const json = (await res.json().catch(() => null)) as { data?: Ticket[] } | null;
      if (!res.ok) {
        console.warn('push batch failed', res.status, hint(res.status), JSON.stringify(json));
        continue;
      }
      await afterSend(batch.map((t) => t.token), json?.data ?? []);
    } catch (e) {
      console.warn('push batch failed', e);
    }
  }
  return tokens.length;
}
