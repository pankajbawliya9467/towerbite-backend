import { q } from '../db.js';

export type ComboRow = {
  id: string;
  cafeId: string;
  name: string;
  description: string;
  price: number;
  /** what the items cost one by one */
  mrp: number;
  emoji: string;
  imageUrl: string | null;
  startTime: string | null;
  endTime: string | null;
  days: number[];
  isActive: boolean;
  sort: number;
  items: { menuItemId: string; name: string; emoji: string; price: number; qty: number; isAvailable: boolean; isVeg: boolean }[];
  /** active, inside its time and day, and every item in stock */
  availableNow: boolean;
  isVeg: boolean;
};

const IST_NOW = `(now() at time zone 'Asia/Kolkata')`;

/** A combo's own window check (time of day + weekday, India time). */
export const COMBO_IN_WINDOW = `(
  extract(isodow from ${IST_NOW})::int = any(x.days)
  and (x.start_time is null or x.end_time is null
    or (x.start_time <= x.end_time and ${IST_NOW}::time between x.start_time and x.end_time)
    or (x.start_time > x.end_time and (${IST_NOW}::time >= x.start_time or ${IST_NOW}::time <= x.end_time)))
)`;

/** Combos of one cafe with their items. `activeOnly` for customers. */
export async function cafeCombos(cafeId: string, activeOnly: boolean): Promise<ComboRow[]> {
  const rows = await q<ComboRow & { inWindow: boolean }>(
    `select x.id, x.cafe_id as "cafeId", x.name, x.description, x.price, x.emoji, x.image_url as "imageUrl",
       to_char(x.start_time, 'HH24:MI') as "startTime", to_char(x.end_time, 'HH24:MI') as "endTime",
       x.days, x.is_active as "isActive", x.sort, ${COMBO_IN_WINDOW} as "inWindow",
       coalesce((select json_agg(json_build_object('menuItemId', i.id, 'name', i.name, 'emoji', i.emoji, 'price', i.price,
           'qty', ci.qty, 'isAvailable', i.is_available, 'isVeg', i.is_veg) order by i.price desc, i.name)
         from combo_items ci join menu_items i on i.id = ci.menu_item_id where ci.combo_id = x.id), '[]') as items
     from combos x where x.cafe_id = $1 ${activeOnly ? 'and x.is_active' : ''}
     order by x.sort, x.created_at`,
    [cafeId],
  );
  return rows
    .filter((r) => !activeOnly || r.items.length > 0)
    .map(({ inWindow, ...r }) => ({
      ...r,
      mrp: r.items.reduce((s, i) => s + i.price * i.qty, 0),
      isVeg: r.items.every((i) => i.isVeg),
      availableNow: r.isActive && inWindow && r.items.length > 0 && r.items.every((i) => i.isAvailable),
    }));
}

/** "2× Samosa, 1× Masala Chai" (kept on the order line so the kitchen sees what to make). */
export function comboDetail(items: { name: string; qty: number }[]) {
  return items.map((i) => `${i.qty}× ${i.name}`).join(', ');
}
