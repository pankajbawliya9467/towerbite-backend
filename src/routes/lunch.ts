import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireCafe, requireUser } from '../auth.js';
import { badRequest, conflict, notFound, tooMany } from '../lib/errors.js';
import { broadcast, cafesChanged } from '../realtime.js';
import { pushToUser } from '../push.js';
import { requireEmployeePhone } from './orders.js';
import { csv, sendCsv } from './reports.js';

/**
 * Lunch pre-booking. A cafe posts a lunch for a day (what's in it, price, how many plates, delivery times).
 * Employees book plates until the booking time that day and can cancel free until the cancel time.
 * All times are India time.
 */

const TZ = 'Asia/Kolkata';
const NOW = `(now() at time zone '${TZ}')`;
const TODAY = `${NOW}::date`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SLOT = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

const LUNCH_SELECT = `
  select l.id, l.cafe_id as "cafeId", to_char(l.day, 'YYYY-MM-DD') as day, l.name, l.items, l.price,
    l.is_veg as "isVeg", l.plates, to_char(l.closes_at, 'HH24:MI') as "closesAt",
    to_char(l.cancel_until, 'HH24:MI') as "cancelUntil", l.slots, l.is_active as "isActive",
    coalesce(b.booked, 0)::int as booked,
    greatest(l.plates - coalesce(b.booked, 0), 0)::int as "left",
    (l.is_active and (l.day + l.closes_at) > ${NOW}) as bookable,
    (select coalesce(json_agg(json_build_object('slot', s, 'plates',
        (select coalesce(sum(x.qty), 0)::int from lunch_bookings x where x.lunch_id = l.id and x.slot = s and x.status <> 'cancelled'))), '[]')
     from unnest(l.slots) s) as "bySlot",
    json_build_object('id', c.id, 'name', c.name, 'place', c.place, 'coverColor', c.cover_color, 'emoji', c.emoji) as cafe
  from lunch_menus l
  join cafes c on c.id = l.cafe_id
  left join lateral (select sum(qty) as booked from lunch_bookings lb where lb.lunch_id = l.id and lb.status <> 'cancelled') b on true`;

const BOOKING_SELECT = `
  select b.id, b.booking_no as "bookingNo", b.lunch_id as "lunchId", b.user_id as "userId",
    to_char(b.day, 'YYYY-MM-DD') as day, b.slot, b.qty, b.price, b.total, b.status,
    b.customer_name as "customerName", b.customer_phone as "customerPhone",
    json_build_object('tower', b.tower, 'floor', b.floor, 'company', b.company, 'desk', b.desk) as address,
    b.note, b.created_at as "createdAt", b.out_at as "outAt", b.delivered_at as "deliveredAt", b.cancelled_at as "cancelledAt",
    (b.status = 'booked' and (b.day + l.cancel_until) > ${NOW}) as "canCancel",
    to_char(l.cancel_until, 'HH24:MI') as "cancelUntil",
    json_build_object('name', l.name, 'items', l.items, 'isVeg', l.is_veg) as lunch,
    json_build_object('id', c.id, 'name', c.name, 'place', c.place, 'coverColor', c.cover_color, 'emoji', c.emoji, 'phone', c.phone) as cafe
  from lunch_bookings b
  join lunch_menus l on l.id = b.lunch_id
  join cafes c on c.id = b.cafe_id`;

const LunchInput = z
  .object({
    day: z.string().regex(DAY),
    name: z.string().trim().min(1).max(60),
    items: z.string().trim().max(240).default(''),
    price: z.number().int().min(0).max(5000),
    isVeg: z.boolean().default(true),
    plates: z.number().int().min(1).max(1000),
    closesAt: z.string().regex(HHMM).default('11:30'),
    cancelUntil: z.string().regex(HHMM).default('10:30'),
    slots: z.array(z.string().regex(SLOT, 'use 12:30-13:00')).min(1).max(8),
    /** Also post the same lunch on these days (the "repeat" option). */
    alsoOn: z.array(z.string().regex(DAY)).max(30).default([]),
  })
  .refine((v) => v.cancelUntil <= v.closesAt, { message: 'Free cancel time must be on or before the booking close time', path: ['cancelUntil'] })
  .refine((v) => v.slots.every((s) => s.slice(0, 5) < s.slice(6)), { message: 'Each delivery time must end after it starts', path: ['slots'] });

const BookInput = z.object({
  lunchId: z.string().uuid(),
  slot: z.string().regex(SLOT),
  qty: z.number().int().min(1).max(3),
  address: z.object({
    tower: z.string().trim().min(1).max(40),
    floor: z.string().trim().min(1).max(20),
    company: z.string().trim().max(80).default(''),
    desk: z.string().trim().min(1).max(40),
  }),
  note: z.string().trim().max(120).optional(),
});

