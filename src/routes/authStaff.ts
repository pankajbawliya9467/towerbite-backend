import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { env, supabaseConfigured } from '../env.js';
import { devUserId } from '../lib/devId.js';
import { tooMany, unauthorized } from '../lib/errors.js';
import { passwordProvider } from '../lib/otp.js';
import { burnTime, hashPassword, verifyPassword } from '../lib/passwords.js';
import { createSession } from '../lib/sessions.js';

/**
 * CRM login (cafe staff and admins) through our API: email + password → our own session token.
 * Passwords live in staff.password_hash. Someone who never logged in since this change is checked once
 * against the old login system (Supabase) and their password is then saved here, so nobody has to reset.
 */
const fails = new Map<string, number[]>();
const WRONG = 'Wrong email or password';

export async function authStaffRoutes(app: FastifyInstance) {
  app.post('/v1/auth/staff/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const body = z
      .object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) })
      .parse(req.body);

    const now = Date.now();
    const recent = (fails.get(body.email) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 5) throw tooMany('Too many wrong tries. Please wait 15 minutes.');
    const fail = () => {
      recent.push(now);
      if (fails.size > 20000) fails.clear();
      fails.set(body.email, recent);
      return unauthorized(WRONG);
    };

    const staff = await one<{ user_id: string; password_hash: string | null }>(
      `select user_id, password_hash from staff where lower(email) = $1 order by created_at limit 1`,
      [body.email],
    );
    if (!staff) {
      await burnTime(body.password);
      throw fail();
    }

    let ok = false;
    if (staff.password_hash) {
      ok = await verifyPassword(body.password, staff.password_hash);
    } else if (supabaseConfigured()) {
      ok = (await passwordProvider.verify(body.email, body.password).catch(() => null)) === staff.user_id;
      if (ok) {
        await q(`update staff set password_hash = $2, password_set_at = now() where user_id = $1`, [staff.user_id, await hashPassword(body.password)]);
      }
    } else if (env.devAuth) {
      ok = staff.user_id === devUserId(body.email); // local dev without Supabase
    }
    if (!ok) throw fail();

    fails.delete(body.email);
    return createSession(staff.user_id, null, String(req.headers['user-agent'] ?? ''), false, body.email);
  });
}
