import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireCafe, requireUser } from '../auth.js';
import { badRequest, conflict, notFound, tooMany } from '../lib/errors.js';
import { cafeCombos } from '../lib/combos.js';
import { cafesChanged } from '../realtime.js';
import { pushToUser } from '../push.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');

const ComboBody = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(120).default(''),
  price: z.number().int().min(0).max(100000),
  emoji: z.string().trim().min(1).max(8).default('🍱'),
  imageUrl: z.string().trim().url().max(500).startsWith('https://').nullable().default(null),
  startTime: hhmm.nullable().default(null),
  endTime: hhmm.nullable().default(null),
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5, 6, 7]),
  isActive: z.boolean().default(true),
  sort: z.number().int().min(0).max(10000).default(0),
  items: z.array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1).max(10) })).min(1).max(6),
});

/** Tags a customer can pick. Kept as keys; the apps show the words. */
export const GOOD_TAGS = ['hot', 'on_time', 'tasty', 'packing', 'value'] as const;
export const BAD_TAGS = ['cold', 'late', 'missing', 'taste', 'quantity'] as const;
const TAGS = [...GOOD_TAGS, ...BAD_TAGS] as string[];

const RateBody = z.object({
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.string()).max(10).default([]),
  comment: z.string().trim().max(300).default(''),
  /** menuItemId → liked (thumbs up) / not */
  items: z.record(z.string().uuid(), z.boolean()).default({}),
});

/** Checks the combo body against the cafe's menu and returns the cleaned items. */
async function checkCombo(cafeId: string, body: z.infer<typeof ComboBody>) {
  if ((body.startTime === null) !== (body.endTime === null)) throw badRequest('Set both start and end time, or neither');
  if (body.startTime && body.startTime === body.endTime) throw badRequest('Start and end time cannot be the same');
  const ids = [...new Set(body.items.map((i) => i.menuItemId))];
  if (ids.length !== body.items.length) throw badRequest('Each item only once (use the quantity)');
  const menu = await q<{ id: string; price: number }>(`select id, price from menu_items where cafe_id = $1 and id = any($2::uuid[])`, [cafeId, ids]);
  if (menu.length !== ids.length) throw badRequest('Pick items from this cafe\'s menu');
  if (body.items.length === 1 && body.items[0].qty === 1) throw badRequest('A combo needs at least two things');
  const mrp = body.items.reduce((s, i) => s + menu.find((m) => m.id === i.menuItemId)!.price * i.qty, 0);
  if (body.price > mrp) throw badRequest(`Combo price can't be more than the items cost separately (₹${mrp})`);
  return [...new Set(body.days)].sort();
}

async function saveItems(c: Parameters<Parameters<typeof tx>[0]>[0], comboId: string, items: { menuItemId: string; qty: number }[]) {
  await c.query(`delete from combo_items where combo_id = $1`, [comboId]);
  for (const i of items) {
    await c.query(`insert into combo_items (combo_id, menu_item_id, qty) values ($1, $2, $3)`, [comboId, i.menuItemId, i.qty]);
  }
}

async function locationOfCafe(cafeId: string) {
  return (await one<{ location_id: string }>(`select location_id from cafes where id = $1`, [cafeId]))?.location_id;
}

