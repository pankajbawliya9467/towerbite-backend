import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireUser, type AuthUser } from '../auth.js';
import { ACTIVE_STATUSES, selectOrder, selectOrders } from '../lib/sql.js';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors.js';
import { env } from '../env.js';
import { orderChanged } from '../realtime.js';

const PlaceOrder = z.object({
  cafeId: z.string().uuid(),
  items: z
    .array(z.object({ menuItemId: z.string().uuid(), qty: z.number().int().min(1).max(20) }))
    .min(1)
    .max(30),
  address: z.object({
    tower: z.string().trim().min(1).max(40),
    floor: z.string().trim().min(1).max(20),
    company: z.string().trim().max(80).default(''),
    desk: z.string().trim().min(1).max(40),
  }),
  name: z.string().trim().max(80).optional(),
  phone: z.string().trim().max(20).optional(),
  note: z.string().trim().max(200).optional(),
  saveAddress: z.boolean().default(true),
});

/** An employee can have at most this many orders waiting at once (stops spam / fake bulk orders). */
const MAX_ACTIVE_ORDERS = 3;
/** Orders per user in any 10 minutes (counted in the database, so it can't be dodged by changing headers or IP). */
const MAX_ORDERS_PER_10_MIN = 10;

type Address = z.infer<typeof PlaceOrder>['address'];
type PoolClient = Parameters<Parameters<typeof tx>[0]>[0];

/** Only real employees order: a verified mobile number from an allowed country (cafe staff log in with email). */
export function requireEmployeePhone(user: AuthUser) {
  if (!user.phone) throw forbidden('Please log in with your mobile number to order');
  if (env.allowedPhonePrefixes.length && !env.allowedPhonePrefixes.some((p) => user.phone!.startsWith(p)))
    throw forbidden('TowerBites is not available for this phone number');
}

/**
 * Places an order for `user` (prices and stock checked here, never trusted from the app).
 * `inTx` runs inside the same database transaction, after the order is written (team orders use it).
 */
