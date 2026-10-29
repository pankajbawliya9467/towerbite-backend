import { q } from '../db.js';

export const CAFE_COLS = `c.id, c.location_id as "locationId", c.slug, c.name, c.cuisines, c.place, c.emoji,
  c.cover_color as "coverColor", c.image_url as "imageUrl", c.phone, c.rating::float as rating,
  c.rating_count as "ratingCount", c.eta_min as "etaMin", c.eta_max as "etaMax", c.is_open as "isOpen",
  c.accepting_orders as "acceptingOrders", c.tags, c.sort`;

export const ITEM_COLS = `i.id, i.cafe_id as "cafeId", i.category_id as "categoryId", i.name, i.description, i.price,
  i.is_veg as "isVeg", i.emoji, i.image_url as "imageUrl", i.is_available as "isAvailable",
  i.is_popular as "isPopular", i.sort`;

export const PROFILE_COLS = `p.id, p.name, p.phone, p.email, p.location_id as "locationId", p.company, p.tower, p.floor, p.desk`;

export type OrderStatus = 'placed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'rejected' | 'cancelled';
export const ACTIVE_STATUSES: OrderStatus[] = ['placed', 'preparing', 'out_for_delivery'];

const ORDER_SELECT = `
  select o.id, o.order_no as "orderNo", o.status, o.user_id as "userId",
    o.items_total as "itemsTotal", o.delivery_fee as "deliveryFee", o.total,
    o.payment_method as "paymentMethod", o.cod_collected as "codCollected",
    o.customer_name as "customerName", o.customer_phone as "customerPhone",
    json_build_object('tower', o.tower, 'floor', o.floor, 'company', o.company, 'desk', o.desk) as address,
    o.note, o.rider_name as "riderName", o.reject_reason as "rejectReason",
    o.created_at as "createdAt", o.accepted_at as "acceptedAt", o.out_at as "outAt",
    o.delivered_at as "deliveredAt", o.cancelled_at as "cancelledAt", o.rejected_at as "rejectedAt",
    json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'emoji', c.emoji, 'coverColor', c.cover_color,
      'place', c.place, 'phone', c.phone, 'etaMin', c.eta_min, 'etaMax', c.eta_max) as cafe,
    json_build_object('id', l.id, 'slug', l.slug, 'name', l.name) as location,
    coalesce((select json_agg(json_build_object('id', oi.id, 'menuItemId', oi.menu_item_id, 'name', oi.name,
      'emoji', oi.emoji, 'price', oi.price, 'qty', oi.qty) order by oi.line_no, oi.name)
      from order_items oi where oi.order_id = o.id), '[]') as items
  from orders o
  join cafes c on c.id = o.cafe_id
  join locations l on l.id = o.location_id`;

export function selectOrders(where: string, params: unknown[], tail = 'order by o.created_at desc') {
  return q(`${ORDER_SELECT} where ${where} ${tail}`, params);
}

export async function selectOrder(id: string) {
  return (await selectOrders('o.id = $1', [id]))[0];
}
