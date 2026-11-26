import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { env, supabaseConfigured } from '../env.js';
import { requireUser } from '../auth.js';
import { devUserId } from '../lib/devId.js';
import { badRequest, tooMany, unauthorized } from '../lib/errors.js';
import { passwordProvider } from '../lib/otp.js';
import { burnTime, hashPassword, verifyPassword } from '../lib/passwords.js';
import { createSession, endOtherSessions } from '../lib/sessions.js';

/**
 * CRM login (admins and cafe logins) through our API: email + password → our own session token.
 * Admins are in `admins`, cafe logins in `staff`; both keep a scrypt password hash. A cafe login that has
 * no hash yet (made before our own passwords) is checked once against the old login provider, then saved here.
 */
/**
 * Wrong passwords are counted per email + IP (5 in 15 min locks that pair), so someone else typing wrong
 * passwords for your email can't lock you out. A much higher per-email limit still stops a spread-out
 * guessing attack from many IPs.
 */
const fails = new Map<string, number[]>();
const WRONG = 'Wrong email or password';
const PER_PAIR = 5;
const PER_EMAIL = 50;
const WINDOW = 15 * 60_000;
function recentFails(key: string, now: number) {
  const list = (fails.get(key) ?? []).filter((t) => now - t < WINDOW);
  if (list.length) fails.set(key, list);
  else fails.delete(key);
  return list;
}
function addFail(key: string, now: number) {
  if (fails.size > 50000) fails.clear();
  fails.set(key, [...recentFails(key, now), now]);
}

type Login = { id: string; hash: string | null; table: 'admins' | 'staff' };
async function findLogin(email: string): Promise<Login | undefined> {
  return one<Login>(
    `select * from (
       select 0 as src, id, password_hash as hash, 'admins' as "table" from admins where lower(email) = $1 and is_active
       union all
       select 1, user_id, password_hash, 'staff' from staff where lower(email) = $1 and role = 'cafe_staff'
     ) x order by src limit 1`,
    [email],
  );
}
async function findById(id: string): Promise<Login | undefined> {
  return one<Login>(
    `select id, password_hash as hash, 'admins' as "table" from admins where id = $1 and is_active
     union all
     select user_id, password_hash, 'staff' from staff where user_id = $1 and role = 'cafe_staff' limit 1`,
    [id],
  );
}
const saveHash = async (l: Login, password: string) =>
  q(`update ${l.table} set password_hash = $2, password_set_at = now() where ${l.table === 'admins' ? 'id' : 'user_id'} = $1`, [
    l.id,
    await hashPassword(password),
  ]);

export async function authStaffRoutes(app: FastifyInstance) {
  app.post('/v1/auth/staff/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = z
      .object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) })
      .parse(req.body);

    const now = Date.now();
    const pair = `${body.email}|${req.ip}`;
    const all = `${body.email}|*`;
    if (recentFails(pair, now).length >= PER_PAIR || recentFails(all, now).length >= PER_EMAIL) {
      throw tooMany('Too many wrong tries. Please wait 15 minutes.');
    }
    const fail = () => {
      addFail(pair, now);
      addFail(all, now);
      return unauthorized(WRONG);
    };

    const login = await findLogin(body.email);
    if (!login) {
      await burnTime(body.password);
      throw fail();
    }

    let ok = false;
    if (login.hash) {
      ok = await verifyPassword(body.password, login.hash);
    } else if (supabaseConfigured()) {
      ok = (await passwordProvider.verify(body.email, body.password).catch(() => null)) === login.id;
      if (ok) await saveHash(login, body.password);
    } else if (env.devAuth) {
      ok = login.id === devUserId(body.email); // local dev only
    }
    if (!ok) throw fail();

    fails.delete(pair);
    return createSession(login.id, null, String(req.headers['user-agent'] ?? ''), false, body.email, login.table === 'admins' ? 'admin' : 'cafe');
  });

  /** Change your own CRM password with the current one. Other devices are logged out; this one stays in. */
  app.post('/v1/auth/password', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (req) => {
    const user = await requireUser(req);
    const body = z
      .object({ current: z.string().min(1).max(200), next: z.string().min(8, 'New password: at least 8 characters').max(72) })
      .parse(req.body);
    const login = await findById(user.id);
    if (!login) throw badRequest('This login has no password');
    if (!login.hash) throw badRequest('Ask an admin to set a new password for this login first');
    if (!(await verifyPassword(body.current, login.hash))) throw badRequest('Current password is wrong');
    if (body.current === body.next) throw badRequest('New password must be different');
    await saveHash(login, body.next);
    const token = (req.headers.authorization ?? '').slice(7).trim();
    await endOtherSessions(user.id, token);
    return { ok: true };
  });
}