export async function createOrder(input: {
  user: AuthUser;
  cafeId: string;
  items: { menuItemId: string; qty: number }[];
  address: Address;
  name?: string;
  phone?: string;
  note?: string | null;
  saveAddress: boolean;
  inTx?: (c: PoolClient, orderId: string) => Promise<void>;
}) {
  const { user, address } = input;
  const cafe = await one<{ id: string; location_id: string; is_open: boolean; accepting_orders: boolean; name: string }>(
    `select id, location_id, is_open, accepting_orders, name from cafes where id = $1`,
    [input.cafeId],
  );
  if (!cafe) throw notFound('Cafe not found');
  if (!cafe.is_open || !cafe.accepting_orders) throw conflict(`${cafe.name} is not taking orders right now`);

  // Merge duplicate lines and price everything on the server.
  const qtyById = new Map<string, number>();
  for (const it of input.items) qtyById.set(it.menuItemId, (qtyById.get(it.menuItemId) ?? 0) + it.qty);
  const ids = [...qtyById.keys()];
  const menu = await q<{ id: string; name: string; emoji: string; price: number; is_available: boolean }>(
    `select id, name, emoji, price, is_available from menu_items where cafe_id = $1 and id = any($2::uuid[])`,
    [cafe.id, ids],
  );
  if (menu.length !== ids.length) throw badRequest('Some items are not on this cafe\'s menu');
  const unavailable = menu.filter((m) => !m.is_available);
  if (unavailable.length) throw conflict(`${unavailable.map((m) => m.name).join(', ')} is out of stock`);

  const lines = ids.map((id) => ({ ...menu.find((m) => m.id === id)!, qty: qtyById.get(id)! }));
  const itemsTotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const deliveryFee = 0;

  const profile = await one<{ name: string; phone: string | null }>(`select name, phone from profiles where id = $1`, [user.id]);
  const customerName = input.name || profile?.name || '';
  const customerPhone = input.phone || profile?.phone || user.phone;

  const orderId = await tx(async (c) => {
    // One order at a time per user: parallel requests wait here, so the limits below can't be skipped.
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`order:${user.id}`]);
    const { rows: [limits] } = await c.query(
      `select count(*) filter (where status = any($2))::int as active,
         count(*) filter (where created_at > now() - interval '10 minutes')::int as recent
       from orders where user_id = $1`,
      [user.id, ACTIVE_STATUSES],
    );
    if (limits.active >= MAX_ACTIVE_ORDERS) throw conflict('You already have orders on the way. Please wait for them first.');
    if (limits.recent >= MAX_ORDERS_PER_10_MIN) throw tooMany('Too many orders. Please try again in a few minutes.');

    const { rows } = await c.query(
      `insert into orders (user_id, cafe_id, location_id, items_total, delivery_fee, total,
         customer_name, customer_phone, tower, floor, company, desk, note)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [user.id, cafe.id, cafe.location_id, itemsTotal, deliveryFee, itemsTotal + deliveryFee, customerName,
        customerPhone, address.tower, address.floor, address.company, address.desk, input.note ?? null],
    );
    const id = rows[0].id as string;
    for (const [lineNo, l] of lines.entries()) {
      await c.query(
        `insert into order_items (order_id, menu_item_id, name, emoji, price, qty, line_no) values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, l.id, l.name, l.emoji, l.price, l.qty, lineNo],
      );
    }
    // Remember the desk address (and name) for next time.
    await c.query(
      `insert into profiles (id, phone, email) values ($1, $2, $3) on conflict (id) do nothing`,
      [user.id, user.phone, user.email],
    );
    if (input.saveAddress) {
      await c.query(
        `update profiles set tower = $2, floor = $3, company = $4, desk = $5, location_id = $6,
           name = case when $7 <> '' then $7 else name end, updated_at = now() where id = $1`,
        [user.id, address.tower, address.floor, address.company, address.desk, cafe.location_id, input.name ?? ''],
      );
    }
    if (input.inTx) await input.inTx(c, id);
    return id;
  });

  const order = await selectOrder(orderId);
  await orderChanged({ orderId, cafeId: cafe.id, userId: user.id, status: 'placed' });
  return order;
}

export async function orderRoutes(app: FastifyInstance) {
  app.post('/v1/orders', async (req, reply) => {
    const user = await requireUser(req);
    const body = PlaceOrder.parse(req.body);
    requireEmployeePhone(user);
    const order = await createOrder({ user, ...body });
    reply.code(201);
    return order;
  });

  app.get<{ Querystring: { status?: 'active' | 'past' } }>('/v1/orders', async (req) => {
    const user = await requireUser(req);
    const { status } = req.query;
    if (status === 'active') return selectOrders(`o.user_id = $1 and o.status = any($2)`, [user.id, ACTIVE_STATUSES]);
    if (status === 'past')
      return selectOrders(`o.user_id = $1 and not (o.status = any($2))`, [user.id, ACTIVE_STATUSES], 'order by o.created_at desc limit 50');
    return selectOrders(`o.user_id = $1`, [user.id], 'order by o.created_at desc limit 50');
  });

  app.get<{ Params: { id: string } }>('/v1/orders/:id', async (req) => {
    const user = await requireUser(req);
    const order = await selectOrder(req.params.id);
    if (!order || order.userId !== user.id) throw notFound('Order not found');
    return order;
  });

  app.post<{ Params: { id: string } }>('/v1/orders/:id/cancel', async (req) => {
    const user = await requireUser(req);
    const row = await one<{ cafe_id: string }>(
      `update orders set status = 'cancelled', cancelled_at = now()
       where id = $1 and user_id = $2 and status = 'placed' returning cafe_id`,
      [req.params.id, user.id],
    );
    if (!row) throw conflict('This order can no longer be cancelled');
    await orderChanged({ orderId: req.params.id, cafeId: row.cafe_id, userId: user.id, status: 'cancelled' });
    return selectOrder(req.params.id);
  });
}
