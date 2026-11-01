import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireUser } from '../auth.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors.js';
import { pushToUser } from '../push.js';
import { createOrder, requireEmployeePhone } from './orders.js';

/**
 * Team orders: the host makes a shared link (a code), teammates add their own items until it closes,
 * the host places ONE order to one place, and the bill is split by what each person added.
 * Anyone logged in who has the code can see the team cart and add to it (the code is the invitation).
 */

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
const CODE = /^[A-Z0-9]{8}$/;
const MAX_PEOPLE = 25;
const MAX_OPEN_PER_HOST = 3;

const CreateTeam = z.object({
  cafeId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  deliverTo: z.string().trim().min(1).max(60),
  deliverAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM').nullable().optional(),
  closesInMin: z.number().int().min(5).max(180).default(15),
  payMode: z.enum(['split', 'host']).default('split'),
  upiId: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.]{1,64}$/, 'enter a UPI ID like name@bank')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
});

const SetItems = z.object({
  items: z.array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1).max(10) })).max(10),
  note: z.string().trim().max(80).optional(),
});

type TeamRow = {
  id: string; code: string; host_id: string; cafe_id: string; name: string; deliver_to: string;
  deliver_at: string | null; closes_at: Date; pay_mode: 'split' | 'host'; host_upi: string | null;
  status: 'open' | 'placed' | 'cancelled'; order_id: string | null; created_at: Date;
  tower: string; floor: string; company: string;
  cafe_name: string; cafe_place: string; cafe_color: string; cafe_emoji: string; host_name: string | null;
};

async function teamByCode(code: string) {
  if (!CODE.test(code)) throw notFound('Team order not found');
  const t = await one<TeamRow>(
    `select t.*, to_char(t.deliver_at, 'HH24:MI') as deliver_at, c.name as cafe_name, c.place as cafe_place,
       c.cover_color as cafe_color, c.emoji as cafe_emoji, p.name as host_name
     from team_orders t join cafes c on c.id = t.cafe_id left join profiles p on p.id = t.host_id
     where t.code = $1`,
    [code],
  );
  if (!t) throw notFound('Team order not found');
  return t;
}

const isClosed = (t: TeamRow) => t.status === 'open' && t.closes_at.getTime() <= Date.now();

/** Everything the team screen shows, from `userId`'s point of view. */
async function teamView(t: TeamRow, userId: string) {
  const [members, items, order] = await Promise.all([
    q<{ user_id: string; name: string; note: string | null; paid_at: Date | null; claimed_at: Date | null }>(
      `select user_id, name, note, paid_at, claimed_at from team_members where team_id = $1
       order by (user_id = $2) desc, joined_at`,
      [t.id, t.host_id],
    ),
    q<{ user_id: string; menu_item_id: string; qty: number; name: string; price: number; emoji: string; is_available: boolean }>(
      `select ti.user_id, ti.menu_item_id, ti.qty, i.name, i.price, i.emoji, i.is_available
       from team_items ti join menu_items i on i.id = ti.menu_item_id where ti.team_id = $1 order by ti.added_at`,
      [t.id],
    ),
    t.order_id
      ? one<{ id: string; order_no: number; status: string; total: number }>(
          `select id, order_no, status, total from orders where id = $1`,
          [t.order_id],
        )
      : undefined,
  ]);
  const people = members.map((m) => {
    const mine = items.filter((i) => i.user_id === m.user_id);
    const amount = mine.reduce((s, i) => s + i.price * i.qty, 0);
    const isHost = m.user_id === t.host_id;
    return {
      userId: m.user_id,
      name: m.name || 'Teammate',
      note: m.note,
      isHost,
      isMe: m.user_id === userId,
      items: mine.map((i) => ({ menuItemId: i.menu_item_id, name: i.name, emoji: i.emoji, price: i.price, qty: i.qty, isAvailable: i.is_available })),
      amount,
      // What this person owes the host (nothing when the host is paying for everyone).
      owes: isHost || t.pay_mode === 'host' ? 0 : amount,
      paid: isHost || t.pay_mode === 'host' || !!m.paid_at,
      /** Said "I paid"; waits for the host to confirm. */
      claimed: !m.paid_at && !!m.claimed_at,
    };
  });
  const withItems = people.filter((p) => p.items.length);
  const total = withItems.reduce((s, p) => s + p.amount, 0);
  const me = people.find((p) => p.isMe) ?? null;
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    deliverTo: t.deliver_to,
    deliverAt: t.deliver_at,
    closesAt: t.closes_at.toISOString(),
    payMode: t.pay_mode,
    upiId: t.pay_mode === 'split' ? t.host_upi : null,
    status: isClosed(t) ? 'closed' : t.status,
    isHost: t.host_id === userId,
    hostName: t.host_name || 'Your teammate',
    cafe: { id: t.cafe_id, name: t.cafe_name, place: t.cafe_place, coverColor: t.cafe_color, emoji: t.cafe_emoji },
    people,
    peopleWithItems: withItems.length,
    itemCount: items.reduce((s, i) => s + i.qty, 0),
    total,
    toCollect: people.reduce((s, p) => s + p.owes, 0),
    collected: people.reduce((s, p) => s + (p.paid ? p.owes : 0), 0),
    me,
    order: order ? { id: order.id, orderNo: order.order_no, status: order.status, total: order.total } : null,
    createdAt: t.created_at.toISOString(),
  };
}

