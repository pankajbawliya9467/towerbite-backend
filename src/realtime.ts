import { env, supabaseConfigured } from './env.js';

type Message = { topic: string; event: string; payload: Record<string, unknown> };

/**
 * Sends tiny "something changed" pings over PRIVATE Supabase Realtime channels.
 * db/002_realtime_security.sql decides who may listen:
 *   cafe:<cafeId>       that cafe's staff and admins   (event `order`)
 *   order:<orderId>     the employee who placed it     (event `status`)
 *   user:<userId>       that employee, any of their orders (event `order`)
 *   location:<locId>    any logged-in user             (event `cafes`: open/close, menu or price changed)
 * Pings carry no personal data: apps re-fetch from the API, which checks the login again.
 */
export async function broadcastMany(messages: Message[]) {
  if (!supabaseConfigured() || !messages.length) return;
  try {
    const res = await fetch(`${env.supabaseUrl}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.supabaseServiceKey,
        Authorization: `Bearer ${env.supabaseServiceKey}`,
      },
      body: JSON.stringify({ messages: messages.map((m) => ({ ...m, private: true })) }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) console.warn('realtime broadcast failed', res.status, await res.text().catch(() => ''));
  } catch (e) {
    console.warn('realtime broadcast failed', e);
  }
}

export function broadcast(topic: string, event: string, payload: Record<string, unknown>) {
  return broadcastMany([{ topic, event, payload }]);
}

/** An order was placed or changed: tell the cafe board, the tracking screen and the user's order list. */
export function orderChanged(o: { orderId: string; cafeId: string; userId: string; status: string }) {
  return broadcastMany([
    { topic: `cafe:${o.cafeId}`, event: 'order', payload: { orderId: o.orderId, status: o.status } },
    { topic: `order:${o.orderId}`, event: 'status', payload: { status: o.status } },
    { topic: `user:${o.userId}`, event: 'order', payload: { orderId: o.orderId, status: o.status } },
  ]);
}

/** A cafe opened/closed or its menu changed: every open app/website in that location re-loads. */
export function cafesChanged(locationIds: (string | null | undefined)[]) {
  const ids = [...new Set(locationIds.filter((x): x is string => !!x))];
  return broadcastMany(ids.map((id) => ({ topic: `location:${id}`, event: 'cafes', payload: {} })));
}
