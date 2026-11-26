import { z } from 'zod';
import { day, like, uuidOrNull, Where } from './paging.js';

export type OrdersQuery = {
  locationId?: string; cafeId?: string; status?: string; limit?: string; from?: string; to?: string;
  company?: string; type?: string; search?: string; page?: string; pageSize?: string;
};
export const ORDER_STATUSES = ['placed', 'preparing', 'out_for_delivery', 'delivered', 'rejected', 'cancelled'] as const;

/**
 * The order filters shared by the admin Orders page, its CSV and Reports: building, cafe, status ("active" =
 * still being worked on), date range (India days), company, single/team order, and a search (order no, name,
 * and the phone only when `phone` is allowed).
 */
export function orderWhere(qs: OrdersQuery, phone: boolean, w = new Where()) {
  const loc = uuidOrNull(qs.locationId);
  const cafe = uuidOrNull(qs.cafeId);
  if (loc) w.add('o.location_id = ?', loc);
  if (cafe) w.add('o.cafe_id = ?', cafe);
  if (qs.status === 'active') w.add('o.status = any(?)', ['placed', 'preparing', 'out_for_delivery']);
  else if (qs.status) w.add('o.status = ?', z.enum(ORDER_STATUSES).parse(qs.status));
  const from = day(qs.from, 'start date');
  const to = day(qs.to, 'end date');
  if (from) w.add(`(o.created_at at time zone 'Asia/Kolkata')::date >= ?::date`, from);
  if (to) w.add(`(o.created_at at time zone 'Asia/Kolkata')::date <= ?::date`, to);
  if (qs.company?.trim()) w.add('o.company ilike ?', like(qs.company));
  if (qs.type === 'team') w.add('exists (select 1 from team_orders t where t.order_id = o.id)');
  else if (qs.type === 'single') w.add('not exists (select 1 from team_orders t where t.order_id = o.id)');
  const term = qs.search?.trim();
  if (term) {
    const no = /^#?\d{1,9}$/.test(term) ? Number(term.replace('#', '')) : -1;
    if (phone) w.add('(o.order_no = ? or o.customer_name ilike ? or o.customer_phone ilike ?)', no, like(term), like(term));
    else w.add('(o.order_no = ? or o.customer_name ilike ?)', no, like(term));
  }
  return w;
}