/** Days a cafe may post lunch for: today up to 60 days ahead. */
async function checkDays(days: string[]) {
  const row = await one<{ bad: number }>(
    `select count(*)::int as bad from unnest($1::date[]) d where d < ${TODAY} or d > ${TODAY} + 60`,
    [days],
  );
  if (row!.bad) throw badRequest('Pick a day from today up to 60 days ahead');
}

const selectBooking = async (id: string) => one(`${BOOKING_SELECT} where b.id = $1`, [id]);

const ACTIONS = {
  dispatch: { from: ['booked'], to: 'out', set: 'out_at = now()', push: ['Your lunch is on the way', 'coming to your desk now.'] },
  deliver: { from: ['booked', 'out'], to: 'delivered', set: 'delivered_at = now()', push: ['Lunch delivered', 'enjoy your meal!'] },
} as const;

export async function lunchRoutes(app: FastifyInstance) {
  // ---------- Employees ----------

  /** Lunches in a building for today and the next 6 days (public, like the cafe list). */
  app.get<{ Params: { slug: string } }>('/v1/locations/:slug/lunch', async (req) => {
    return q(
      `${LUNCH_SELECT}
       join locations loc on loc.id = c.location_id
       where loc.slug = $1 and loc.is_active and l.is_active and l.day between ${TODAY} and ${TODAY} + 6
       order by l.day, c.sort, c.name, l.price`,
      [req.params.slug],
    );
  });

  /** My lunch bookings: everything from today on, plus the last few. */
  app.get('/v1/lunch/bookings', async (req) => {
    const user = await requireUser(req);
    return q(
      `(${BOOKING_SELECT} where b.user_id = $1 and b.day >= ${TODAY} order by b.day, b.slot)
       union all
       (${BOOKING_SELECT} where b.user_id = $1 and b.day < ${TODAY} order by b.day desc limit 10)`,
      [user.id],
    );
  });

  app.get<{ Params: { id: string } }>('/v1/lunch/bookings/:id', async (req) => {
    const user = await requireUser(req);
    const b = await selectBooking(req.params.id);
    if (!b || b.userId !== user.id) throw notFound('Booking not found');
    return b;
  });

  app.post('/v1/lunch/bookings', async (req, reply) => {
    const user = await requireUser(req);
    requireEmployeePhone(user);
    const body = BookInput.parse(req.body);
    const profile = await one<{ name: string; phone: string | null }>(`select name, phone from profiles where id = $1`, [user.id]);

    const { id, cafeId } = await tx(async (c) => {
      // One booking at a time per person (so the limits below can't be raced), and lock the lunch
      // so two people can't both take the last plate.
      await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`lunch:${user.id}`]);
      const { rows: [l] } = await c.query(
        `select l.id, l.cafe_id, l.day, l.price, l.plates, l.slots, l.name,
           (l.is_active and (l.day + l.closes_at) > ${NOW}) as bookable,
           (select coalesce(sum(qty), 0)::int from lunch_bookings b where b.lunch_id = l.id and b.status <> 'cancelled') as booked
         from lunch_menus l where l.id = $1 for update`,
        [body.lunchId],
      );
      if (!l) throw notFound('Lunch not found');
      if (!l.bookable) throw conflict('Booking for this lunch has closed');
      if (!l.slots.includes(body.slot)) throw badRequest('Pick one of the delivery times');
      if (l.booked + body.qty > l.plates) throw conflict(l.plates - l.booked > 0 ? `Only ${l.plates - l.booked} plates left` : 'Sold out');
      const { rows: [mine] } = await c.query(
        `select count(*) filter (where lunch_id = $2 and status <> 'cancelled')::int as same,
           count(*) filter (where day >= ${TODAY} and status <> 'cancelled')::int as upcoming,
           count(*) filter (where status = 'cancelled' and cancelled_at > now() - interval '7 days')::int as cancels
         from lunch_bookings where user_id = $1`,
        [user.id, l.id],
      );
      if (mine.same) throw conflict('You already booked this lunch. Cancel it first to change it.');
      if (mine.upcoming >= 10) throw tooMany('You can have up to 10 upcoming lunch bookings');
      // Stops someone booking up all the plates and cancelling at the last minute again and again.
      if (mine.cancels >= 5) throw tooMany('Too many cancelled lunch bookings this week. Please try again later.');
      const { rows: [row] } = await c.query(
        `insert into lunch_bookings (lunch_id, cafe_id, user_id, day, slot, qty, price, total,
           customer_name, customer_phone, tower, floor, company, desk, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [l.id, l.cafe_id, user.id, l.day, body.slot, body.qty, l.price, l.price * body.qty,
          profile?.name ?? '', profile?.phone ?? user.phone, body.address.tower, body.address.floor,
          body.address.company, body.address.desk, body.note || null],
      );
      return { id: row.id as string, cafeId: l.cafe_id as string };
    });
    await broadcast(`cafe:${cafeId}`, 'lunch', {});
    reply.code(201);
    return selectBooking(id);
  });

  app.post<{ Params: { id: string } }>('/v1/lunch/bookings/:id/cancel', async (req) => {
    const user = await requireUser(req);
    const row = await one<{ cafe_id: string }>(
      `update lunch_bookings b set status = 'cancelled', cancelled_at = now()
       from lunch_menus l
       where b.id = $1 and b.user_id = $2 and l.id = b.lunch_id and b.status = 'booked'
         and (b.day + l.cancel_until) > ${NOW}
       returning b.cafe_id`,
      [req.params.id, user.id],
    );
    if (!row) throw conflict('This booking can no longer be cancelled');
    await broadcast(`cafe:${row.cafe_id}`, 'lunch', {});
    return selectBooking(req.params.id);
  });

  // ---------- Cafe ----------

  /** Lunches from `from` to `to` (default: today + 6 days), with plates booked per delivery time. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/cafe/lunch', async (req) => {
    const { cafeId } = await requireCafe(req);
    const from = DAY.test(req.query.from ?? '') ? req.query.from : null;
    const to = DAY.test(req.query.to ?? '') ? req.query.to : null;
    return q(
      `${LUNCH_SELECT} where l.cafe_id = $1
         and l.day between coalesce($2::date, ${TODAY}) and coalesce($3::date, ${TODAY} + 13)
       order by l.day, l.created_at`,
      [cafeId, from, to],
    );
  });

  app.post('/v1/cafe/lunch', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const body = LunchInput.parse(req.body);
    const days = [...new Set([body.day, ...body.alsoOn])];
    await checkDays(days);
    const rows = await q<{ id: string }>(
      `insert into lunch_menus (cafe_id, day, name, items, price, is_veg, plates, closes_at, cancel_until, slots)
       select $1, d, $3, $4, $5, $6, $7, $8, $9, $10 from unnest($2::date[]) d returning id`,
      [cafeId, days, body.name, body.items, body.price, body.isVeg, body.plates, body.closesAt, body.cancelUntil, body.slots],
    );
    await locationChanged(cafeId);
    reply.code(201);
    return q(`${LUNCH_SELECT} where l.id = any($1::uuid[]) order by l.day`, [rows.map((r) => r.id)]);
  });

  app.put<{ Params: { id: string } }>('/v1/cafe/lunch/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    const body = LunchInput.parse(req.body);
    await checkDays([body.day]);
    await tx(async (c) => {
      const { rows: [l] } = await c.query(
        `select to_char(l.day, 'YYYY-MM-DD') as day, (select coalesce(sum(qty), 0)::int from lunch_bookings b where b.lunch_id = l.id and b.status <> 'cancelled') as booked,
           (select coalesce(array_agg(distinct slot), '{}') from lunch_bookings b where b.lunch_id = l.id and b.status <> 'cancelled') as used_slots
         from lunch_menus l where l.id = $1 and l.cafe_id = $2 for update`,
        [req.params.id, cafeId],
      );
      if (!l) throw notFound('Lunch not found');
      if (body.plates < l.booked) throw conflict(`${l.booked} plates are already booked. Plates can't be less than that.`);
      const dropped = (l.used_slots as string[]).filter((s) => !body.slots.includes(s));
      if (dropped.length) throw conflict(`People booked ${dropped.join(', ')}. Keep that delivery time.`);
      if (l.booked && body.day !== l.day) throw conflict('People already booked this lunch, so its day can\'t change');
      await c.query(
        `update lunch_menus set day = $3, name = $4, items = $5, price = $6, is_veg = $7, plates = $8,
           closes_at = $9, cancel_until = $10, slots = $11 where id = $1 and cafe_id = $2`,
        [req.params.id, cafeId, body.day, body.name, body.items, body.price, body.isVeg, body.plates,
          body.closesAt, body.cancelUntil, body.slots],
      );
    });
    await locationChanged(cafeId);
    return one(`${LUNCH_SELECT} where l.id = $1`, [req.params.id]);
  });

  /** Stop or restart bookings (the lunch stays, with its bookings). */
  app.patch<{ Params: { id: string } }>('/v1/cafe/lunch/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(req.body);
    const row = await one(`update lunch_menus set is_active = $3 where id = $1 and cafe_id = $2 returning id`, [req.params.id, cafeId, isActive]);
    if (!row) throw notFound('Lunch not found');
    await locationChanged(cafeId);
    return one(`${LUNCH_SELECT} where l.id = $1`, [req.params.id]);
  });

  app.delete<{ Params: { id: string } }>('/v1/cafe/lunch/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    // One statement, so a booking made at the same moment can't be deleted along with the lunch.
    const row = await one(
      `delete from lunch_menus l where l.id = $1 and l.cafe_id = $2
         and not exists (select 1 from lunch_bookings b where b.lunch_id = l.id and b.status <> 'cancelled')
       returning id`,
      [req.params.id, cafeId],
    );
    if (!row) {
      const exists = await one(`select 1 from lunch_menus where id = $1 and cafe_id = $2`, [req.params.id, cafeId]);
      throw exists ? conflict('People have booked this lunch. Stop bookings instead of deleting it.') : notFound('Lunch not found');
    }
    await locationChanged(cafeId);
    return { ok: true };
  });

  /** Bookings for one day (default today), for the kitchen and the delivery round. */
  app.get<{ Querystring: { day?: string } }>('/v1/cafe/lunch/bookings', async (req) => {
    const { cafeId } = await requireCafe(req);
    const day = DAY.test(req.query.day ?? '') ? req.query.day : null;
    return q(
      `${BOOKING_SELECT} where b.cafe_id = $1 and b.day = coalesce($2::date, ${TODAY})
       order by (b.status = 'cancelled'), b.slot, b.tower, b.floor, b.desk`,
      [cafeId, day],
    );
  });

  app.get<{ Querystring: { day?: string } }>('/v1/cafe/lunch/bookings.csv', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const day = DAY.test(req.query.day ?? '') ? req.query.day! : (await one<{ d: string }>(`select to_char(${TODAY}, 'YYYY-MM-DD') as d`))!.d;
    const rows = await q<any>(
      `${BOOKING_SELECT} where b.cafe_id = $1 and b.day = $2::date and b.status <> 'cancelled' order by b.slot, b.tower, b.floor, b.desk`,
      [cafeId, day],
    );
    const head = ['Booking no', 'Delivery time', 'Lunch', 'Plates', 'Total (₹)', 'Name', 'Phone', 'Tower', 'Floor', 'Desk', 'Company', 'Note', 'Status'];
    const body = rows.map((b) => [b.bookingNo, b.slot, b.lunch.name, b.qty, b.total, b.customerName, b.customerPhone,
      b.address.tower, b.address.floor, b.address.desk, b.address.company, b.note, b.status]);
    return sendCsv(reply, `lunch_${day}.csv`, csv([head, ...body]));
  });

  /** Send out every booking in one delivery time at once ("1:00–1:30 is leaving the kitchen"). */
  app.post('/v1/cafe/lunch/dispatch', async (req) => {
    const { cafeId } = await requireCafe(req);
    const { day, slot } = z.object({ day: z.string().regex(DAY), slot: z.string().regex(SLOT) }).parse(req.body);
    const rows = await q<{ id: string; user_id: string }>(
      `update lunch_bookings set status = 'out', out_at = now()
       where cafe_id = $1 and day = $2::date and slot = $3 and status = 'booked' returning id, user_id`,
      [cafeId, day, slot],
    );
    await broadcast(`cafe:${cafeId}`, 'lunch', {});
    for (const r of rows) void pushToUser(r.user_id, 'Your lunch is on the way', 'Coming to your desk now.', { lunchBookingId: r.id });
    return { updated: rows.length };
  });

  app.post<{ Params: { id: string; action: string } }>('/v1/cafe/lunch/bookings/:id/:action', async (req) => {
    const { cafeId } = await requireCafe(req);
    if (!Object.hasOwn(ACTIONS, req.params.action)) throw notFound('Unknown action');
    const a = ACTIONS[req.params.action as keyof typeof ACTIONS];
    const row = await one<{ user_id: string }>(
      `update lunch_bookings set status = '${a.to}', ${a.set}
       where id = $1 and cafe_id = $2 and status = any($3) returning user_id`,
      [req.params.id, cafeId, a.from],
    );
    if (!row) throw conflict('This booking was already updated. Refresh to see the latest.');
    const b = await selectBooking(req.params.id);
    await broadcast(`cafe:${cafeId}`, 'lunch', {});
    void pushToUser(row.user_id, a.push[0], `${b.lunch.name} from ${b.cafe.name}: ${a.push[1]}`, { lunchBookingId: b.id });
    return b;
  });
}

async function locationChanged(cafeId: string) {
  const c = await one<{ location_id: string }>(`select location_id from cafes where id = $1`, [cafeId]);
  await cafesChanged([c?.location_id]);
}
