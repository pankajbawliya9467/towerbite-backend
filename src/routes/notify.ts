import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { requireAdmin, requireUser } from '../auth.js';
import { badRequest, conflict, notFound, tooMany } from '../lib/errors.js';
import { pushToUsers } from '../push.js';
import { AI_STYLES, AiError, aiConfig, askOpenAi, catalogFor, checkIdea, istNow, situation, targetLabel } from '../lib/aiNotify.js';
import { day, like, paging, uuidOrNull, Where } from '../lib/paging.js';
import { csv, sendCsv } from './reports.js';

/**
 * Announcements from the TowerBites owner (super admin only): push a custom notification to everyone,
 * one building, one company, a cafe's recent customers, or one person (by phone).
 */

const Audience = z.discriminatedUnion('type', [
  z.object({ type: z.literal('all') }),
  z.object({ type: z.literal('location'), locationId: z.string().uuid() }),
  z.object({ type: z.literal('company'), company: z.string().trim().min(2).max(80), locationId: z.string().uuid().optional() }),
  z.object({ type: z.literal('cafe'), cafeId: z.string().uuid() }),
  z.object({ type: z.literal('user'), phone: z.string().trim().min(10).max(16) }),
]);
type Audience = z.infer<typeof Audience>;

const Target = z.object({ type: z.enum(['item', 'combo', 'lunch', 'cafe', 'none']), id: z.string().max(64) });
const Send = z.object({
  title: z.string().trim().min(2).max(60),
  body: z.string().trim().min(2).max(180),
  audience: Audience,
  /** What the notification opens when tapped (checked again here). */
  target: Target.optional(),
  source: z.enum(['manual', 'ai']).default('manual'),
  angle: z.string().max(20).optional(),
});

/**
 * No promos at night (QUIET_HOURS, default "21-9" India time; "off" turns it off), and at most one promo a
 * day per person: people who already got one today are skipped.
 */
function quietNow() {
  const v = (process.env.QUIET_HOURS ?? '21-9').trim();
  if (v === 'off') return false;
  const [from, to] = v.split('-').map(Number);
  const h = istNow().hour;
  return from > to ? h >= from || h < to : h >= from && h < to;
}
async function splitToday(ids: string[], a?: Audience) {
  if (!ids.length) return { send: [] as string[], skipped: 0 };
  if (a?.type === 'user') return { send: ids, skipped: 0 }; // a message to one person is not a broadcast promo
  const got = new Set((await q<{ user_id: string }>(
    `select distinct user_id from notification_recipients where user_id = any($1::uuid[])
       and created_at >= ((now() at time zone 'Asia/Kolkata')::date at time zone 'Asia/Kolkata')`,
    [ids],
  )).map((r) => r.user_id));
  const send = ids.filter((id) => !got.has(id));
  return { send, skipped: ids.length - send.length };
}

/** The building an audience is in (for the weather and the menu the AI may use); null = all buildings. */
async function audienceLocation(a: Audience): Promise<string | null> {
  if (a.type === 'location') return a.locationId;
  if (a.type === 'company') return a.locationId ?? null;
  if (a.type === 'cafe') return (await one<{ l: string }>(`select location_id as l from cafes where id = $1`, [a.cafeId]))?.l ?? null;
  if (a.type === 'user') {
    const d = a.phone.replace(/\D/g, '');
    const phone = d.length === 10 ? `+91${d}` : `+${d}`;
    return (await one<{ l: string | null }>(`select location_id as l from profiles where phone = $1 limit 1`, [phone]))?.l ?? null;
  }
  return null;
}

/** Max announcements per hour, so a slip of the finger can't spam everyone. */
const MAX_PER_HOUR = 20;

const normPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.length === 10 ? `+91${d}` : `+${d}`;
};

