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

// Per-number limits (on top of the per-IP route limits): a code every 30 s, 5 an hour, 10 a day;
// 5 wrong tries in 15 min per number + IP. All numbers together: OTP_DAILY_LIMIT SMS a day (default 3000).
const SMS_PER_NUMBER_PER_DAY = 10;
const smsPerDay = () => Math.max(1, Number(process.env.OTP_DAILY_LIMIT) || 3000);
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
    if (!isTestNumber(phone)) {
      // Daily limits kept in the database (they survive restarts and work across servers): stops someone
      // running up the SMS bill by asking for codes for many numbers from many IPs.
      const [day] = await q<{ mine: number; all: number }>(
        `select count(*) filter (where phone = $1)::int as mine, count(*)::int as all
         from sms_sends where created_at > now() - interval '24 hours'`,
        [phone],
      );
      if (day.mine >= SMS_PER_NUMBER_PER_DAY) throw tooMany('Too many codes for this number today. Please try again tomorrow.');
      if (day.all >= smsPerDay()) {
        app.log.error({ sent24h: day.all }, 'OTP daily SMS limit reached: login SMS paused');
        throw tooMany('Login by SMS is busy right now. Please try again in a while.');
      }
      await otpProvider.send(phone);
      await q(`insert into sms_sends (phone) values ($1)`, [phone]);
      if (Math.random() < 0.02) void q(`delete from sms_sends where created_at < now() - interval '7 days'`).catch(() => undefined);
    }
    return { sent: true };
  });

  app.post('/v1/auth/otp/verify', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const body = z.object({ phone: Phone, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
    checkPhone(body.phone);
    // Counted per number + IP, so someone else can't lock you out by typing wrong codes for your number.
    // (Guessing is still capped: each code allows only 5 tries in total, see lib/otp.ts.)
    const failKey = `${body.phone}|${req.ip}`;
    const wrong = hit(fails, failKey, 15 * 60_000);
    if (wrong.length >= 5) throw tooMany('Too many wrong codes. Please ask for a new code in 15 minutes.');

    const viaTest = isTestNumber(body.phone);
    // The test code has no per-code try limit in the database, so test numbers also get a per-number cap.
    const testWrong = viaTest ? hit(fails, `${body.phone}|test`, 3600_000) : [];
    if (testWrong.length >= 20) throw tooMany('Too many wrong codes. Please try again in an hour.');
    let providerUserId: string | undefined;
    try {
      if (viaTest) {
        if (!codeMatches(body.code)) throw new Error('Wrong code');
      } else {
        ({ providerUserId } = await otpProvider.verify(body.phone, body.code));
      }
    } catch {
      wrong.push(Date.now());
      if (viaTest) testWrong.push(Date.now());
      throw unauthorized('Wrong or expired code');
    }
    fails.delete(failKey);
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