/** Push to everyone in the team except `exceptUserId` (used when the order is placed or moves along). */
export async function pushTeam(teamId: string, exceptUserId: string | null, title: string, body: string, data: Record<string, unknown>) {
  const members = await q<{ user_id: string }>(
    `select distinct m.user_id from team_members m join team_items ti on ti.team_id = m.team_id and ti.user_id = m.user_id
     where m.team_id = $1`,
    [teamId],
  );
  await Promise.all(members.filter((m) => m.user_id !== exceptUserId).map((m) => pushToUser(m.user_id, title, body, data)));
}

/** Called after a cafe moves an order: teammates (not just the host) hear about their team order. */
export async function pushTeamForOrder(orderId: string, hostId: string, title: string, body: string) {
  const t = await one<{ id: string; code: string; name: string }>(`select id, code, name from team_orders where order_id = $1`, [orderId]);
  if (t) await pushTeam(t.id, hostId, `${t.name}: ${title}`, body, { teamCode: t.code });
}

export async function teamRoutes(app: FastifyInstance) {
  app.post('/v1/team-orders', async (req, reply) => {
    const user = await requireUser(req);
    requireEmployeePhone(user);
    const body = CreateTeam.parse(req.body);
    const cafe = await one<{ id: string; location_id: string; name: string; is_open: boolean; accepting_orders: boolean }>(
      `select id, location_id, name, is_open, accepting_orders from cafes where id = $1`,
      [body.cafeId],
    );
    if (!cafe) throw notFound('Cafe not found');
    if (!cafe.is_open || !cafe.accepting_orders) throw conflict(`${cafe.name} is not taking orders right now`);
    const profile = await one<{ name: string; tower: string; floor: string; company: string }>(
      `select name, tower, floor, company from profiles where id = $1`,
      [user.id],
    );
    if (!profile?.tower || !profile.floor) throw badRequest('Add your tower and floor first (Profile → Desk address)');
    const code = await tx(async (c) => {
      // Checked under a per-user lock, so parallel requests can't get past the limit.
      await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`team:${user.id}`]);
      const { rows: [open] } = await c.query(
        `select count(*)::int as n from team_orders where host_id = $1 and status = 'open' and created_at > now() - interval '1 day'`,
        [user.id],
      );
      if (open.n >= MAX_OPEN_PER_HOST) throw tooMany('You already have 3 open team orders. Place or cancel one first.');
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const { rows } = await c.query(
          `insert into team_orders (code, host_id, cafe_id, location_id, name, deliver_to, deliver_at, closes_at,
             pay_mode, host_upi, tower, floor, company)
           values ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(mins => $8), $9,$10,$11,$12,$13)
           on conflict (code) do nothing returning id`,
          [code, user.id, cafe.id, cafe.location_id, body.name, body.deliverTo, body.deliverAt ?? null, body.closesInMin,
            body.payMode, body.upiId ?? null, profile.tower, profile.floor, profile.company],
        );
        if (rows[0]) {
          await c.query(`insert into team_members (team_id, user_id, name) values ($1, $2, $3)`, [rows[0].id, user.id, profile.name]);
          return code;
        }
      }
      throw conflict('Please try again');
    });
    reply.code(201);
    return teamView(await teamByCode(code), user.id);
  });

  /** Team orders I started or joined (last 2 weeks). */
  app.get('/v1/team-orders', async (req) => {
    const user = await requireUser(req);
    const codes = await q<{ code: string }>(
      `select t.code from team_orders t
       where t.created_at > now() - interval '14 days'
         and (t.host_id = $1 or exists (select 1 from team_members m where m.team_id = t.id and m.user_id = $1))
       order by t.created_at desc limit 20`,
      [user.id],
    );
    const teams = await Promise.all(codes.map(async ({ code }) => teamView(await teamByCode(code), user.id)));
    return teams.map(({ people: _people, ...t }) => t);
  });

  app.get<{ Params: { code: string } }>('/v1/team-orders/:code', async (req) => {
    const user = await requireUser(req);
    return teamView(await teamByCode(req.params.code.toUpperCase()), user.id);
  });

  /** Sets (replaces) my items. Joining a team order is just adding items to it. */
  app.put<{ Params: { code: string } }>('/v1/team-orders/:code/items', async (req) => {
    const user = await requireUser(req);
    requireEmployeePhone(user);
    const body = SetItems.parse(req.body);
    const t = await teamByCode(req.params.code.toUpperCase());
    const isHost = t.host_id === user.id;
    if (t.status !== 'open') throw conflict(t.status === 'placed' ? 'This team order was already placed' : 'This team order was cancelled');
    if (isClosed(t) && !isHost) throw conflict(`Adding closed. Ask ${t.host_name || 'the host'} to add it for you.`);

    const ids = [...new Set(body.items.map((i) => i.menuItemId))];
    if (ids.length) {
      const menu = await q<{ id: string; name: string; is_available: boolean }>(
        `select id, name, is_available from menu_items where cafe_id = $1 and id = any($2::uuid[])`,
        [t.cafe_id, ids],
      );
      if (menu.length !== ids.length) throw badRequest(`Some items are not on ${t.cafe_name}'s menu`);
      const out = menu.filter((m) => !m.is_available);
      if (out.length) throw conflict(`${out.map((m) => m.name).join(', ')} is out of stock`);
    }

    await tx(async (c) => {
      // Lock the team so the "max people" check and the placing of the order can't race with this.
      const { rows: [locked] } = await c.query(`select status from team_orders where id = $1 for update`, [t.id]);
      if (locked.status !== 'open') throw conflict('This team order was already placed');
      const profile = await c.query(`select name from profiles where id = $1`, [user.id]);
      await c.query(
        `insert into team_members (team_id, user_id, name, note) values ($1, $2, $3, $4)
         on conflict (team_id, user_id) do update set note = excluded.note, name = excluded.name`,
        [t.id, user.id, profile.rows[0]?.name ?? '', body.note || null],
      );
      await c.query(`delete from team_items where team_id = $1 and user_id = $2`, [t.id, user.id]);
      const qty = new Map<string, number>();
      for (const it of body.items) qty.set(it.menuItemId, Math.min(10, (qty.get(it.menuItemId) ?? 0) + it.qty));
      for (const [id, n] of qty) {
        await c.query(`insert into team_items (team_id, user_id, menu_item_id, qty) values ($1, $2, $3, $4)`, [t.id, user.id, id, n]);
      }
      const { rows: [count] } = await c.query(`select count(distinct user_id)::int as n from team_items where team_id = $1`, [t.id]);
      if (count.n > MAX_PEOPLE) throw conflict(`A team order can have up to ${MAX_PEOPLE} people`);
    });
    return teamView(await teamByCode(t.code), user.id);
  });

  /** Host places the one order for everyone. */
  app.post<{ Params: { code: string } }>('/v1/team-orders/:code/place', async (req, reply) => {
    const user = await requireUser(req);
    requireEmployeePhone(user);
    const t = await teamByCode(req.params.code.toUpperCase());
    if (t.host_id !== user.id) throw forbidden('Only the person who started this team order can place it');
    if (t.status !== 'open') throw conflict('This team order was already placed or cancelled');
    const view = await teamView(t, user.id);
    const withItems = view.people.filter((p) => p.items.length);
    if (!withItems.length) throw badRequest('Nobody has added anything yet');
    const unavailable = withItems.flatMap((p) => p.items).filter((i) => !i.isAvailable);
    if (unavailable.length) throw conflict(`${[...new Set(unavailable.map((i) => i.name))].join(', ')} just went out of stock`);

    const at = t.deliver_at ? ` at ${toAmPm(t.deliver_at)}` : '';
    const lines = withItems.map((p) => `${p.name}: ${p.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}${p.note ? ` (${p.note})` : ''}`);
    const note = [`Team order "${t.name}" for ${withItems.length} people. Deliver to ${t.deliver_to}${at}.`, ...lines].join('\n');

    const order = await createOrder({
      user,
      cafeId: t.cafe_id,
      items: withItems.flatMap((p) => p.items.map((i) => ({ menuItemId: i.menuItemId, qty: i.qty }))),
      address: { tower: t.tower, floor: t.floor, company: t.company, desk: t.deliver_to },
      note,
      saveAddress: false,
      inTx: async (c, orderId) => {
        const { rowCount } = await c.query(
          `update team_orders set status = 'placed', order_id = $2 where id = $1 and status = 'open'`,
          [t.id, orderId],
        );
        if (!rowCount) throw conflict('This team order was already placed');
      },
    });
    void pushTeam(t.id, user.id, `Team order placed: ${t.name}`,
      `${t.cafe_name} is making it. Coming to ${t.deliver_to}${at}.`, { teamCode: t.code });
    reply.code(201);
    return { order, team: await teamView(await teamByCode(t.code), user.id) };
  });

  app.post<{ Params: { code: string } }>('/v1/team-orders/:code/cancel', async (req) => {
    const user = await requireUser(req);
    const t = await teamByCode(req.params.code.toUpperCase());
    if (t.host_id !== user.id) throw forbidden('Only the person who started this team order can cancel it');
    const row = await one(`update team_orders set status = 'cancelled' where id = $1 and status = 'open' returning id`, [t.id]);
    if (!row) throw conflict('This team order was already placed or cancelled');
    void pushTeam(t.id, user.id, `Team order cancelled: ${t.name}`, `${t.host_name || 'The host'} cancelled it.`, { teamCode: t.code });
    return teamView(await teamByCode(t.code), user.id);
  });

  /**
   * Teammate: "I paid" (a claim the host sees). Host: confirms (or undoes) anyone's payment;
   * only the host's confirmation counts as collected, since the host is the one being paid.
   */
  app.post<{ Params: { code: string } }>('/v1/team-orders/:code/paid', async (req) => {
    const user = await requireUser(req);
    const body = z.object({ userId: z.string().uuid().optional(), paid: z.boolean().default(true) }).parse(req.body ?? {});
    const t = await teamByCode(req.params.code.toUpperCase());
    const target = body.userId ?? user.id;
    const isHost = t.host_id === user.id;
    if (target !== user.id && !isHost) throw forbidden('Only the host can change someone else\'s payment');
    if (t.status !== 'placed') throw conflict('The team order is not placed yet');
    const row = isHost
      ? await one(
          `update team_members set paid_at = case when $3 then coalesce(paid_at, now()) else null end,
             claimed_at = case when $3 then claimed_at else null end
           where team_id = $1 and user_id = $2 returning user_id`,
          [t.id, target, body.paid],
        )
      : await one(
          `update team_members set claimed_at = case when $3 then coalesce(claimed_at, now()) else null end
           where team_id = $1 and user_id = $2 returning user_id`,
          [t.id, target, body.paid],
        );
    if (!row) throw notFound('Not in this team order');
    return teamView(await teamByCode(t.code), user.id);
  });

  /** Host nudges someone who hasn't paid yet (at most once every 10 minutes per person). */
  app.post<{ Params: { code: string } }>('/v1/team-orders/:code/remind', async (req) => {
    const user = await requireUser(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const t = await teamByCode(req.params.code.toUpperCase());
    if (t.host_id !== user.id) throw forbidden('Only the host can send reminders');
    const view = await teamView(t, user.id);
    const person = view.people.find((p) => p.userId === userId);
    if (!person || person.paid || !person.owes) throw conflict('Nothing to remind about');
    if (person.claimed) throw conflict(`${person.name} says they paid. Confirm it if you got the money.`);
    const row = await one(
      `update team_members set reminded_at = now()
       where team_id = $1 and user_id = $2 and (reminded_at is null or reminded_at < now() - interval '10 minutes')
       returning user_id`,
      [t.id, userId],
    );
    if (!row) throw tooMany('Already reminded. Try again in a few minutes.');
    void pushToUser(userId, `Pay ₹${person.owes} for ${t.name}`, `${view.hostName} paid for the team order. Tap to pay your share.`, { teamCode: t.code });
    return { ok: true };
  });
}

/** "16:00" → "4:00 PM" */
export function toAmPm(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
