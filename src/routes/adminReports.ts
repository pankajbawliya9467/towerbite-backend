import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { can, requireAdmin, type Staff } from '../auth.js';
import { badRequest } from '../lib/errors.js';
import { selectOrders } from '../lib/sql.js';
import { like, uuidOrNull, Where } from '../lib/paging.js';
import { orderWhere, type OrdersQuery } from '../lib/orderFilters.js';
import { csv, sendCsv } from './reports.js';

/**
 * Admin → Reports: one set of filters (date range, building, cafe, company, status, single/team) for a summary
 * and six downloads. Needs "Reports → view". Rupee columns of the summaries need "Reports → money"; phone
 * numbers need "Orders → phone" (orders, lunch) or "Users → phone" (customers). Every download is logged.
 */
const TZ = 'Asia/Kolkata';
const MAX_ROWS = 20000;
const istToday = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Filters = OrdersQuery & { from: string; to: string };
function filters(qs: OrdersQuery): Filters {
  const to = DAY.test(qs.to ?? '') ? qs.to! : istToday();
  const from = DAY.test(qs.from ?? '') ? qs.from! : addDays(to, -6);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (!Number.isFinite(days) || days < 1) throw badRequest('Pick a start date on or before the end date');
  if (days > 366) throw badRequest('Pick up to one year at a time');
  const pick = ({ locationId, cafeId, status, company, type, search }: OrdersQuery) => ({ locationId, cafeId, status, company, type, search });
  return { ...pick(qs), from, to };
}
/** Orders matching the filters. Without a status filter, cancelled and rejected orders don't count as sales. */
const counted = (f: Filters) => (f.status ? 'true' : `o.status not in ('cancelled', 'rejected')`);
const istTime = (d: unknown) => (d ? new Date(d as string).toLocaleString('en-IN', { timeZone: TZ }) : '');

/** Lunch bookings with the same building / cafe / company / date filters (lunch has its own statuses). */
function lunchWhere(f: Filters, phone: boolean) {
  const w = new Where();
  w.add('b.day between ?::date and ?::date', f.from, f.to);
  const loc = uuidOrNull(f.locationId);
  const cafe = uuidOrNull(f.cafeId);
  if (loc) w.add('c.location_id = ?', loc);
  if (cafe) w.add('b.cafe_id = ?', cafe);
  if (f.company?.trim()) w.add('b.company ilike ?', like(f.company));
  const map: Record<string, string> = { delivered: 'delivered', cancelled: 'cancelled', out_for_delivery: 'out', placed: 'booked' };
  if (f.status && map[f.status]) w.add('b.status = ?', map[f.status]);
  else if (f.status) w.add('false'); // e.g. "rejected": lunch has no such status
  const term = f.search?.trim();
  if (term) {
    if (phone) w.add('(b.customer_name ilike ? or b.customer_phone ilike ?)', like(term), like(term));
    else w.add('b.customer_name ilike ?', like(term));
  }
  return w;
}

async function summary(f: Filters, me: Staff) {
  const w = orderWhere(f, can(me, 'orders.phone'));
  const t = (await one<{ all: number; orders: number; delivered: number; sales: number; cancelled: number; rejected: number; customers: number }>(
    `select count(*)::int as all,
       count(*) filter (where o.status not in ('cancelled','rejected'))::int as orders,
       count(*) filter (where o.status = 'delivered')::int as delivered,
       coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales,
       count(*) filter (where o.status = 'cancelled')::int as cancelled,
       count(*) filter (where o.status = 'rejected')::int as rejected,
       count(distinct o.user_id) filter (where ${counted(f)})::int as customers
     from orders o where ${w.sql}`,
    w.params,
  ))!;
  const items = (await one<{ n: number }>(
    `select count(distinct (oi.name, o.cafe_id))::int as n from order_items oi join orders o on o.id = oi.order_id where ${w.sql} and ${counted(f)}`,
    w.params,
  ))!.n;
  const cafes = (await one<{ n: number }>(`select count(distinct o.cafe_id)::int as n from orders o where ${w.sql}`, w.params))!.n;
  const lw = lunchWhere(f, can(me, 'orders.phone'));
  const lunch = (await one<{ n: number }>(
    `select count(*)::int as n from lunch_bookings b join cafes c on c.id = b.cafe_id where ${lw.sql}`, lw.params,
  ))!.n;
  const money = can(me, 'reports.money');
  const days = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86400_000) + 1;
  return {
    from: f.from, to: f.to, money,
    orders: t.orders, delivered: t.delivered, cancelled: t.cancelled, rejected: t.rejected,
    lostPct: t.all ? Math.round(((t.cancelled + t.rejected) / t.all) * 1000) / 10 : 0,
    sales: money ? t.sales : null,
    avgOrder: money ? (t.delivered ? Math.round(t.sales / t.delivered) : 0) : null,
    rows: { orders: t.all, items, cafes, days, lunch, customers: t.customers },
  };
}

