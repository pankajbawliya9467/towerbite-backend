import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, q } from '../db.js';
import { env } from '../env.js';
import { badRequest, tooMany, unauthorized } from '../lib/errors.js';
import { otpProvider } from '../lib/otp.js';
import { createSession, endSession } from '../lib/sessions.js';
import { codeMatches, isTestNumber, normPhone, testUserId } from '../lib/testLogin.js';

/**
 * Phone login for the app, through our API (the app never talks to Supabase). The SMS goes through
 * `otpProvider` (Supabase today); test numbers skip the SMS and use the test code.
 */
const Phone = z.string().trim().min(10).max(16).transform(normPhone);

// Per-number limits (on top of the per-IP route limits): a code every 30 s, 5 an hour; 5 wrong tries in 15 min.
const sends = new Map<string, number[]>();
const fails = new Map<string, number[]>();
function hit(map: Map<string, number[]>, key: string, windowMs: number) {
  const now = Date.now();
  const list = (map.get(key) ?? []).filter((t) => now - t < windowMs);
  map.set(key, list);
  if (map.size > 50000) map.clear();
  return list;
}

function checkPhone(phone: string) {
  if (!/^\+\d{10,15}$/.test(phone)) throw badRequest('Enter a valid mobile number');
  if (env.allowedPhonePrefixes.length && !env.allowedPhonePrefixes.some((p) => phone.startsWith(p)))
    throw badRequest('TowerBites is not available for this phone number');
}

/** The account for a verified number: the existing profile with this phone, else a new one. */
async function userFor(phone: string, providerUserId?: string) {
  const existing = await one<{ id: string }>(`select id from profiles where phone = $1 order by created_at limit 1`, [phone]);
  const id = existing?.id ?? providerUserId ?? (isTestNumber(phone) ? testUserId(phone) : randomUUID());
  if (!existing) await q(`insert into profiles (id, phone) values ($1, $2) on conflict (id) do update set phone = coalesce(profiles.phone, $2)`, [id, phone]);
  return id;
}

export async function authOtpRoutes(app: FastifyInstance) {
  app.post('/v1/auth/otp/send', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const { phone } = z.object({ phone: Phone }).parse(req.body);
    checkPhone(phone);
    const recent = hit(sends, phone, 3600_000);
    if (recent.length && Date.now() - recent[recent.length - 1] < 30_000) throw tooMany('Please wait 30 seconds before asking for a new code');
    if (recent.length >= 5) throw tooMany('Too many codes. Please try again in an hour.');
    recent.push(Date.now());
    if (!isTestNumber(phone)) await otpProvider.send(phone);
    return { sent: true };
  });

  app.post('/v1/auth/otp/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const body = z.object({ phone: Phone, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
    checkPhone(body.phone);
    const wrong = hit(fails, body.phone, 15 * 60_000);
    if (wrong.length >= 5) throw tooMany('Too many wrong codes. Please ask for a new code in 15 minutes.');

    const viaTest = isTestNumber(body.phone);
    let providerUserId: string | undefined;
    try {
      if (viaTest) {
        if (!codeMatches(body.code)) throw new Error('Wrong code');
      } else {
        ({ providerUserId } = await otpProvider.verify(body.phone, body.code));
      }
    } catch {
      wrong.push(Date.now());
      throw unauthorized('Wrong or expired code');
    }
    fails.delete(body.phone);
    const userId = await userFor(body.phone, providerUserId);
    const session = await createSession(userId, body.phone, String(req.headers['user-agent'] ?? ''), viaTest);
    return { ...session, user: { id: userId, phone: body.phone } };
  });

  /** Log out: ends this session. */
  app.delete('/v1/auth/session', async (req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token.startsWith('tbs_')) await endSession(token);
    return { ok: true };
  });
}
