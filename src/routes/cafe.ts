import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { can, noAccess, requireCafe, type Permission } from '../auth.js';
import { ACTIVE_STATUSES, selectOrder, selectOrders, type OrderStatus } from '../lib/sql.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { cafesChanged, orderChanged } from '../realtime.js';
import { pushToUser } from '../push.js';
import { cafeWithMenu } from './public.js';
import { saveImage } from '../lib/upload.js';
import { pushTeamForOrder } from './team.js';
import { day, like, paging, Where } from '../lib/paging.js';

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
    from: 'preparing', to: 'out_for_delivery', set: 'out_at = now(), rider_name = $3, rider_phone = $4',
    push: (o) => ['Your order is on the way', `${o.rider ? `${o.rider} is bringing` : 'We are bringing'} order #${o.orderNo} to your desk.`],
  },
  deliver: {
    from: 'out_for_delivery', to: 'delivered', set: 'delivered_at = now(), cod_collected = true',
    push: (o) => ['Delivered! How was it?', `Enjoy your order from ${o.cafe}. Tap to rate it in one tap.`],
  },
};

export async function cafeRoutes(app: FastifyInstance) {
  /** Image upload for a cafe's own staff (lunch photos), into that cafe's folder only. */
  app.post('/v1/cafe/upload', async (req) => {
    const { cafeId } = await requireCafe(req);
    return saveImage(req, () => `cafe-${cafeId}`);
  });

  app.get('/v1/cafe', async (req) => {
    const { cafeId, staff } = await requireCafe(req);
    const cafe = await cafeWithMenu(cafeId);
    return { ...cafe, staff };
  });

  app.patch('/v1/cafe', async (req) => {
    const { cafeId, staff } = await requireCafe(req);
    const body = z.object({
      acceptingOrders: z.boolean().optional(),
      isOpen: z.boolean().optional(),
      /** Minimum order value in ₹ (items + combos); 0 = no minimum. */
      minOrder: z.number().int().min(0, 'Minimum order: 0 or more').max(10000, 'Minimum order: up to ₹10,000').optional(),
    }).parse(req.body);
    // An admin working in the cafe panel needs the matching tick: open/pause, or cafe edit for the minimum order.
    if (staff.role === 'super_admin') {
      if ((body.acceptingOrders !== undefined || body.isOpen !== undefined) && !can(staff, 'cafes.openclose')) throw noAccess('cafes.openclose');
      if (body.minOrder !== undefined && !can(staff, 'cafes.edit')) throw noAccess('cafes.edit');
    }
    const row = await one<{ location_id: string }>(
      `update cafes set accepting_orders = coalesce($2, accepting_orders), is_open = coalesce($3, is_open),
         min_order = coalesce($4, min_order)
       where id = $1 returning location_id`,
      [cafeId, body.acceptingOrders ?? null, body.isOpen ?? null, body.minOrder ?? null],
    );
    if (!row) throw notFound('Cafe not found');
    await cafesChanged([row.location_id]);
    return cafeWithMenu(cafeId);
  });

  /** status=active (default) → New / Preparing / Out for delivery. status=history → finished orders for a day. */
  type CafeOrdersQuery = {
    status?: 'active' | 'history'; date?: string; from?: string; to?: string; state?: string; search?: string; page?: string; pageSize?: string;
  };
  app.get<{ Querystring: CafeOrdersQuery }>('/v1/cafe/orders', async (req) => {
    const { cafeId } = await requireCafe(req);
    // History with `page`: a date range, status and search, one page at a time.
    if (req.query.status === 'history' && req.query.page !== undefined) {
      const qs = req.query;
      const w = new Where([cafeId]);
      w.add('o.cafe_id = $1');
      const from = day(qs.from, 'start date');
      const to = day(qs.to, 'end date');
      w.add(`(o.created_at at time zone 'Asia/Kolkata')::date >= coalesce(?::date, (now() at time zone 'Asia/Kolkata')::date)`, from);
      w.add(`(o.created_at at time zone 'Asia/Kolkata')::date <= coalesce(?::date, (now() at time zone 'Asia/Kolkata')::date)`, to ?? from);
      if (qs.state) w.add('o.status = ?', z.enum(['placed', 'preparing', 'out_for_delivery', 'delivered', 'rejected', 'cancelled']).parse(qs.state));
      const term = qs.search?.trim();
      if (term) {
        const no = /^#?\d{1,9}$/.test(term) ? Number(term.replace('#', '')) : -1;
        w.add('(o.order_no = ? or o.customer_name ilike ? or o.customer_phone ilike ?)', no, like(term), like(term));
      }
      const pg = paging(qs);
      const [count] = await q<{ n: number }>(`select count(*)::int as n from orders o where ${w.sql}`, w.params);
      const rows = await selectOrders(w.sql, w.params, `order by o.created_at desc limit ${pg.limit} offset ${pg.offset}`);
      return { rows, total: count.n, page: pg.page, pageSize: pg.pageSize };
    }
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

  /** Moves one order to its next step (accept, reject, dispatch, deliver); tells the customer. */
  async function transition(cafeId: string, orderId: string, action: string, extra: { reason?: string; riderName?: string; riderId?: string }) {
    if (!Object.hasOwn(TRANSITIONS, action)) throw notFound('Unknown action');
    const t = TRANSITIONS[action];
    let riderName = extra.riderName ?? null;
    let riderPhone: string | null = null;
    if (action === 'dispatch' && extra.riderId) {
      const r = await one<{ name: string; phone: string | null }>(`select name, phone from cafe_riders where id = $1 and cafe_id = $2`, [extra.riderId, cafeId]);
      if (!r) throw badRequest('Delivery person not found');
      riderName = r.name;
      riderPhone = r.phone;
    }
    const params: unknown[] = [orderId, cafeId];
    if (action === 'reject') params.push(extra.reason ?? null);
    if (action === 'dispatch') params.push(riderName, riderPhone);
    const row = await one<{ user_id: string; order_no: number }>(
      `update orders set status = '${t.to}', ${t.set}
       where id = $1 and cafe_id = $2 and status = '${t.from}' returning user_id, order_no`,
      params,
    );
    if (!row) throw conflict('This order was already updated. Refresh to see the latest.');
    const order = await selectOrder(orderId);
    void orderChanged({ orderId, cafeId, userId: row.user_id, status: t.to });
    if (t.push) {
      const [title, text] = t.push({ orderNo: row.order_no, cafe: order.cafe.name, rider: order.riderName });
      // Sent in the background so the cafe's tap is answered straight away.
      void pushToUser(row.user_id, title, text, { orderId, status: t.to, ...(t.to === 'delivered' ? { rate: '1' } : {}) });
      // Team orders: everyone who added items hears about it too, not just the host.
      if (order.team) void pushTeamForOrder(orderId, row.user_id, title, text);
    }
    return order;
  }

  const ActionBody = z.object({
    reason: z.string().trim().max(120).optional(),
    riderName: z.string().trim().max(40).optional(),
    riderId: z.string().uuid().optional(),
  });

  /** Several orders at once: send out together with one delivery person, or mark several delivered. */
  app.post('/v1/cafe/orders/batch', async (req) => {
    const { cafeId } = await requireCafe(req);
    const body = ActionBody.extend({
      action: z.enum(['dispatch', 'deliver']),
      ids: z.array(z.string().uuid()).min(1).max(20),
    }).parse(req.body);
    const results = await Promise.all(
      [...new Set(body.ids)].map((id) =>
        transition(cafeId, id, body.action, body).then(
          (order) => ({ id, ok: true as const, order }),
          (e: Error) => ({ id, ok: false as const, error: e.message }),
        ),
      ),
    );
    return { results };
  });

  app.post<{ Params: { id: string; action: string } }>('/v1/cafe/orders/:id/:action', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.id);
    return transition(cafeId, req.params.id, req.params.action, ActionBody.parse(req.body ?? {}));
  });

  // ---- Delivery staff ----
  const RiderBody = z.object({
    name: z.string().trim().min(1).max(40),
    phone: z.string().trim().regex(/^\+?[0-9 ]{6,16}$/, 'Enter a valid phone number').nullable().optional(),
    sort: z.number().int().min(0).max(1000).optional(),
  });

  app.get('/v1/cafe/riders', async (req) => {
    const { cafeId } = await requireCafe(req);
    return q(`select id, name, phone, sort from cafe_riders where cafe_id = $1 order by sort, created_at`, [cafeId]);
  });

  app.post('/v1/cafe/riders', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const body = RiderBody.parse(req.body);
    const n = await one<{ n: number }>(`select count(*)::int as n from cafe_riders where cafe_id = $1`, [cafeId]);
    if ((n?.n ?? 0) >= 30) throw conflict('Up to 30 delivery staff per cafe');
    reply.code(201);
    return one(
      `insert into cafe_riders (cafe_id, name, phone, sort) values ($1, $2, $3, $4) returning id, name, phone, sort`,
      [cafeId, body.name, body.phone || null, body.sort ?? n?.n ?? 0],
    );
  });

  app.patch<{ Params: { id: string } }>('/v1/cafe/riders/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.id);
    const body = RiderBody.parse(req.body);
    const row = await one(
      `update cafe_riders set name = $3, phone = $4, sort = coalesce($5, sort) where id = $1 and cafe_id = $2 returning id, name, phone, sort`,
      [req.params.id, cafeId, body.name, body.phone || null, body.sort ?? null],
    );
    if (!row) throw notFound('Delivery person not found');
    return row;
  });

  app.delete<{ Params: { id: string } }>('/v1/cafe/riders/:id', async (req) => {
    const { cafeId } = await requireCafe(req);
    z.string().uuid().parse(req.params.id);
    const row = await one(`delete from cafe_riders where id = $1 and cafe_id = $2 returning id`, [req.params.id, cafeId]);
    if (!row) throw notFound('Delivery person not found');
    return { ok: true };
  });

  app.get('/v1/cafe/menu', async (req) => {
    const { cafeId } = await requireCafe(req);
    return cafeWithMenu(cafeId);
  });

  /**
   * The cafe's own quick switches on a product: in stock (today), popular (★ on the menu), hidden (not shown to
   * customers at all until shown again). An admin working in the cafe panel needs the matching menu tick.
   */
  app.patch<{ Params: { id: string } }>('/v1/cafe/menu-items/:id', async (req) => {
    const body = z
      .object({ isAvailable: z.boolean().optional(), isPopular: z.boolean().optional(), isActive: z.boolean().optional() })
      .refine((b) => b.isAvailable !== undefined || b.isPopular !== undefined || b.isActive !== undefined, 'Nothing to change')
      .parse(req.body);
    const needs: Permission[] = [];
    if (body.isAvailable !== undefined) needs.push('menu.soldout');
    if (body.isPopular !== undefined) needs.push('menu.edit');
    if (body.isActive !== undefined) needs.push('menu.delete');
    const { cafeId, staff } = await requireCafe(req);
    for (const p of needs) if (staff.role === 'super_admin' && !can(staff, p)) throw noAccess(p);
    z.string().uuid().parse(req.params.id);
    const row = await one<{ location_id: string; is_available: boolean; is_popular: boolean; is_active: boolean }>(
      `update menu_items i set is_available = coalesce($3, i.is_available), is_popular = coalesce($4, i.is_popular),
         is_active = coalesce($5, i.is_active)
       from cafes c where i.id = $1 and i.cafe_id = $2 and c.id = i.cafe_id
       returning c.location_id, i.is_available, i.is_popular, i.is_active`,
      [req.params.id, cafeId, body.isAvailable ?? null, body.isPopular ?? null, body.isActive ?? null],
    );
    if (!row) throw notFound('Item not found');
    await cafesChanged([row.location_id]);
    return { id: req.params.id, isAvailable: row.is_available, isPopular: row.is_popular, isActive: row.is_active };
  });
}
