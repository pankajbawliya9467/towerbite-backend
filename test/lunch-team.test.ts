/**
 * Lunch pre-booking and team orders. Needs DEV_AUTH=true and a seeded database (npm run db:seed). Run: npm test
 */
process.env.SUPABASE_URL = 'http://realtime.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type Sent = { url: string; body: any };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  if (String(url).includes('exp.host')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
  return new Response('{}', { status: 202 });
}) as typeof fetch;

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const app = await buildApp();
after(async () => { globalThis.fetch = realFetch; await app.close(); await pool.end(); });
beforeEach(() => { sent = []; });

const H = (t: string) => ({ authorization: `Bearer dev:${t}` });
const call = async (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) => {
  const res = await app.inject({ method: method as any, url, headers, payload: payload as any });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
  return { status: res.statusCode, body, headers: res.headers };
};
const topics = () => sent.filter((s) => s.url.includes('/realtime/')).flatMap((s) => s.body.messages.map((m: any) => `${m.topic}#${m.event}`));
const pushes = () => sent.filter((s) => s.url.includes('exp.host')).flatMap((s) => s.body);
const settle = () => new Promise((r) => setTimeout(r, 80));

const cafeStaff = H('cafe@towerbites.dev');
const n = Date.now() % 1_000_000;
const phone = (k: number) => `+9190000${String(n + k).padStart(6, '0').slice(-5)}`;
const address = { tower: 'Tower B', floor: '7', company: 'Acme', desk: '7B-14' };
const ist = (addDays = 0) => new Date(Date.now() + 5.5 * 3600_000 + addDays * 86400_000).toISOString().slice(0, 10);

async function employee(k: number, name: string) {
  const h = H(phone(k));
  await call('GET', '/v1/me', h);
  const loc = await pool.query(`select id from locations where slug = 'spaze-tech-park'`);
  await call('PUT', '/v1/me', h, { name, locationId: loc.rows[0].id, ...address });
  await call('POST', '/v1/me/push-token', h, { token: `ExponentPushToken[test-${n}-${k}]` });
  // A new phone each run, so the per-user order limits from earlier runs don't get in the way.
  return h;
}

