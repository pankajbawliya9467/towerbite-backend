import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { requireCafe } from '../auth.js';
import { ACTIVE_STATUSES, selectOrder, selectOrders, type OrderStatus } from '../lib/sql.js';
import { conflict, notFound } from '../lib/errors.js';
import { cafesChanged, orderChanged } from '../realtime.js';
import { pushToUser } from '../push.js';
import { cafeWithMenu } from './public.js';
import { pushTeamForOrder } from './team.js';

type Transition = {
  from: OrderStatus;
  to: OrderStatus;
  set: string;
  push?: (o: { orderNo: number; cafe: string; rider?: string | null }) => [string, string];
};

const TRANSITIONS: Record<string, Transition> = {
  accept: {
    from: 'placed', to: 'preparing', set: 'accepted_at = now()',
    push: (o) => [`${o.cafe} accepted your order`, `Order #${o.orderNo} is being prepared.`],
  },
  reject: {
    from: 'placed', to: 'rejected', set: 'rejected_at = now(), reject_reason = $3',
    push: (o) => [`${o.cafe} couldn't take your order`, `Order #${o.orderNo} was not accepted.`],
  },
  dispatch: {
    from: 'preparing', to: 'out_for_delivery', set: 'out_at = now(), rider_name = $3',
    push: (o) => ['Your order is on the way', `${o.rider ? `${o.rider} is bringing` : 'We are bringing'} order #${o.orderNo} to your desk.`],
  },
  deliver: {
    from: 'out_for_delivery', to: 'delivered', set: 'delivered_at = now(), cod_collected = true',
    push: (o) => ['Delivered', `Enjoy your order from ${o.cafe}!`],
  },
};

export async function cafeRoutes(app: FastifyInstance) {
  app.get('/v1/cafe', async (req) => {
    const { cafeId, staff } = await requireCafe(req);
    const cafe = await cafeWithMenu(cafeId);
    return { ...cafe, staff };
  });

  app.patch('/v1/cafe', async (req) => {
    const { cafeId } = await requireCafe(req);
    const body = z.object({ acceptingOrders: z.boolean().optional(), isOpen: z.boolean().optional() }).parse(req.body);
    const row = await one<{ location_id: string }>(
      `update cafes set accepting_orders = coalesce($2, accepting_orders), is_open = coalesce($3, is_open)
       where id = $1 returning location_id`,
      [cafeId, body.acceptingOrders ?? null, body.isOpen ?? null],
    );
    if (!row) throw notFound('Cafe not found');
    await cafesChanged([row.location_id]);
    return cafeWithMenu(cafeId);
  });

  /** status=active (default) → New / Preparing / Out for delivery. status=history → finished orders for a day. */
  app.get<{ Querystring: { status?: 'active' | 'history'; date?: string } }>('/v1/cafe/orders', async (req) => {
    const { cafeId } = await requireCafe(req);
    if (req.query.status === 'history') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date : null;
      return selectOrders(
        `o.cafe_id = $1 and (o.created_at at time zone 'Asia/Kolkata')::date =
           coalesce($2::date, (now() at time zone 'Asia/Kolkata')::date)`,
        [cafeId, date],
      );
    }
    return selectOrders(`o.cafe_id = $1 and o.status = any($2)`, [cafeId, ACTIVE_STATUSES], 'order by o.created_at asc');
  });

  app.get('/v1/cafe/stats', async (req) => {
    const { cafeId } = await requireCafe(req);
    return one(
      `select count(*) filter (where status <> 'cancelled' and status <> 'rejected')::int as "orders",
         count(*) filter (where status = 'delivered')::int as "delivered",
         coalesce(sum(total) filter (where status = 'delivered'), 0)::int as "sales",
         coalesce(sum(total) filter (where cod_collected), 0)::int as "codCollected",
         count(*) filter (where status = any($2))::int as "active"
       from orders where cafe_id = $1
         and (created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date`,
      [cafeId, ACTIVE_STATUSES],
    );
  });

  app.post<{ Params: { id: string; action: string } }>('/v1/cafe/orders/:id/:action', async (req) => {
    const { cafeId } = await requireCafe(req);
    const t = TRANSITIONS[req.params.action];
    if (!t) throw notFound('Unknown action');
    const body = z
      .object({ reason: z.string().trim().max(120).optional(), riderName: z.string().trim().max(40).optional() })
      .parse(req.body ?? {});
    const extra = req.params.action === 'reject' ? body.reason ?? null : body.riderName ?? null;
    const params: unknown[] = [req.params.id, cafeId];
    if (t.set.includes('$3')) params.push(extra);
    const row = await one<{ user_id: string; order_no: number }>(
      `update orders set status = '${t.to}', ${t.set}
       where id = $1 and cafe_id = $2 and status = '${t.from}' returning user_id, order_no`,
      params,
    );
    if (!row) throw conflict('This order was already updated. Refresh to see the latest.');

    const order = await selectOrder(req.params.id);
    await orderChanged({ orderId: req.params.id, cafeId, userId: row.user_id, status: t.to });
    if (t.push) {
      const [title, text] = t.push({ orderNo: row.order_no, cafe: order.cafe.name, rider: order.riderName });
      // Sent in the background so the cafe's tap is answered straight away.
      void pushToUser(row.user_id, title, text, { orderId: req.params.id, status: t.to });
      // Team orders: everyone who added items hears about it too, not just the host.
      if (order.team) void pushTeamForOrder(req.params.id, row.user_id, title, text);
    }
    return order;
  });

  app.get('/v1/cafe/menu', async (req) => {
    const { cafeId } = await requireCafe(req);
    return cafeWithMenu(cafeId);
  });

  app.patch<{ Params: { id: string } }>('/v1/cafe/menu-items/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body);
    const row = await one<{ location_id: string }>(
      `update menu_items i set is_available = $3 from cafes c
       where i.id = $1 and i.cafe_id = $2 and c.id = i.cafe_id returning c.location_id`,
      [req.params.id, cafeId, isAvailable],
    );
    if (!row) throw notFound('Item not found');
    await cafesChanged([row.location_id]);
    return { id: req.params.id, isAvailable };
  });
}