/** The user ids an audience covers (only people who signed in on the app, i.e. have a device). */
async function resolve(a: Audience): Promise<{ ids: string[]; label: string }> {
  const base = `select distinct t.user_id from push_tokens t join profiles p on p.id = t.user_id`;
  switch (a.type) {
    case 'all':
      return { ids: (await q<{ user_id: string }>(base)).map((r) => r.user_id), label: 'Everyone' };
    case 'location': {
      const l = await one<{ name: string }>(`select name from locations where id = $1`, [a.locationId]);
      if (!l) throw notFound('Location not found');
      const rows = await q<{ user_id: string }>(`${base} where p.location_id = $1`, [a.locationId]);
      return { ids: rows.map((r) => r.user_id), label: `Everyone at ${l.name}` };
    }
    case 'company': {
      const rows = await q<{ user_id: string }>(
        `${base} where lower(trim(p.company)) = lower($1) and ($2::uuid is null or p.location_id = $2)`,
        [a.company, a.locationId ?? null],
      );
      return { ids: rows.map((r) => r.user_id), label: `People at ${a.company}` };
    }
    case 'cafe': {
      const c = await one<{ name: string }>(`select name from cafes where id = $1`, [a.cafeId]);
      if (!c) throw notFound('Cafe not found');
      const rows = await q<{ user_id: string }>(
        `${base} where t.user_id in (select user_id from orders where cafe_id = $1 and created_at > now() - interval '90 days')`,
        [a.cafeId],
      );
      return { ids: rows.map((r) => r.user_id), label: `${c.name} customers (last 90 days)` };
    }
    case 'user': {
      const phone = normPhone(a.phone);
      if (!/^\+\d{11,15}$/.test(phone)) throw badRequest('Enter a 10-digit mobile number');
      const rows = await q<{ user_id: string; name: string }>(
        `select distinct t.user_id, p.name from push_tokens t join profiles p on p.id = t.user_id where p.phone = $1`,
        [phone],
      );
      return { ids: rows.map((r) => r.user_id), label: rows[0]?.name ? `${rows[0].name} (${phone})` : phone };
    }
  }
}