export const REPORTS = ['orders', 'items', 'cafes', 'days', 'lunch', 'customers'] as const;
type Report = (typeof REPORTS)[number];

async function build(kind: Report, f: Filters, me: Staff): Promise<unknown[][]> {
  const money = can(me, 'reports.money');
  const rs = (n: number | null) => (money ? n ?? 0 : '');
  const w = orderWhere(f, can(me, 'orders.phone'));
  switch (kind) {
    case 'orders': {
      const phone = can(me, 'orders.phone');
      const rows = (await selectOrders(w.sql, w.params, `order by o.created_at desc limit ${MAX_ROWS}`)) as any[];
      return [
        ['Order', 'Date', 'Building', 'Cafe', 'Customer', 'Phone', 'Company', 'Address', 'Items', 'Team order', 'Items total (₹)', 'Delivery (₹)', 'Total (₹)', 'Status', 'Payment', 'Rating'],
        ...rows.map((o) => [
          o.orderNo, istTime(o.createdAt), o.location?.name, o.cafe?.name, o.customerName, phone ? o.customerPhone ?? '' : '',
          o.address?.company ?? '', [o.address?.tower, o.address?.floor, o.address?.desk].filter(Boolean).join(', '),
          (o.items ?? []).map((i: any) => `${i.qty}× ${i.name}`).join('; '), o.team ? `${o.team.name || o.team.code} (${o.team.people})` : '',
          o.itemsTotal, o.deliveryFee, o.total, o.status, o.paymentMethod === 'cod' ? 'Pay at desk' : o.paymentMethod ?? '', o.rating?.stars ?? '',
        ]),
      ];
    }
    case 'items': {
      const rows = await q<any>(
        `select oi.name, c.name as cafe, l.name as building, sum(oi.qty)::int as qty, count(distinct o.id)::int as orders,
           sum(oi.qty * oi.price)::int as sales
         from order_items oi join orders o on o.id = oi.order_id join cafes c on c.id = o.cafe_id join locations l on l.id = o.location_id
         where ${w.sql} and ${counted(f)}
         group by oi.name, c.name, l.name order by qty desc, oi.name limit ${MAX_ROWS}`,
        w.params,
      );
      return [['Item', 'Cafe', 'Building', 'Qty sold', 'Orders', 'Sales (₹)'], ...rows.map((r) => [r.name, r.cafe, r.building, r.qty, r.orders, rs(r.sales)])];
    }
    case 'cafes': {
      const rows = await q<any>(
        `select c.name as cafe, l.name as building,
           count(*) filter (where o.status not in ('cancelled','rejected'))::int as orders,
           count(*) filter (where o.status = 'delivered')::int as delivered,
           coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales,
           count(*) filter (where o.status = 'cancelled')::int as cancelled,
           count(*) filter (where o.status = 'rejected')::int as rejected,
           count(*)::int as all,
           round(avg(r.stars)::numeric, 1)::float as rating, count(r.stars)::int as ratings
         from orders o join cafes c on c.id = o.cafe_id join locations l on l.id = o.location_id
         left join order_ratings r on r.order_id = o.id
         where ${w.sql} group by c.name, l.name order by sales desc, orders desc`,
        w.params,
      );
      return [
        ['Cafe', 'Building', 'Orders', 'Delivered', 'Sales (₹)', 'Avg order (₹)', 'Cancelled', 'Rejected', 'Lost %', 'Rating', 'Ratings'],
        ...rows.map((r) => [
          r.cafe, r.building, r.orders, r.delivered, rs(r.sales), money ? (r.delivered ? Math.round(r.sales / r.delivered) : 0) : '',
          r.cancelled, r.rejected, r.all ? Math.round(((r.cancelled + r.rejected) / r.all) * 1000) / 10 : 0, r.rating ?? '', r.ratings,
        ]),
      ];
    }
    case 'days': {
      // Every day of the range (also days without orders), with sign-ups in the same building (if one is picked).
      const p = [...w.params];
      const fromP = `$${p.push(f.from)}`;
      const toP = `$${p.push(f.to)}`;
      const loc = uuidOrNull(f.locationId);
      const locP = `$${p.push(loc)}`;
      const rows = await q<any>(
        `select to_char(d, 'YYYY-MM-DD') as day, to_char(d, 'Dy') as weekday,
           coalesce(x.orders, 0) as orders, coalesce(x.delivered, 0) as delivered, coalesce(x.sales, 0) as sales,
           coalesce(x.cancelled, 0) as cancelled, coalesce(x.customers, 0) as customers,
           (select count(*)::int from profiles pr where (pr.created_at at time zone '${TZ}')::date = d::date
              and (${locP}::uuid is null or pr.location_id = ${locP}::uuid)) as signups
         from generate_series(${fromP}::date, ${toP}::date, interval '1 day') d
         left join (
           select (o.created_at at time zone '${TZ}')::date as day,
             count(*) filter (where o.status not in ('cancelled','rejected'))::int as orders,
             count(*) filter (where o.status = 'delivered')::int as delivered,
             coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales,
             count(*) filter (where o.status = 'cancelled')::int as cancelled,
             count(distinct o.user_id)::int as customers
           from orders o where ${w.sql} group by 1
         ) x on x.day = d::date
         order by d`,
        p,
      );
      return [
        ['Date', 'Day', 'Orders', 'Delivered', 'Sales (₹)', 'Cancelled', 'Customers', 'New sign-ups'],
        ...rows.map((r) => [r.day, r.weekday, r.orders, r.delivered, rs(r.sales), r.cancelled, r.customers, r.signups]),
      ];
    }
    case 'lunch': {
      const phone = can(me, 'orders.phone');
      const lw = lunchWhere(f, phone);
      const rows = await q<any>(
        `select b.booking_no, b.day, b.slot, b.qty, b.price, b.total, b.status, b.customer_name, b.customer_phone, b.company,
           b.tower, b.floor, b.desk, b.created_at, m.name as lunch, c.name as cafe, l.name as building
         from lunch_bookings b join cafes c on c.id = b.cafe_id join locations l on l.id = c.location_id
         left join lunch_menus m on m.id = b.lunch_id
         where ${lw.sql} order by b.day desc, b.slot, b.booking_no limit ${MAX_ROWS}`,
        lw.params,
      );
      return [
        ['Booking', 'Lunch date', 'Slot', 'Lunch', 'Cafe', 'Building', 'Customer', 'Phone', 'Company', 'Address', 'Plates', 'Price (₹)', 'Total (₹)', 'Status', 'Booked at'],
        ...rows.map((r) => [
          r.booking_no, String(r.day instanceof Date ? r.day.toISOString().slice(0, 10) : r.day).slice(0, 10), r.slot, r.lunch ?? '', r.cafe, r.building,
          r.customer_name, phone ? r.customer_phone ?? '' : '', r.company, [r.tower, r.floor, r.desk].filter(Boolean).join(', '),
          r.qty, r.price, r.total, r.status, istTime(r.created_at),
        ]),
      ];
    }
    case 'customers': {
      const phone = can(me, 'users.phone');
      const rows = await q<any>(
        `select p.name, p.phone, p.email, p.company, lp.name as building, p.created_at,
           count(*)::int as orders, coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as spent,
           max(o.created_at) as last_order
         from orders o join profiles p on p.id = o.user_id left join locations lp on lp.id = p.location_id
         where ${w.sql} and ${counted(f)}
         group by p.id, lp.name order by orders desc, spent desc limit ${MAX_ROWS}`,
        w.params,
      );
      return [
        ['Name', 'Phone', 'Email', 'Company', 'Building', 'Joined', 'Orders', 'Spent (₹)', 'Last order'],
        ...rows.map((r) => [
          r.name, phone ? r.phone ?? '' : '', phone ? r.email ?? '' : '', r.company, r.building ?? '', istTime(r.created_at).split(',')[0],
          r.orders, rs(r.spent), istTime(r.last_order),
        ]),
      ];
    }
  }
}

export async function adminReportRoutes(app: FastifyInstance) {
  app.get<{ Querystring: OrdersQuery }>('/v1/admin/reports', async (req) => {
    const me = await requireAdmin(req, 'reports.view');
    return summary(filters(req.query), me);
  });

  app.get<{ Params: { kind: string }; Querystring: OrdersQuery }>(
    '/v1/admin/reports/:kind.csv',
    { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const me = await requireAdmin(req, 'reports.view');
      const kind = z.enum(REPORTS).parse(req.params.kind);
      const f = filters(req.query);
      const table = await build(kind, f, me);
      await q(`insert into report_downloads (admin_id, report, filters, rows) values ($1, $2, $3, $4)`, [
        me.userId, kind, JSON.stringify(f), table.length - 1,
      ]);
      return sendCsv(reply, `towerbites_${kind}_${f.from}_to_${f.to}.csv`, csv(table));
    },
  );
}
