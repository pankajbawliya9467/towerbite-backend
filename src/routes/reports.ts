import type { FastifyInstance, FastifyReply } from 'fastify';
import { one, q } from '../db.js';
import { requireCafe } from '../auth.js';
import { badRequest } from '../lib/errors.js';

/**
 * Sales reports for one cafe (cafe staff, or an admin with x-cafe-id).
 * Dates are calendar days in India time. `from`/`to` are inclusive (YYYY-MM-DD); by default the last 7 days.
 * Every number is compared with the period of the same length just before it.
 */

const TZ = 'Asia/Kolkata';
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Range = { from: string; to: string; days: number; prevFrom: string; prevTo: string };

function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

function range(query: { from?: string; to?: string }): Range {
  const to = DAY.test(query.to ?? '') ? query.to! : istToday();
  const from = DAY.test(query.from ?? '') ? query.from! : addDays(to, -6);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) + 1;
  if (!Number.isFinite(days) || days < 1) throw badRequest('Pick a start date on or before the end date');
  if (days > 366) throw badRequest('Pick up to one year at a time');
  return { from, to, days, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

/** SQL condition: order created on a day between $from and $to (India time), both inclusive. */
const IN_RANGE = (a: string, b: string) =>
  `(o.created_at at time zone '${TZ}')::date between ${a}::date and ${b}::date`;

async function totals(cafeId: string, from: string, to: string) {
  const row = await one<{ sales: number; orders: number; delivered: number; cancelled: number; rejected: number; all: number }>(
    `select coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales,
       count(*) filter (where o.status not in ('cancelled', 'rejected'))::int as orders,
       count(*) filter (where o.status = 'delivered')::int as delivered,
       count(*) filter (where o.status = 'cancelled')::int as cancelled,
       count(*) filter (where o.status = 'rejected')::int as rejected,
       count(*)::int as "all"
     from orders o where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')}`,
    [cafeId, from, to],
  );
  const r = row!;
  return {
    ...r,
    avgOrder: r.delivered ? Math.round(r.sales / r.delivered) : 0,
    lostPct: r.all ? Math.round(((r.cancelled + r.rejected) / r.all) * 1000) / 10 : 0,
  };
}

export async function cafeReport(cafeId: string, rq: { from?: string; to?: string }) {
  const r = range(rq);
  const [now, prev, byDay, byHour, items, prevItems, companies] = await Promise.all([
    totals(cafeId, r.from, r.to),
    totals(cafeId, r.prevFrom, r.prevTo),
    q<{ day: string; sales: number; orders: number }>(
      `select to_char(d, 'YYYY-MM-DD') as day,
         coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales,
         count(o.id) filter (where o.status not in ('cancelled', 'rejected'))::int as orders
       from generate_series($2::date, $3::date, interval '1 day') d
       left join orders o on o.cafe_id = $1 and (o.created_at at time zone '${TZ}')::date = d::date
       group by d order by d`,
      [cafeId, r.from, r.to],
    ),
    q<{ hour: number; orders: number }>(
      `select extract(hour from o.created_at at time zone '${TZ}')::int as hour, count(*)::int as orders
       from orders o where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} and o.status not in ('cancelled', 'rejected')
       group by 1 order by 1`,
      [cafeId, r.from, r.to],
    ),
    q<{ name: string; qty: number; sales: number }>(
      `select oi.name, sum(oi.qty)::int as qty, sum(oi.qty * oi.price)::int as sales
       from order_items oi join orders o on o.id = oi.order_id
       where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} and o.status = 'delivered'
       group by oi.name order by qty desc, sales desc limit 10`,
      [cafeId, r.from, r.to],
    ),
    q<{ name: string; qty: number }>(
      `select oi.name, sum(oi.qty)::int as qty
       from order_items oi join orders o on o.id = oi.order_id
       where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} and o.status = 'delivered'
       group by oi.name`,
      [cafeId, r.prevFrom, r.prevTo],
    ),
    q<{ name: string; orders: number; sales: number }>(
      `select coalesce(nullif(trim(o.company), ''), 'Not given') as name, count(*)::int as orders,
         coalesce(sum(o.total), 0)::int as sales
       from orders o where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} and o.status = 'delivered'
       group by 1 order by sales desc limit 6`,
      [cafeId, r.from, r.to],
    ),
  ]);

  const prevQty = new Map(prevItems.map((p) => [p.name, p.qty]));
  const itemSales = items.reduce((s, i) => s + i.sales, 0);
  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: byHour.find((x) => x.hour === h)?.orders ?? 0 }));
  const peak = hours.reduce((best, h) => (h.orders > best.orders ? h : best), hours[0]);

  return {
    range: r,
    totals: now,
    previous: prev,
    change: {
      sales: pct(now.sales, prev.sales),
      orders: pct(now.orders, prev.orders),
      avgOrder: pct(now.avgOrder, prev.avgOrder),
      lostPct: prev.all ? Math.round((now.lostPct - prev.lostPct) * 10) / 10 : null,
    },
    byDay,
    byHour: hours,
    peakHour: peak.orders ? peak : null,
    topItems: items.map((i) => ({
      ...i,
      share: itemSales ? Math.round((i.sales / itemSales) * 100) : 0,
      rising: (prevQty.get(i.name) ?? 0) > 0 ? i.qty > (prevQty.get(i.name) ?? 0) * 1.2 : i.qty >= 5,
    })),
    companies,
  };
}

