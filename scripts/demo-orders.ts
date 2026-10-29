/**
 * Adds sample orders so the cafe board and order screens are not empty.
 *   npm run db:demo
 * Uses dev user ids (log in with DEV_AUTH and phone +919876541207 to see Rahul's orders).
 */
import { pool } from '../src/db.js';
import { devUserId } from '../src/lib/devId.js';

type Line = [item: string, qty: number];
type Demo = {
  phone: string; name: string; company: string; tower: string; floor: string; desk: string;
  cafe: string; lines: Line[]; status: string; minutesAgo: number; rider?: string;
};

const demos: Demo[] = [
  { phone: '+919876541207', name: 'Rahul Sharma', company: 'SolutionBowl', tower: 'Tower B', floor: '7', desk: '7B-14',
    cafe: 'desi-tiffin', lines: [['Rajma Chawal', 1], ['Sweet Lassi', 1]], status: 'delivered', minutesAgo: 60 * 24 },
  { phone: '+919876541207', name: 'Rahul Sharma', company: 'SolutionBowl', tower: 'Tower B', floor: '7', desk: '7B-14',
    cafe: 'green-bowl', lines: [['Paneer Wrap', 1], ['Orange Juice', 1]], status: 'delivered', minutesAgo: 60 * 24 * 2 },
  { phone: '+919811100001', name: 'Arjun', company: 'Codeworks', tower: 'Tower B', floor: '5', desk: '5C-02',
    cafe: 'krunchy-kafe', lines: [['Grilled Sandwich', 1], ['Masala Chai', 1], ['Samosa (2 pcs)', 0]], status: 'out_for_delivery', minutesAgo: 9, rider: 'Raju' },
  { phone: '+919811100002', name: 'Neha', company: 'PayNest', tower: 'Tower A', floor: '8', desk: '8A-11',
    cafe: 'krunchy-kafe', lines: [['Cold Coffee', 2], ['Samosa (2 pcs)', 1], ['Masala Chai', 2], ['Veg Puff', 2]], status: 'out_for_delivery', minutesAgo: 8, rider: 'Sonu' },
  { phone: '+919876541207', name: 'Rahul Sharma', company: 'SolutionBowl', tower: 'Tower B', floor: '7', desk: '7B-14',
    cafe: 'krunchy-kafe', lines: [['Masala Chai', 2], ['Samosa (2 pcs)', 1]], status: 'out_for_delivery', minutesAgo: 6, rider: 'Raju' },
  { phone: '+919811100003', name: 'Karan', company: 'DesignHub', tower: 'Tower B', floor: '9', desk: '9A-03',
    cafe: 'krunchy-kafe', lines: [['Grilled Sandwich', 2], ['Cold Coffee', 2]], status: 'preparing', minutesAgo: 4 },
  { phone: '+919811100004', name: 'Ankit', company: 'Finly', tower: 'Tower A', floor: '4', desk: 'Cabin 12',
    cafe: 'krunchy-kafe', lines: [['Cold Coffee', 2]], status: 'placed', minutesAgo: 1 },
  { phone: '+919811100005', name: 'Priya', company: 'SolutionBowl', tower: 'Tower B', floor: '7', desk: '7B-20',
    cafe: 'krunchy-kafe', lines: [['Masala Chai', 2], ['Samosa (2 pcs)', 1]], status: 'placed', minutesAgo: 0 },
];

for (const d of demos) {
  const userId = devUserId(d.phone);
  const cafe = (await pool.query(`select id, location_id from cafes where slug = $1`, [d.cafe])).rows[0];
  if (!cafe) throw new Error(`Cafe ${d.cafe} missing, run npm run db:seed first`);
  await pool.query(
    `insert into profiles (id, phone, name, company, tower, floor, desk, location_id) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (id) do nothing`,
    [userId, d.phone, d.name, d.company, d.tower, d.floor, d.desk, cafe.location_id],
  );
  const lines = [];
  for (const [name, qty] of d.lines) {
    if (!qty) continue;
    const item = (await pool.query(`select id, name, emoji, price from menu_items where cafe_id = $1 and name = $2`, [cafe.id, name])).rows[0];
    lines.push({ ...item, qty });
  }
  const total = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const at = `now() - interval '${d.minutesAgo} minutes'`;
  const done = ['preparing', 'out_for_delivery', 'delivered'].includes(d.status);
  const { rows } = await pool.query(
    `insert into orders (user_id, cafe_id, location_id, status, items_total, total, customer_name, customer_phone,
       tower, floor, company, desk, rider_name, cod_collected, created_at, accepted_at, out_at, delivered_at)
     values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13, ${at},
       ${done ? `${at} + interval '1 minute'` : 'null'},
       ${d.status === 'out_for_delivery' || d.status === 'delivered' ? `${at} + interval '4 minutes'` : 'null'},
       ${d.status === 'delivered' ? `${at} + interval '12 minutes'` : 'null'}) returning id`,
    [userId, cafe.id, cafe.location_id, d.status, total, d.name, d.phone, d.tower, d.floor, d.company, d.desk,
      d.rider ?? null, d.status === 'delivered'],
  );
  for (const [lineNo, l] of lines.entries()) {
    await pool.query(`insert into order_items (order_id, menu_item_id, name, emoji, price, qty, line_no) values ($1,$2,$3,$4,$5,$6,$7)`,
      [rows[0].id, l.id, l.name, l.emoji, l.price, l.qty, lineNo]);
  }
}
console.log(`✓ Added ${demos.length} sample orders`);
await pool.end();
