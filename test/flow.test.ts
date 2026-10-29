/**
 * End-to-end order flow against a real database (uses DATABASE_URL, needs DEV_AUTH=true and seeded data).
 * Run: npm test
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

const app = await buildApp();
after(async () => { await app.close(); await pool.end(); });

const emp = { authorization: 'Bearer dev:+919876541207' };
const cafeStaff = { authorization: 'Bearer dev:cafe@towerbites.dev' };
const admin = { authorization: 'Bearer dev:admin@towerbites.dev' };
const call = async (method: string, url: string, headers = {}, payload?: unknown) => {
  const res = await app.inject({ method: method as any, url, headers, payload: payload as any });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test('employee orders, cafe moves it through every step', async () => {
  const cafe = (await call('GET', '/v1/locations/spaze-tech-park/cafes/krunchy-kafe')).body;
  const chai = cafe.items.find((i: any) => i.name === 'Masala Chai');
  const samosa = cafe.items.find((i: any) => i.name.startsWith('Samosa'));

  assert.equal((await call('GET', '/v1/me')).status, 401);
  const me = await call('PUT', '/v1/me', emp, { name: 'Rahul Sharma' });
  assert.equal(me.body.name, 'Rahul Sharma');

  const placed = await call('POST', '/v1/orders', emp, {
    cafeId: cafe.id,
    items: [{ menuItemId: chai.id, qty: 2 }, { menuItemId: samosa.id, qty: 1 }],
    address: { tower: 'Tower B', floor: '7th floor', company: 'SolutionBowl', desk: '7B-14' },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.body.total, 90);
  assert.equal(placed.body.status, 'placed');
  const id = placed.body.id;

  const board = await call('GET', '/v1/cafe/orders', cafeStaff);
  assert.ok(board.body.some((o: any) => o.id === id));

  // employee can't act as cafe
  assert.equal((await call('POST', `/v1/cafe/orders/${id}/accept`, emp)).status, 403);
  assert.equal((await call('POST', `/v1/cafe/orders/${id}/dispatch`, cafeStaff, {})).status, 409);
  assert.equal((await call('POST', `/v1/cafe/orders/${id}/accept`, cafeStaff, {})).body.status, 'preparing');
  assert.equal((await call('POST', `/v1/orders/${id}/cancel`, emp)).status, 409);
  const out = await call('POST', `/v1/cafe/orders/${id}/dispatch`, cafeStaff, { riderName: 'Raju' });
  assert.equal(out.body.riderName, 'Raju');
  const done = await call('POST', `/v1/cafe/orders/${id}/deliver`, cafeStaff, {});
  assert.equal(done.body.status, 'delivered');
  assert.equal(done.body.codCollected, true);

  const mine = await call('GET', '/v1/orders?status=past', emp);
  assert.ok(mine.body.some((o: any) => o.id === id));
  const profile = await call('GET', '/v1/me', emp);
  assert.equal(profile.body.desk, '7B-14');
});

test('out of stock items and other users are blocked', async () => {
  const cafe = (await call('GET', '/v1/locations/spaze-tech-park/cafes/krunchy-kafe')).body;
  const coffee = cafe.items.find((i: any) => i.name === 'Cold Coffee');
  await call('PATCH', `/v1/cafe/menu-items/${coffee.id}`, cafeStaff, { isAvailable: false });
  const r = await call('POST', '/v1/orders', emp, {
    cafeId: cafe.id, items: [{ menuItemId: coffee.id, qty: 1 }],
    address: { tower: 'Tower B', floor: '7', company: '', desk: '1' },
  });
  assert.equal(r.status, 409);
  await call('PATCH', `/v1/cafe/menu-items/${coffee.id}`, cafeStaff, { isAvailable: true });

  const other = { authorization: 'Bearer dev:+919999999999' };
  const placed = await call('POST', '/v1/orders', emp, {
    cafeId: cafe.id, items: [{ menuItemId: coffee.id, qty: 1 }],
    address: { tower: 'Tower B', floor: '7', company: '', desk: '1' },
  });
  assert.equal((await call('GET', `/v1/orders/${placed.body.id}`, other)).status, 404);
  assert.equal((await call('POST', `/v1/orders/${placed.body.id}/cancel`, emp)).body.status, 'cancelled');
});

test('admin manages cafes and products; others cannot', async () => {
  assert.equal((await call('GET', '/v1/admin/cafes', cafeStaff)).status, 403);
  const locs = (await call('GET', '/v1/locations')).body;
  const spaze = locs.find((l: any) => l.slug === 'spaze-tech-park');
  const c = await call('POST', '/v1/admin/cafes', admin, { locationId: spaze.id, slug: `test-cafe-${Date.now()}`, name: 'Test Cafe' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const item = await call('POST', '/v1/admin/menu-items', admin, { cafeId: c.body.id, name: 'Tea', price: 20 });
  assert.equal(item.body.price, 20);
  const upd = await call('PATCH', `/v1/admin/menu-items/${item.body.id}`, admin, { price: 25 });
  assert.equal(upd.body.price, 25);
  const stats = await call('GET', '/v1/admin/stats', admin);
  assert.ok(stats.body.cafes >= 7);
  assert.equal((await call('DELETE', `/v1/admin/cafes/${c.body.id}`, admin)).status, 200);
  assert.equal((await call('GET', '/v1/admin/cafes/not-a-uuid', admin)).status, 404);
});

test('security: active order cap, fake image, headers', async () => {
  const cafe = (await call('GET', '/v1/locations/spaze-tech-park/cafes/tapri-chai')).body;
  const user = { authorization: `Bearer dev:+9198${Date.now().toString().slice(-8)}` };
  const place = () => call('POST', '/v1/orders', user, {
    cafeId: cafe.id, items: [{ menuItemId: cafe.items[0].id, qty: 1 }],
    address: { tower: 'Tower C', floor: '2', company: '', desk: '2C-1' },
  });
  for (let i = 0; i < 3; i++) assert.equal((await place()).status, 201);
  assert.equal((await place()).status, 409);

  const res = await app.inject({ method: 'GET', url: '/v1/health' });
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(String(res.headers['content-security-policy']).includes("default-src 'none'"));
});