test('cafe posts lunch, employees book until plates run out, cancel, cafe sends out and delivers', async () => {
  const tomorrow = ist(1);
  const created = await call('POST', '/v1/cafe/lunch', cafeStaff, {
    day: tomorrow, name: `Veg Thali ${n}`, items: 'Dal, Paneer, Rice, 3 roti', price: 120, isVeg: true, plates: 3,
    closesAt: '11:30', cancelUntil: '10:30', slots: ['12:30-13:00', '13:00-13:30'], alsoOn: [ist(2)],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.length, 2, 'posted for tomorrow and the repeat day');
  const lunch = created.body[0];
  assert.equal(lunch.left, 3);
  assert.equal(lunch.bookable, true);
  await settle();
  assert.ok(topics().some((t) => t.startsWith('location:') && t.endsWith('#cafes')), 'apps reload the lunch card');

  // Bad input
  assert.equal((await call('POST', '/v1/cafe/lunch', cafeStaff, { ...created.body[0], day: ist(-1), slots: ['12:30-13:00'] })).status, 400);
  assert.equal((await call('POST', '/v1/cafe/lunch', cafeStaff, { day: tomorrow, name: 'X', price: 1, plates: 1, slots: ['13:00-12:00'] })).status, 400);
  assert.equal((await call('POST', '/v1/cafe/lunch', H(phone(90)), { day: tomorrow, name: 'X', price: 1, plates: 1, slots: ['12:00-13:00'] })).status, 403);

  // Employees see it on the building's lunch list
  const list = await call('GET', '/v1/locations/spaze-tech-park/lunch');
  assert.ok(list.body.some((l: any) => l.id === lunch.id));

  const a = await employee(1, 'Asha');
  const b = await employee(2, 'Bilal');
  const book = await call('POST', '/v1/lunch/bookings', a, { lunchId: lunch.id, slot: '13:00-13:30', qty: 2, address });
  assert.equal(book.status, 201, JSON.stringify(book.body));
  assert.equal(book.body.total, 240);
  assert.equal(book.body.canCancel, true);
  assert.ok(topics().includes(`cafe:${lunch.cafeId}#lunch`), 'cafe screen updates live');
  assert.equal((await call('POST', '/v1/lunch/bookings', a, { lunchId: lunch.id, slot: '12:30-13:00', qty: 1, address })).status, 409, 'one booking per lunch');
  const tooMany = await call('POST', '/v1/lunch/bookings', b, { lunchId: lunch.id, slot: '12:30-13:00', qty: 2, address });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.body.error, /Only 1 plates left/);
  assert.equal((await call('POST', '/v1/lunch/bookings', b, { lunchId: lunch.id, slot: '11:00-11:30', qty: 1, address })).status, 400, 'unknown slot');
  const bBook = await call('POST', '/v1/lunch/bookings', b, { lunchId: lunch.id, slot: '12:30-13:00', qty: 1, address });
  assert.equal(bBook.status, 201);

  // Cafe can't shrink below booked or drop a booked slot
  const base = { day: tomorrow, name: lunch.name, items: lunch.items, price: 120, isVeg: true, closesAt: '11:30', cancelUntil: '10:30' };
  assert.equal((await call('PUT', `/v1/cafe/lunch/${lunch.id}`, cafeStaff, { ...base, plates: 2, slots: lunch.slots })).status, 409);
  assert.equal((await call('PUT', `/v1/cafe/lunch/${lunch.id}`, cafeStaff, { ...base, plates: 5, slots: ['13:00-13:30'] })).status, 409);
  const grown = await call('PUT', `/v1/cafe/lunch/${lunch.id}`, cafeStaff, { ...base, plates: 5, slots: [...lunch.slots, '13:30-14:00'] });
  assert.equal(grown.status, 200, JSON.stringify(grown.body));
  assert.equal(grown.body.left, 2);
  assert.equal((await call('DELETE', `/v1/cafe/lunch/${lunch.id}`, cafeStaff)).status, 409, 'has bookings');

  // Someone else can't see or cancel my booking
  assert.equal((await call('GET', `/v1/lunch/bookings/${book.body.id}`, b)).status, 404);
  assert.equal((await call('POST', `/v1/lunch/bookings/${book.body.id}/cancel`, b)).status, 409);
  const cancel = await call('POST', `/v1/lunch/bookings/${bBook.body.id}/cancel`, b);
  assert.equal(cancel.body.status, 'cancelled');
  const mine = await call('GET', '/v1/lunch/bookings', a);
  assert.ok(mine.body.some((x: any) => x.id === book.body.id));

  // Cafe: bookings, kitchen plan per slot, CSV, send out a slot, deliver
  const cafeLunch = await call('GET', `/v1/cafe/lunch?from=${tomorrow}&to=${tomorrow}`, cafeStaff);
  const mineLunch = cafeLunch.body.find((l: any) => l.id === lunch.id);
  assert.deepEqual(mineLunch.bySlot.find((s: any) => s.slot === '13:00-13:30'), { slot: '13:00-13:30', plates: 2 });
  const bookings = await call('GET', `/v1/cafe/lunch/bookings?day=${tomorrow}`, cafeStaff);
  assert.ok(bookings.body.some((x: any) => x.id === book.body.id && x.address.desk === '7B-14'));
  const csvRes = await call('GET', `/v1/cafe/lunch/bookings.csv?day=${tomorrow}`, cafeStaff);
  assert.equal(csvRes.status, 200);
  assert.match(String(csvRes.body), /Booking no,Delivery time/);
  const out = await call('POST', '/v1/cafe/lunch/dispatch', cafeStaff, { day: tomorrow, slot: '13:00-13:30' });
  assert.ok(out.body.updated >= 1);
  await settle();
  assert.ok(pushes().some((p) => p.title === 'Your lunch is on the way'));
  assert.equal((await call('POST', `/v1/lunch/bookings/${book.body.id}/cancel`, a)).status, 409, 'already on the way');
  const done = await call('POST', `/v1/cafe/lunch/bookings/${book.body.id}/deliver`, cafeStaff);
  assert.equal(done.body.status, 'delivered');

  // Stop bookings
  const stopped = await call('PATCH', `/v1/cafe/lunch/${created.body[1].id}`, cafeStaff, { isActive: false });
  assert.equal(stopped.body.bookable, false);
  assert.equal((await call('POST', '/v1/lunch/bookings', b, { lunchId: created.body[1].id, slot: '12:30-13:00', qty: 1, address })).status, 409);
  assert.equal((await call('DELETE', `/v1/cafe/lunch/${created.body[1].id}`, cafeStaff)).status, 200);
});