/** Quotes a value for CSV (Excel-safe: formulas are neutralised). */
function cell(v: unknown) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

function sendCsv(reply: FastifyReply, name: string, body: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${name}"`)
    .header('cache-control', 'no-store')
    .send(body);
}

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/cafe/reports', async (req) => {
    const { cafeId } = await requireCafe(req);
    return cafeReport(cafeId, req.query);
  });

  /** Every order in the period, one row each (opens in Excel). */
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/cafe/reports/orders.csv', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const r = range(req.query);
    const rows = await q(
      `select o.order_no, to_char(o.created_at at time zone '${TZ}', 'YYYY-MM-DD HH24:MI') as placed, o.status,
         o.customer_name, o.customer_phone, o.company, o.tower, o.floor, o.desk,
         (select string_agg(oi.qty || ' x ' || oi.name, '; ' order by oi.line_no) from order_items oi where oi.order_id = o.id) as items,
         o.total, case when o.cod_collected then 'yes' else 'no' end as cash_collected, o.rider_name, o.note, o.reject_reason
       from orders o where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} order by o.created_at`,
      [cafeId, r.from, r.to],
    );
    const head = ['Order no', 'Placed (IST)', 'Status', 'Customer', 'Phone', 'Company', 'Tower', 'Floor', 'Desk', 'Items', 'Total (₹)', 'Cash collected', 'Rider', 'Note', 'Reject reason'];
    return sendCsv(reply, `orders_${r.from}_to_${r.to}.csv`, csv([head, ...rows.map((o) => Object.values(o))]));
  });

  /** Item-wise sales for delivered orders in the period. */
  app.get<{ Querystring: { from?: string; to?: string } }>('/v1/cafe/reports/items.csv', async (req, reply) => {
    const { cafeId } = await requireCafe(req);
    const r = range(req.query);
    const rows = await q<{ name: string; qty: number; sales: number }>(
      `select oi.name, sum(oi.qty)::int as qty, sum(oi.qty * oi.price)::int as sales
       from order_items oi join orders o on o.id = oi.order_id
       where o.cafe_id = $1 and ${IN_RANGE('$2', '$3')} and o.status = 'delivered'
       group by oi.name order by sales desc`,
      [cafeId, r.from, r.to],
    );
    const total = rows.reduce((s, x) => s + x.sales, 0);
    return sendCsv(
      reply,
      `items_${r.from}_to_${r.to}.csv`,
      csv([['Item', 'Quantity sold', 'Sales (₹)', 'Share of sales'], ...rows.map((x) => [x.name, x.qty, x.sales, total ? `${Math.round((x.sales / total) * 100)}%` : '0%']), ['Total', rows.reduce((s, x) => s + x.qty, 0), total, '100%']]),
    );
  });
}
