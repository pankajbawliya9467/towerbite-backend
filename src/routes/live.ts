import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { one } from '../db.js';
import { can, getStaff, userFromBearer, type AuthUser } from '../auth.js';
import { listen } from '../liveHub.js';

const RECHECK_MS = Number(process.env.LIVE_RECHECK_MS) || 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rules as the old private Supabase channels (db/002_realtime_security.sql). */
async function canListen(user: AuthUser, topic: string) {
  const [kind, id] = topic.split(':');
  if (!id || !UUID.test(id)) return false;
  if (kind === 'user') return id === user.id;
  if (kind === 'location') return true;
  if (kind === 'order') return !!(await one(`select 1 from orders where id = $1 and user_id = $2`, [id, user.id]));
  if (kind === 'cafe') {
    const staff = await getStaff(user.id);
    return !!staff && (can(staff, 'cafes.board') || staff.cafeId === id);
  }
  return false;
}

/**
 * GET /v1/live (WebSocket). Client sends {"type":"auth","token":"…"} first ({"type":"auth"} alone = visitor, building topics only), then {"type":"sub","topic":"order:<id>"}
 * / {"type":"unsub",…}. Server sends {"topic","event","payload"} pings. The app re-fetches on a ping.
 */
export async function liveRoutes(app: FastifyInstance) {
  await app.register(websocket, { options: { maxPayload: 4096 } });

  app.get('/v1/live', { websocket: true }, (socket) => {
    let user: AuthUser | null = null;
    let token = '';
    let anon = false; // website visitor without a login: only `location:` topics
    const subs = new Map<string, () => void>();
    const send = (o: unknown) => socket.readyState === 1 && socket.send(JSON.stringify(o));
    const authTimer = setTimeout(() => !user && !anon && socket.close(4001, 'auth required'), 10_000);
    const ping = setInterval(() => socket.readyState === 1 && socket.ping(), 25_000);
    // Every few minutes the login and each topic are checked again: after a logout, a password change or an
    // admin being turned off, the socket stops getting that person's pings.
    const recheck = setInterval(async () => {
      if (!user) return;
      try {
        const again = await userFromBearer(token);
        if (again.id !== user.id) throw new Error('changed');
      } catch {
        return socket.close(4001, 'session ended');
      }
      for (const topic of [...subs.keys()]) {
        if (!(await canListen(user, topic).catch(() => false))) {
          subs.get(topic)?.();
          subs.delete(topic);
          send({ type: 'denied', topic });
        }
      }
    }, RECHECK_MS);

    socket.on('message', async (raw: Buffer) => {
      let msg: { type?: string; token?: string; topic?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'auth' && !msg.token && !user) {
        anon = true;
        send({ type: 'ready' });
        return;
      }
      if (msg.type === 'auth' && typeof msg.token === 'string') {
        try {
          user = await userFromBearer(msg.token);
          token = msg.token;
          anon = false;
          send({ type: 'ready' });
        } catch {
          socket.close(4001, 'bad token');
        }
        return;
      }
      if ((!user && !anon) || typeof msg.topic !== 'string' || msg.topic.length > 80) return;
      if (msg.type === 'sub' && !subs.has(msg.topic) && subs.size < 50) {
        const allowed = user ? await canListen(user, msg.topic).catch(() => false) : /^location:[0-9a-f-]{36}$/i.test(msg.topic);
        if (!allowed) return send({ type: 'denied', topic: msg.topic });
        subs.set(msg.topic, listen(msg.topic, (m) => send(m)));
      } else if (msg.type === 'unsub') {
        subs.get(msg.topic)?.();
        subs.delete(msg.topic);
      }
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      clearInterval(ping);
      clearInterval(recheck);
      for (const off of subs.values()) off();
      subs.clear();
    });
  });
}