test('team order: host shares a code, teammates add, host places one order, bill is split', async () => {
  const cafe = (await pool.query(`select id from cafes where slug = 'krunchy-kafe'`)).rows[0];
  await pool.query(`update cafes set is_open = true, accepting_orders = true where id = $1`, [cafe.id]);
  const items = (await pool.query(`select id, price from menu_items where cafe_id = $1 and is_available order by price limit 3`, [cafe.id])).rows;
  const host = await employee(11, 'Rahul');
  const neha = await employee(12, 'Neha');
  const arjun = await employee(13, 'Arjun');

  const created = await call('POST', '/v1/team-orders', host, {
    cafeId: cafe.id, name: '4 PM chai', deliverTo: 'Meeting room B', deliverAt: '16:00', closesInMin: 15, payMode: 'split', upiId: 'rahul@okaxis',
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const code = created.body.code;
  assert.match(code, /^[A-Z0-9]{8}$/);
  assert.equal(created.body.isHost, true);
  assert.equal((await call('POST', '/v1/team-orders', host, { cafeId: cafe.id, name: 'x', deliverTo: 'y', upiId: 'not a upi' })).status, 400);

  // Teammates open the link and add their own items
  const seen = await call('GET', `/v1/team-orders/${code}`, neha);
  assert.equal(seen.body.isHost, false);
  assert.equal(seen.body.upiId, 'rahul@okaxis');
  assert.equal((await call('GET', '/v1/team-orders/NOPE0000', neha)).status, 404);
  await call('PUT', `/v1/team-orders/${code}/items`, host, { items: [{ menuItemId: items[0].id, qty: 2 }] });
  const n1 = await call('PUT', `/v1/team-orders/${code}/items`, neha, { items: [{ menuItemId: items[1].id, qty: 1 }], note: 'less sugar' });
  assert.equal(n1.status, 200, JSON.stringify(n1.body));
  await call('PUT', `/v1/team-orders/${code}/items`, arjun, { items: [{ menuItemId: items[2].id, qty: 1 }, { menuItemId: items[0].id, qty: 1 }] });
  const other = (await pool.query(`select id from menu_items where cafe_id <> $1 limit 1`, [cafe.id])).rows[0];
  assert.equal((await call('PUT', `/v1/team-orders/${code}/items`, arjun, { items: [{ menuItemId: other.id, qty: 1 }] })).status, 400, 'other cafe item');

  const view = await call('GET', `/v1/team-orders/${code}`, host);
  assert.equal(view.body.peopleWithItems, 3);
  const expected = items[0].price * 2 + items[1].price + items[2].price + items[0].price;
  assert.equal(view.body.total, expected);
  assert.equal(view.body.toCollect, expected - items[0].price * 2, 'host does not owe themselves');

  // Only the host places; the cafe gets ONE order with everyone's names in the note
  assert.equal((await call('POST', `/v1/team-orders/${code}/place`, neha)).status, 403);
  const placed = await call('POST', `/v1/team-orders/${code}/place`, host);
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const order = placed.body.order;
  assert.equal(order.total, expected);
  assert.equal(order.address.desk, 'Meeting room B');
  assert.match(order.note, /Neha: 1× .*less sugar/);
  assert.equal(order.team.code, code);
  assert.equal(order.team.people, 3);
  await settle();
  assert.ok(topics().includes(`cafe:${cafe.id}#order`), 'shows on the cafe board');
  assert.ok(pushes().filter((p) => p.title.startsWith('Team order placed')).length >= 0);
  assert.equal((await call('POST', `/v1/team-orders/${code}/place`, host)).status, 409, 'no double order');
  assert.equal((await call('PUT', `/v1/team-orders/${code}/items`, neha, { items: [] })).status, 409, 'closed after placing');

  // Cafe accepts: teammates are told too
  sent = [];
  await call('POST', `/v1/cafe/orders/${order.id}/accept`, cafeStaff);
  await settle();
  assert.ok(pushes().some((p) => p.title.startsWith('4 PM chai:')), JSON.stringify(pushes()));

  // Paying shares
  const nehaId = view.body.people.find((p: any) => p.name === 'Neha').userId;
  const arjunId = view.body.people.find((p: any) => p.name === 'Arjun').userId;
  assert.equal((await call('POST', `/v1/team-orders/${code}/paid`, neha, { userId: arjunId })).status, 403, 'only host marks others');
  const paid = await call('POST', `/v1/team-orders/${code}/paid`, neha, {});
  assert.equal(paid.body.me.paid, false, 'a teammate can only claim; the host confirms');
  assert.equal(paid.body.me.claimed, true);
  assert.equal(paid.body.collected, 0);
  assert.equal((await call('POST', `/v1/team-orders/${code}/remind`, host, { userId: nehaId })).status, 409, 'says paid: confirm instead');
  assert.equal((await call('POST', `/v1/team-orders/${code}/paid`, host, { userId: nehaId })).body.people.find((p: any) => p.userId === nehaId).paid, true);
  assert.equal((await call('POST', `/v1/team-orders/${code}/remind`, host, { userId: arjunId })).status, 200);
  assert.equal((await call('POST', `/v1/team-orders/${code}/remind`, host, { userId: arjunId })).status, 429, 'not spammy');
  const hostMarks = await call('POST', `/v1/team-orders/${code}/paid`, host, { userId: arjunId });
  assert.equal(hostMarks.body.collected, hostMarks.body.toCollect);

  const mine = await call('GET', '/v1/team-orders', arjun);
  assert.ok(mine.body.some((t: any) => t.code === code && t.status === 'placed'));

  // Cancel flow on a second team order
  const t2 = await call('POST', '/v1/team-orders', host, { cafeId: cafe.id, name: 'Snacks', deliverTo: 'Bay 7', payMode: 'host' });
  assert.equal((await call('POST', `/v1/team-orders/${t2.body.code}/cancel`, neha)).status, 403);
  assert.equal((await call('POST', `/v1/team-orders/${t2.body.code}/cancel`, host)).body.status, 'cancelled');
  assert.equal((await call('POST', `/v1/team-orders/${t2.body.code}/place`, host)).status, 409);
});

test('admin sends a custom notification to a building, a company or one person; nobody else can', async () => {
  const admin = H('admin@towerbites.dev');
  const emp = await employee(31, 'Kiran');
  const loc = (await pool.query(`select id from locations where slug = 'spaze-tech-park'`)).rows[0];
  const body = { title: 'Diwali offer', body: 'Free sweet with every order today', audience: { type: 'location', locationId: loc.id } };
  assert.equal((await call('POST', '/v1/admin/notifications', emp, body)).status, 403, 'employees cannot send');
  assert.equal((await call('POST', '/v1/admin/notifications', cafeStaff, body)).status, 403, 'cafe staff cannot send');
  const preview = await call('POST', '/v1/admin/notifications/preview', admin, { audience: body.audience });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.users >= 1);
  sent = [];
  const res = await call('POST', '/v1/admin/notifications', admin, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await settle();
  assert.ok(pushes().some((p) => p.title === 'Diwali offer' && p.to === `ExponentPushToken[test-${n}-31]`));
  const one = await call('POST', '/v1/admin/notifications/preview', admin, { audience: { type: 'user', phone: phone(31).slice(3) } });
  assert.equal(one.body.users, 1);
  assert.match(one.body.label, /Kiran/);
  assert.equal((await call('POST', '/v1/admin/notifications', admin, { ...body, audience: { type: 'user', phone: '9000000000' } })).status, 400, 'nobody to send to');
  assert.equal((await call('POST', '/v1/admin/notifications', admin, { ...body, title: '' })).status, 400);
  const history = await call('GET', '/v1/admin/notifications', admin);
  assert.equal(history.body[0].title, 'Diwali offer');
});

test('sub-categories: one level, same cafe, and the menu sends parentId', async () => {
  const admin = H('admin@towerbites.dev');
  const cafes = (await call('GET', '/v1/admin/cafes', admin)).body as { id: string }[];
  const [a, b] = cafes;
  const snacks = (await call('POST', '/v1/admin/categories', admin, { cafeId: a.id, name: 'Snacks T', sort: 50 })).body;
  const burgers = await call('POST', '/v1/admin/categories', admin, { cafeId: a.id, parentId: snacks.id, name: 'Burgers T', sort: 1 });
  assert.equal(burgers.status, 201);
  assert.equal(burgers.body.parentId, snacks.id);
  assert.equal((await call('POST', '/v1/admin/categories', admin, { cafeId: a.id, parentId: burgers.body.id, name: 'Deep' })).status, 400, 'only one level');
  assert.equal((await call('POST', '/v1/admin/categories', admin, { cafeId: b.id, parentId: snacks.id, name: 'Other cafe' })).status, 400, 'parent in another cafe');
  assert.equal((await call('PATCH', `/v1/admin/categories/${snacks.id}`, admin, { parentId: burgers.body.id })).status, 400, 'a parent cannot become a sub');
  assert.equal((await call('PATCH', `/v1/admin/categories/${snacks.id}`, admin, { parentId: snacks.id })).status, 400, 'not inside itself');
  const otherCat = (await call('POST', '/v1/admin/categories', admin, { cafeId: b.id, name: 'B cat' })).body;
  assert.equal((await call('POST', '/v1/admin/menu-items', admin, { cafeId: a.id, categoryId: otherCat.id, name: 'X', price: 10 })).status, 400, 'item category from another cafe');
  const item = await call('POST', '/v1/admin/menu-items', admin, { cafeId: a.id, categoryId: burgers.body.id, name: 'Aloo Tikki Burger T', price: 60 });
  assert.equal(item.status, 201);
  const menu = (await call('GET', `/v1/cafes/${a.id}`)).body as { categories: { id: string; parentId: string | null }[] };
  assert.equal(menu.categories.find((c) => c.id === burgers.body.id)?.parentId, snacks.id);
  // deleting the parent keeps the sub as a main category
  assert.equal((await call('DELETE', `/v1/admin/categories/${snacks.id}`, admin)).status, 200);
  const after = (await call('GET', `/v1/admin/categories/${burgers.body.id}`, admin)).body;
  assert.equal(after.parentId, null);
  await call('DELETE', `/v1/admin/menu-items/${item.body.id}`, admin);
  await call('DELETE', `/v1/admin/categories/${burgers.body.id}`, admin);
  await call('DELETE', `/v1/admin/categories/${otherCat.id}`, admin);
});

test('combos: cafe builds one, customer orders it at the combo price, then rates the delivered order', async () => {
  const cafe = (await call('GET', '/v1/cafe', cafeStaff)).body;
  const menu = (await call('GET', `/v1/cafes/${cafe.id}`)).body;
  const [x, y] = menu.items.filter((i: any) => i.isAvailable);
  const mrp = x.price * 2 + y.price;
  const body = { name: `Test combo ${n}`, price: mrp - 10, items: [{ menuItemId: x.id, qty: 2 }, { menuItemId: y.id, qty: 1 }] };

  assert.equal((await call('POST', '/v1/cafe/combos', H(phone(60)), body)).status, 403, 'employees cannot make combos');
  assert.equal((await call('POST', '/v1/cafe/combos', cafeStaff, { ...body, price: mrp + 1 })).status, 400, 'not more than the items');
  assert.equal((await call('POST', '/v1/cafe/combos', cafeStaff, { ...body, items: [{ menuItemId: x.id, qty: 1 }] })).status, 400, 'needs two things');
  assert.equal((await call('POST', '/v1/cafe/combos', cafeStaff, { ...body, startTime: '16:00' })).status, 400, 'both times');
  const made = await call('POST', '/v1/cafe/combos', cafeStaff, body);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.mrp, mrp);
  assert.equal(made.body.availableNow, true);

  const pub = (await call('GET', `/v1/cafes/${cafe.id}`)).body;
  assert.ok(pub.combos.some((c: any) => c.id === made.body.id), 'customers see it');

  const emp = await employee(61, 'Combo Fan');
  const order = await call('POST', '/v1/orders', emp, { cafeId: cafe.id, combos: [{ comboId: made.body.id, qty: 2 }], items: [{ menuItemId: y.id, qty: 1 }], address });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(order.body.total, (mrp - 10) * 2 + y.price);
  assert.equal(order.body.savings, 20);
  const line = order.body.items.find((i: any) => i.comboId === made.body.id);
  assert.equal(line.name, body.name);
  assert.match(line.detail, /2× /);

  // Switched off → can't be ordered
  await call('PATCH', `/v1/cafe/combos/${made.body.id}`, cafeStaff, { isActive: false });
  assert.equal((await call('POST', '/v1/orders', emp, { cafeId: cafe.id, combos: [{ comboId: made.body.id, qty: 1 }], address })).status, 400);
  // Outside its hours → not available now
  const hour = new Date(Date.now() + 5.5 * 3600_000).getUTCHours();
  const off = `${String((hour + 3) % 24).padStart(2, '0')}:00`, off2 = `${String((hour + 4) % 24).padStart(2, '0')}:00`;
  const timed = await call('PATCH', `/v1/cafe/combos/${made.body.id}`, cafeStaff, { ...body, isActive: true, startTime: off, endTime: off2 });
  assert.equal(timed.body.availableNow, false);
  assert.equal((await call('POST', '/v1/orders', emp, { cafeId: cafe.id, combos: [{ comboId: made.body.id, qty: 1 }], address })).status, 409);

  // Rating: only after delivery, once, own order only
  const id = order.body.id;
  assert.equal((await call('POST', `/v1/orders/${id}/rating`, emp, { stars: 5 })).status, 409, 'not delivered yet');
  for (const step of ['accept', 'dispatch', 'deliver']) await call('POST', `/v1/cafe/orders/${id}/${step}`, cafeStaff, { riderName: 'Raju' });
  await settle();
  assert.ok(pushes().some((p: any) => p.data?.rate === '1'), 'delivered push asks for a rating');
  assert.equal((await call('POST', `/v1/orders/${id}/rating`, H(phone(62)), { stars: 5 })).status, 404, 'someone else');
  const before = (await call('GET', `/v1/cafes/${cafe.id}`)).body.ratingCount;
  const rated = await call('POST', `/v1/orders/${id}/rating`, emp, { stars: 2, tags: ['cold', 'late', 'nonsense'], comment: 'Chai was cold', items: { [y.id]: false } });
  assert.equal(rated.status, 201, JSON.stringify(rated.body));
  assert.deepEqual(rated.body.tags, ['cold', 'late']);
  assert.equal((await call('POST', `/v1/orders/${id}/rating`, emp, { stars: 5 })).status, 409, 'only once');
  assert.equal((await call('GET', `/v1/cafes/${cafe.id}`)).body.ratingCount, before + 1);
  assert.equal((await call('GET', `/v1/orders/${id}`, emp)).body.rating.stars, 2);

  const report = await call('GET', '/v1/cafe/ratings?days=7', cafeStaff);
  assert.equal(report.status, 200);
  assert.ok(report.body.low >= 1);
  const row = report.body.list.find((r: any) => r.orderId === id);
  assert.equal(row.firstName, 'Combo');
  assert.equal(row.comment, 'Chai was cold');
  assert.equal((await call('GET', '/v1/cafe/ratings', H(phone(61)))).status, 403);

  const sorry = await call('POST', `/v1/cafe/ratings/${id}/sorry`, cafeStaff, { message: 'Sorry about the cold chai, next one is on us!' });
  assert.equal(sorry.status, 200);
  assert.equal((await call('POST', `/v1/cafe/ratings/${id}/sorry`, cafeStaff, { message: 'Again sorry!!' })).status, 409, 'once');
  await call('DELETE', `/v1/cafe/combos/${made.body.id}`, cafeStaff);
});