export async function comboRoutes(app: FastifyInstance) {
  // ---------- Combos (cafe) ----------
  app.get('/v1/cafe/combos', async (req) => {
    const { cafeId } = await requireCafe(req);
    const [combos, sold] = await Promise.all([
      cafeCombos(cafeId, false),
      q<{ combo_id: string; n: number }>(
        `select oi.combo_id, sum(oi.qty)::int as n from order_items oi join orders o on o.id = oi.order_id
         where o.cafe_id = $1 and oi.combo_id is not null and o.status = 'delivered' and o.created_at > now() - interval '7 days'
         group by 1`,
        [cafeId],
      ),
    ]);
    return combos.map((x) => ({ ...x, soldWeek: sold.find((s) => s.combo_id === x.id)?.n ?? 0 }));
  });

  app.post('/v1/cafe/combos', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const body = ComboBody.parse(req.body);
    const days = await checkCombo(cafeId, body);
    const count = await one<{ n: number }>(`select count(*)::int as n from combos where cafe_id = $1`, [cafeId]);
    if ((count?.n ?? 0) >= 30) throw conflict('A cafe can have up to 30 combos');
    const id = await tx(async (c) => {
      const { rows } = await c.query(
        `insert into combos (cafe_id, name, description, price, emoji, image_url, start_time, end_time, days, is_active, sort)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [cafeId, body.name, body.description, body.price, body.emoji, body.imageUrl, body.startTime, body.endTime, days, body.isActive, body.sort],
      );
      await saveItems(c, rows[0].id, body.items);
      return rows[0].id as string;
    });
    await cafesChanged([await locationOfCafe(cafeId)]);
    reply.code(201);
    return (await cafeCombos(cafeId, false)).find((x) => x.id === id);
  });

  app.patch<{ Params: { id: string } }>('/v1/cafe/combos/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.id);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    // Just switching it on/off
    if (Object.keys(raw).length === 1 && typeof raw.isActive === 'boolean') {
      const row = await one(`update combos set is_active = $3 where id = $1 and cafe_id = $2 returning id`, [req.params.id, cafeId, raw.isActive]);
      if (!row) throw notFound('Combo not found');
    } else {
      const body = ComboBody.parse(raw);
      const days = await checkCombo(cafeId, body);
      await tx(async (c) => {
        const { rows } = await c.query(
          `update combos set name = $3, description = $4, price = $5, emoji = $6, image_url = $7, start_time = $8, end_time = $9,
             days = $10, is_active = $11, sort = $12 where id = $1 and cafe_id = $2 returning id`,
          [req.params.id, cafeId, body.name, body.description, body.price, body.emoji, body.imageUrl, body.startTime, body.endTime, days, body.isActive, body.sort],
        );
        if (!rows.length) throw notFound('Combo not found');
        await saveItems(c, req.params.id, body.items);
      });
    }
    await cafesChanged([await locationOfCafe(cafeId)]);
    return (await cafeCombos(cafeId, false)).find((x) => x.id === req.params.id);
  });

  app.delete<{ Params: { id: string } }>('/v1/cafe/combos/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.id);
    const row = await one(`delete from combos where id = $1 and cafe_id = $2 returning id`, [req.params.id, cafeId]);
    if (!row) throw notFound('Combo not found');
    await cafesChanged([await locationOfCafe(cafeId)]);
    return { ok: true };
  });

  /** The two items most often ordered together in the last 30 days (a combo idea). */
  app.get('/v1/cafe/combos/suggestion', async (req) => {
    const { cafeId } = await requireCafe(req);
    const pair = await one<{ a: string; b: string; an: string; bn: string; ap: number; bp: number; together: number; with_a: number }>(
      `with lines as (
         select distinct oi.order_id, oi.menu_item_id from order_items oi join orders o on o.id = oi.order_id
         where o.cafe_id = $1 and o.status = 'delivered' and o.created_at > now() - interval '30 days' and oi.menu_item_id is not null
       ), pairs as (
         select x.menu_item_id as a, y.menu_item_id as b, count(*)::int as together
         from lines x join lines y on x.order_id = y.order_id and x.menu_item_id <> y.menu_item_id
         group by 1, 2
       )
       select p.a, p.b, ia.name as an, ib.name as bn, ia.price as ap, ib.price as bp, p.together,
         (select count(*)::int from lines l where l.menu_item_id = p.a) as with_a
       from pairs p join menu_items ia on ia.id = p.a join menu_items ib on ib.id = p.b
       where ia.is_available and ib.is_available
         and not exists (select 1 from combo_items c1 join combo_items c2 on c2.combo_id = c1.combo_id
                         where c1.menu_item_id = p.a and c2.menu_item_id = p.b)
       order by p.together desc, ia.price desc limit 1`,
      [cafeId],
    );
    if (!pair || pair.together < 3) return null;
    return {
      a: { menuItemId: pair.a, name: pair.an, price: pair.ap },
      b: { menuItemId: pair.b, name: pair.bn, price: pair.bp },
      orders: pair.together,
      pct: Math.round((pair.together / Math.max(1, pair.with_a)) * 100),
    };
  });

  // ---------- Ratings (customer) ----------
  app.post<{ Params: { id: string } }>('/v1/orders/:id/rating', async (req, reply) => {
    const user = await requireUser(req);
    z.string().uuid().parse(req.params.id);
    const body = RateBody.parse(req.body);
    const tags = [...new Set(body.tags)].filter((t) => TAGS.includes(t));
    const order = await one<{ cafe_id: string; status: string; delivered_at: Date | null }>(
      `select cafe_id, status, delivered_at from orders where id = $1 and user_id = $2`,
      [req.params.id, user.id],
    );
    if (!order) throw notFound('Order not found');
    if (order.status !== 'delivered') throw conflict('You can rate an order after it is delivered');
    if (order.delivered_at && Date.now() - new Date(order.delivered_at).getTime() > 7 * 86400_000) throw conflict('Ratings close 7 days after delivery');
    const lineIds = (await q<{ id: string }>(`select distinct menu_item_id as id from order_items where order_id = $1 and menu_item_id is not null`, [req.params.id])).map((r) => r.id);
    const votes = Object.entries(body.items).filter(([id]) => lineIds.includes(id));

    const ok = await tx(async (c) => {
      const { rows } = await c.query(
        `insert into order_ratings (order_id, user_id, cafe_id, stars, tags, comment) values ($1,$2,$3,$4,$5,$6)
         on conflict (order_id) do nothing returning order_id`,
        [req.params.id, user.id, order.cafe_id, body.stars, tags, body.comment],
      );
      if (!rows.length) return false;
      for (const [id, liked] of votes) {
        await c.query(`insert into rating_items (order_id, menu_item_id, liked) values ($1,$2,$3)`, [req.params.id, id, liked]);
      }
      // Running average on the cafe card.
      await c.query(
        `update cafes set rating = round(((rating * rating_count) + $2) / (rating_count + 1), 1), rating_count = rating_count + 1 where id = $1`,
        [order.cafe_id, body.stars],
      );
      return true;
    });
    if (!ok) throw conflict('You already rated this order');
    reply.code(201);
    return { stars: body.stars, tags };
  });

  // ---------- Ratings (cafe) ----------
  app.get<{ Querystring: { days?: string } }>('/v1/cafe/ratings', async (req) => {
    const { cafeId } = await requireCafe(req);
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
    const [totals, prev, dist, tags, items, list] = await Promise.all([
      one<{ avg: number | null; count: number; low: number; delivered: number; on_time: number; avg_min: number | null }>(
        `select (select round(avg(stars)::numeric, 1)::float from order_ratings where cafe_id = $1 and created_at > now() - make_interval(days => $2)) as avg,
           (select count(*)::int from order_ratings where cafe_id = $1 and created_at > now() - make_interval(days => $2)) as count,
           (select count(*)::int from order_ratings where cafe_id = $1 and stars <= 2 and resolved_at is null
              and created_at > now() - make_interval(days => $2)) as low,
           count(*)::int as delivered,
           count(*) filter (where o.delivered_at - o.created_at <= make_interval(mins => c.eta_max + 5))::int as on_time,
           round(avg(extract(epoch from o.delivered_at - o.created_at) / 60))::int as avg_min
         from orders o join cafes c on c.id = o.cafe_id
         where o.cafe_id = $1 and o.status = 'delivered' and o.delivered_at is not null and o.created_at > now() - make_interval(days => $2)`,
        [cafeId, days],
      ),
      one<{ avg: number | null }>(
        `select round(avg(stars)::numeric, 1)::float as avg from order_ratings
         where cafe_id = $1 and created_at <= now() - make_interval(days => $2) and created_at > now() - make_interval(days => $2 * 2)`,
        [cafeId, days],
      ),
      q<{ stars: number; n: number }>(
        `select stars, count(*)::int as n from order_ratings where cafe_id = $1 and created_at > now() - make_interval(days => $2) group by 1`,
        [cafeId, days],
      ),
      q<{ tag: string; n: number }>(
        `select t as tag, count(*)::int as n from order_ratings, unnest(tags) t
         where cafe_id = $1 and created_at > now() - make_interval(days => $2) group by 1 order by 2 desc`,
        [cafeId, days],
      ),
      q<{ menuItemId: string; name: string; liked: number; total: number }>(
        `select i.id as "menuItemId", i.name, count(*) filter (where ri.liked)::int as liked, count(*)::int as total
         from rating_items ri join order_ratings r on r.order_id = ri.order_id join menu_items i on i.id = ri.menu_item_id
         where r.cafe_id = $1 and r.created_at > now() - make_interval(days => $2)
         group by 1, 2 order by count(*) filter (where not ri.liked) desc, total desc limit 12`,
        [cafeId, days],
      ),
      q(
        `select r.order_id as "orderId", o.order_no as "orderNo", r.stars, r.tags, r.comment, r.created_at as "createdAt",
           r.resolved_at as "resolvedAt", r.sorry_sent_at as "sorrySentAt",
           split_part(coalesce(nullif(o.customer_name, ''), 'Customer'), ' ', 1) as "firstName",
           concat_ws(', ', nullif(o.tower, ''), case when o.floor <> '' then 'Floor ' || o.floor end) as place,
           coalesce((select json_agg(json_build_object('name', i.name, 'liked', ri.liked)) from rating_items ri
              join menu_items i on i.id = ri.menu_item_id where ri.order_id = r.order_id), '[]') as items
         from order_ratings r join orders o on o.id = r.order_id
         where r.cafe_id = $1 and r.created_at > now() - make_interval(days => $2)
         order by (r.stars <= 2 and r.resolved_at is null) desc, r.created_at desc limit 100`,
        [cafeId, days],
      ),
    ]);
    return {
      days,
      avg: totals?.avg ?? null,
      prevAvg: prev?.avg ?? null,
      count: totals?.count ?? 0,
      low: totals?.low ?? 0,
      delivered: totals?.delivered ?? 0,
      onTimePct: totals?.delivered ? Math.round((totals.on_time / totals.delivered) * 100) : null,
      avgMinutes: totals?.avg_min ?? null,
      dist: [5, 4, 3, 2, 1].map((s) => ({ stars: s, n: dist.find((d) => d.stars === s)?.n ?? 0 })),
      tags,
      items,
      list,
    };
  });

  app.post<{ Params: { orderId: string } }>('/v1/cafe/ratings/:orderId/resolve', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.orderId);
    const row = await one(`update order_ratings set resolved_at = coalesce(resolved_at, now()) where order_id = $1 and cafe_id = $2 returning order_id`, [req.params.orderId, cafeId]);
    if (!row) throw notFound('Rating not found');
    return { ok: true };
  });

  /** A short sorry from the cafe to a customer who gave 1–3 stars (once per rating, as a push). */
  app.post<{ Params: { orderId: string } }>('/v1/cafe/ratings/:orderId/sorry', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.orderId);
    const { message } = z.object({ message: z.string().trim().min(5).max(160) }).parse(req.body);
    const recent = await one<{ n: number }>(
      `select count(*)::int as n from order_ratings where cafe_id = $1 and sorry_sent_at > now() - interval '1 hour'`,
      [cafeId],
    );
    if ((recent?.n ?? 0) >= 20) throw tooMany('Too many messages. Try again later.');
    const row = await one<{ user_id: string; name: string }>(
      `update order_ratings r set sorry_sent_at = now(), resolved_at = coalesce(resolved_at, now())
       from cafes c where c.id = r.cafe_id and r.order_id = $1 and r.cafe_id = $2 and r.stars <= 3 and r.sorry_sent_at is null
       returning r.user_id, c.name`,
      [req.params.orderId, cafeId],
    );
    if (!row) throw conflict('A message was already sent for this rating');
    void pushToUser(row.user_id, `Message from ${row.name}`, message, { orderId: req.params.orderId });
    return { ok: true };
  });
}