export async function notifyRoutes(app: FastifyInstance) {
  /** How many people/devices an audience reaches, before sending. */
  app.post('/v1/admin/notifications/preview', async (req) => {
    await requireAdmin(req, 'notifications.send');
    const audience = Audience.parse((req.body as { audience?: unknown })?.audience);
    const { ids, label } = await resolve(audience);
    const { send, skipped } = await splitToday(ids, audience);
    const devices = send.length
      ? (await one<{ n: number }>(`select count(*)::int as n from push_tokens where user_id = any($1::uuid[])`, [send]))!.n
      : 0;
    // "You sent something to these people a short while ago" warning.
    const last = await one<{ title: string; mins: number }>(
      `select title, (extract(epoch from now() - created_at) / 60)::int as mins from admin_notifications
       where audience_label = $1 and created_at > now() - interval '6 hours' order by created_at desc limit 1`,
      [label],
    );
    return { users: send.length, devices, label, skipped, quiet: quietNow(), lastSent: last ?? null };
  });

  app.post('/v1/admin/notifications', async (req, reply) => {
    const admin = await requireAdmin(req, 'notifications.send');
    const body = Send.parse(req.body);
    const recent = await one<{ n: number }>(
      `select count(*)::int as n from admin_notifications where created_at > now() - interval '1 hour'`,
    );
    if (recent!.n >= MAX_PER_HOUR) throw tooMany('Too many notifications this hour. Please wait a bit.');
    if (quietNow()) throw conflict('Quiet hours (9 PM – 9 AM): promos wait till morning so nobody is woken up.');
    const { ids, label } = await resolve(body.audience);
    if (!ids.length) throw badRequest('Nobody in this group has the app with notifications on yet');
    const { send, skipped } = await splitToday(ids, body.audience);
    if (!send.length) throw conflict('Everyone in this group already got a promo today. Try again tomorrow.');
    // What it opens must be real and available right now (the AI or the admin could point at something stale).
    let target: z.infer<typeof Target> | null = body.target && body.target.type !== 'none' ? body.target : null;
    if (target) {
      const cat = await catalogFor(await audienceLocation(body.audience));
      if (!targetLabel(target, cat)) throw badRequest('What this notification opens is not available right now. Pick another idea.');
      const cafeId = target.type === 'cafe' ? target.id
        : (target.type === 'item' ? cat.items : target.type === 'combo' ? cat.combos : cat.lunches).find((x) => x.id === target!.id)?.cafeId;
      target = { ...target, cafeId } as typeof target;
    }
    const row = await one<{ id: string }>(
      `insert into admin_notifications (title, body, audience, audience_label, users, devices, sent_by, source, angle, target, skipped)
       values ($1, $2, $3, $4, $5, 0, $6, $7, $8, $9, $10)
       returning id, title, body, audience_label as "audienceLabel", users, devices, skipped, created_at as "createdAt"`,
      [body.title, body.body, JSON.stringify(body.audience), label, send.length, admin.userId, body.source, body.angle ?? null,
        target ? JSON.stringify(target) : null, skipped],
    );
    await q(
      `insert into notification_recipients (notification_id, user_id) select $1, unnest($2::uuid[]) on conflict do nothing`,
      [row!.id, send],
    );
    const devices = await pushToUsers(send, body.title, body.body, {
      kind: 'announcement', notificationId: row!.id, ...(target ? { target } : {}),
    });
    await q(`update admin_notifications set devices = $2 where id = $1`, [row!.id, devices]);
    reply.code(201);
    return { ...row, devices };
  });

  type ListQuery = { from?: string; to?: string; locationId?: string; sentBy?: string; source?: string; orders?: string; search?: string; page?: string; pageSize?: string };
  /**
   * Sent notifications, newest first, paged and filtered. Results per row: taps, and orders the people who
   * got it placed within 2 hours after it went out. Also: who has sent (for the filter) and this week's best.
   */
  function sentList(qs: ListQuery) {
    const w = new Where();
    const from = day(qs.from, 'start date');
    const to = day(qs.to, 'end date');
    if (from) w.add(`(n.created_at at time zone 'Asia/Kolkata')::date >= ?::date`, from);
    if (to) w.add(`(n.created_at at time zone 'Asia/Kolkata')::date <= ?::date`, to);
    const loc = uuidOrNull(qs.locationId);
    if (loc) {
      w.add(`(n.audience->>'locationId' = ?::text or (n.audience->>'type' = 'cafe' and exists (
        select 1 from cafes c where c.id::text = n.audience->>'cafeId' and c.location_id = ?::uuid)))`, loc, loc);
    }
    const by = uuidOrNull(qs.sentBy);
    if (by) w.add('n.sent_by = ?', by);
    if (qs.source === 'ai' || qs.source === 'manual') w.add('n.source = ?', qs.source);
    if (qs.search?.trim()) w.add('(n.title ilike ? or n.body ilike ?)', like(qs.search), like(qs.search));
    const base = `
      select n.id, n.title, n.body, n.audience_label as "audienceLabel", n.users, n.devices, n.skipped, n.source, n.angle,
         n.created_at as "createdAt", coalesce(s.name, '') as "sentBy",
         (select count(*)::int from notification_taps t where t.notification_id = n.id) as taps,
         r.orders, r.sales
       from admin_notifications n left join admins s on s.id = n.sent_by
       left join lateral (
         select count(o.id)::int as orders, coalesce(sum(o.total), 0)::int as sales
         from notification_recipients nr join orders o on o.user_id = nr.user_id
         where nr.notification_id = n.id and o.created_at between n.created_at and n.created_at + interval '2 hours'
           and o.status not in ('cancelled', 'rejected')
       ) r on true
       where ${w.sql}`;
    const outer = qs.orders === 'yes' ? 'where x.orders > 0' : '';
    return { w, sql: `select * from (${base}) x ${outer}` };
  }

  app.get<{ Querystring: ListQuery }>('/v1/admin/notifications.csv', async (req, reply) => {
    await requireAdmin(req, 'notifications.view');
    const { w, sql } = sentList(req.query);
    const rows = await q<any>(`${sql} order by x."createdAt" desc limit 20000`, w.params);
    return sendCsv(reply, `towerbites_notifications_${new Date().toISOString().slice(0, 10)}.csv`, csv([
      ['Sent at', 'Title', 'Message', 'To', 'Sent by', 'Kind', 'People', 'Phones', 'Skipped', 'Taps', 'Tapped %', 'Orders (2h)', 'Sales (2h, ₹)'],
      ...rows.map((n) => [
        new Date(n.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), n.title, n.body, n.audienceLabel, n.sentBy,
        n.source === 'ai' ? `AI${n.angle ? ` (${n.angle})` : ''}` : 'Manual', n.users, n.devices, n.skipped ?? 0, n.taps,
        n.users ? Math.round((n.taps / n.users) * 100) : 0, n.orders, n.sales,
      ]),
    ]));
  });

  app.get<{ Querystring: ListQuery }>('/v1/admin/notifications', async (req) => {
    await requireAdmin(req, 'notifications.view');
    const qs = req.query;
    const pg = paging(qs);
    const { w, sql } = sentList(qs);
    const [count] = await q<{ n: number }>(`select count(*)::int as n from (${sql}) c`, w.params);
    const rows = await q(`${sql} order by x."createdAt" desc limit ${w.p(pg.limit)} offset ${w.p(pg.offset)}`, w.params);
    // This week: the best tap rate (10+ people) and tap rate per kind of AI idea, for the badge and the tip.
    const week = await q<{ id: string; angle: string | null; source: string; users: number; taps: number }>(
      `select n.id, n.angle, n.source, n.users,
         (select count(*)::int from notification_taps t where t.notification_id = n.id) as taps
       from admin_notifications n where n.created_at > now() - interval '7 days' and n.users > 0`,
    );
    const best = week.filter((x) => x.users >= 10 && x.taps > 0).sort((a, b) => b.taps / b.users - a.taps / a.users)[0]?.id ?? null;
    const angles: Record<string, { users: number; taps: number }> = {};
    for (const x of week) {
      if (x.source !== 'ai' || !x.angle) continue;
      const a = (angles[x.angle] ??= { users: 0, taps: 0 });
      a.users += x.users;
      a.taps += x.taps;
    }
    const senders = await q<{ id: string; name: string }>(
      `select distinct s.id, s.name from admin_notifications n join admins s on s.id = n.sent_by order by s.name`,
    );
    return { rows, total: count.n, page: pg.page, pageSize: pg.pageSize, best, angles, senders };
  });

  /** AI ideas for an audience: looks at weather, time and what is going on, then checks each idea. */
  app.post('/v1/admin/notifications/generate', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const admin = await requireAdmin(req, 'notifications.send');
    const body = z.object({
      audience: Audience,
      note: z.string().trim().max(200).default(''),
      style: z.enum(AI_STYLES).optional(),
    }).parse(req.body);
    const cfg = await aiConfig();
    if (!cfg.apiKey) throw badRequest('Add your OpenAI key first (Admin → AI settings).');
    const used = (await one<{ n: number }>(
      `select count(*)::int as n from ai_generations where created_at >= ((now() at time zone 'Asia/Kolkata')::date at time zone 'Asia/Kolkata')`,
    ))!.n;
    if (used >= cfg.dailyLimit) throw tooMany(`Today's ${cfg.dailyLimit} AI ideas are used up. More tomorrow (or raise the limit in AI settings).`);
    const locationId = await audienceLocation(body.audience);
    const s = await situation(locationId);
    if (!s.catalog.openCafes.length) throw conflict('No cafe is open here right now, so there is nothing to suggest.');
    let ideas;
    try {
      ideas = await askOpenAi(cfg, s, body.note, body.style ?? cfg.style);
    } catch (e) {
      await q(`insert into ai_generations (admin_id, location_id, ok) values ($1, $2, false)`, [admin.userId, locationId]);
      if (e instanceof AiError) throw badRequest(e.message);
      throw e;
    }
    await q(`insert into ai_generations (admin_id, location_id) values ($1, $2)`, [admin.userId, locationId]);
    const checked = ideas.map((i) => checkIdea(i, s.catalog)).sort((a, b) => Number(b.ok) - Number(a.ok));
    return {
      ideas: checked,
      seen: {
        place: s.place,
        time: `${s.time.label} · ${s.time.part}`,
        weather: s.weather ? `${s.weather.summary}, ${s.weather.tempC}°C` : 'not available',
        openCafes: s.catalog.openCafes.length,
        closedCafes: s.catalog.closedCafes.length,
        topToday: s.catalog.items.filter((i) => i.soldToday > 0).slice(0, 3).map((i) => i.name),
        combos: s.catalog.combos.length,
        lunches: s.catalog.lunches.map((l) => `${l.name} (${l.platesLeft} left)`),
      },
      left: Math.max(0, cfg.dailyLimit - used - 1),
    };
  });

  /** The app tells us a notification was tapped (counted once per person, only for people who got it). */
  app.post('/v1/me/notification-tap', async (req) => {
    const user = await requireUser(req);
    const { notificationId } = z.object({ notificationId: z.string().uuid() }).parse(req.body);
    await q(
      `insert into notification_taps (notification_id, user_id)
       select $1, $2 where exists (select 1 from notification_recipients where notification_id = $1 and user_id = $2)
       on conflict do nothing`,
      [notificationId, user.id],
    );
    return { ok: true };
  });
}
