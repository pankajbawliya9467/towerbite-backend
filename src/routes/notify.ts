import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { requireAdmin } from '../auth.js';
import { badRequest, notFound, tooMany } from '../lib/errors.js';
import { pushToUsers } from '../push.js';

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

const Send = z.object({
  title: z.string().trim().min(2).max(60),
  body: z.string().trim().min(2).max(180),
  audience: Audience,
});

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
    await requireAdmin(req);
    const audience = Audience.parse((req.body as { audience?: unknown })?.audience);
    const { ids, label } = await resolve(audience);
    const devices = ids.length
      ? (await one<{ n: number }>(`select count(*)::int as n from push_tokens where user_id = any($1::uuid[])`, [ids]))!.n
      : 0;
    return { users: ids.length, devices, label };
  });

  app.post('/v1/admin/notifications', async (req, reply) => {
    const admin = await requireAdmin(req);
    const body = Send.parse(req.body);
    const recent = await one<{ n: number }>(
      `select count(*)::int as n from admin_notifications where created_at > now() - interval '1 hour'`,
    );
    if (recent!.n >= MAX_PER_HOUR) throw tooMany('Too many notifications this hour. Please wait a bit.');
    const { ids, label } = await resolve(body.audience);
    if (!ids.length) throw badRequest('Nobody in this group has the app with notifications on yet');
    const devices = await pushToUsers(ids, body.title, body.body, { kind: 'announcement' });
    const row = await one(
      `insert into admin_notifications (title, body, audience, audience_label, users, devices, sent_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, title, body, audience_label as "audienceLabel", users, devices, created_at as "createdAt"`,
      [body.title, body.body, JSON.stringify(body.audience), label, ids.length, devices, admin.userId],
    );
    reply.code(201);
    return row;
  });

  app.get('/v1/admin/notifications', async (req) => {
    await requireAdmin(req);
    return q(
      `select n.id, n.title, n.body, n.audience_label as "audienceLabel", n.users, n.devices, n.created_at as "createdAt",
         coalesce(s.name, '') as "sentBy"
       from admin_notifications n left join staff s on s.user_id = n.sent_by
       order by n.created_at desc limit 50`,
    );
  });
}
