/** Admins table + permissions, cafe login email change, own password change. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const n = Date.now();
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const admin = H('dev:admin@towerbites.dev');
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const login = (email: string, password: string) => call('POST', '/v1/auth/staff/login', { email, password }, {});

test('super admin creates a limited admin who only sees their sections', async () => {
  const me = await call('GET', '/v1/me');
  assert.equal(me.body.staff.isSuper, true, 'the dev admin was moved to the admins table as super');

  const email = `ops${n}@tb.test`;
  assert.equal((await call('POST', '/v1/admin/admins', { name: 'Ops', email, password: 'password123', permissions: [] })).status, 400);
  const made = await call('POST', '/v1/admin/admins', { name: 'Ops', email, password: 'password123', permissions: ['orders.view', 'menu.add', 'menu.edit'] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.deepEqual(made.body.permissions, ['orders.view', 'menu.view', 'menu.add', 'menu.edit'], 'view added');
  assert.equal((await call('POST', '/v1/admin/admins', { name: 'X', email, password: 'password123', permissions: ['orders.view'] })).status, 400, 'email taken');

  const s = await login(email, 'password123');
  assert.equal(s.status, 200);
  const ops = H(s.body.token);
  const me2 = await call('GET', '/v1/me', undefined, ops);
  assert.equal(me2.body.staff.permissions.length, 4);
  assert.equal((await call('GET', '/v1/admin/orders', undefined, ops)).status, 200);
  assert.equal((await call('GET', '/v1/admin/categories', undefined, ops)).status, 200);
  assert.equal((await call('GET', '/v1/admin/users', undefined, ops)).status, 403);
  assert.equal((await call('GET', '/v1/admin/locations', undefined, ops)).status, 200, 'lists are readable');
  assert.equal((await call('POST', '/v1/admin/locations', { slug: `x${n}`, name: 'X' }, ops)).status, 403);
  assert.equal((await call('GET', '/v1/admin/staff', undefined, ops)).status, 403);
  assert.equal((await call('GET', '/v1/admin/admins', undefined, ops)).status, 403);
  assert.equal((await call('GET', '/v1/admin/account-requests', undefined, ops)).status, 403);
  assert.equal((await call('GET', '/v1/admin/notifications', undefined, ops)).status, 403);
  const cafe = (await q<{ id: string }>(`select id from cafes limit 1`))[0].id;
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, { ...ops, 'x-cafe-id': cafe })).status, 403, 'cafe panel needs cafes');

  // switched off → logged out, can't log in
  const off = await call('PATCH', `/v1/admin/admins/${made.body.id}`, { isActive: false });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal((await call('GET', '/v1/admin/orders', undefined, ops)).status, 401);
  assert.equal((await login(email, 'password123')).status, 401);
  await q(`delete from admins where id = $1`, [made.body.id]);
  await q(`delete from menu_items where cafe_id = $1`, [cafe.id]);
  await q(`delete from cafes where id = $1`, [cafe.id]);
});

test('an admin with the admins section cannot hand out more than they have, nor touch super admins', async () => {
  const email = `hr${n}@tb.test`;
  const made = await call('POST', '/v1/admin/admins', { name: 'HR', email, password: 'password123', permissions: ['admins.add', 'admins.edit', 'orders.view'] });
  assert.equal(made.status, 201);
  const hr = H((await login(email, 'password123')).body.token);
  assert.equal((await call('POST', '/v1/admin/admins', { name: 'A', email: `a${n}@tb.test`, password: 'password123', permissions: ['users.view'] }, hr)).status, 403);
  assert.equal((await call('POST', '/v1/admin/admins', { name: 'A', email: `a${n}@tb.test`, password: 'password123', isSuper: true }, hr)).status, 403);
  const sub = await call('POST', '/v1/admin/admins', { name: 'A', email: `a${n}@tb.test`, password: 'password123', permissions: ['orders.view'] }, hr);
  assert.equal(sub.status, 201);
  const superId = (await q<{ id: string }>(`select id from admins where is_super limit 1`))[0].id;
  assert.equal((await call('POST', `/v1/admin/admins/${superId}/password`, { password: 'hacked1234' }, hr)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/admins/${superId}`, { name: 'x' }, hr)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/admins/${sub.body.id}`, { isActive: false }, hr)).status, 403, 'turn off needs admins.delete');
  assert.equal((await call('PATCH', `/v1/admin/admins/${made.body.id}`, { permissions: ['admins.view', 'orders.view', 'users.view'] }, hr)).status, 400, 'not own access');
  assert.equal((await call('PATCH', `/v1/admin/admins/${superId}`, { isSuper: false })).status, 400, 'last super stays');
  await q(`delete from admins where id = any($1::uuid[])`, [[made.body.id, sub.body.id]]);
});

test('admin changes a cafe login email (logs them out); cafe changes own password (other devices out)', async () => {
  const cafeId = (await q<{ id: string }>(`select id from cafes limit 1`))[0].id;
  const email = `counter${n}@cafe.test`;
  const made = await call('POST', '/v1/admin/staff', { name: 'Counter', email, password: 'password123', cafeId });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const a = H((await login(email, 'password123')).body.token);
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, a)).status, 200);

  assert.equal((await call('PATCH', `/v1/admin/staff/${made.body.userId}`, { email: 'admin@towerbites.dev' })).status, 400, 'admin email taken');
  const ch = await call('PATCH', `/v1/admin/staff/${made.body.userId}`, { email: `new-${email}` });
  assert.equal(ch.status, 200);
  assert.equal(ch.body.loggedOut, true);
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, a)).status, 401);
  assert.equal((await login(email, 'password123')).status, 401);

  const t1 = H((await login(`new-${email}`, 'password123')).body.token);
  const t2 = H((await login(`new-${email}`, 'password123')).body.token);
  assert.equal((await call('POST', '/v1/auth/password', { current: 'wrong', next: 'brandnew99' }, t1)).status, 400);
  assert.equal((await call('POST', '/v1/auth/password', { current: 'password123', next: 'short' }, t1)).status, 400);
  assert.equal((await call('POST', '/v1/auth/password', { current: 'password123', next: 'brandnew99' }, t1)).status, 200);
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, t1)).status, 200, 'this device stays in');
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, t2)).status, 401, 'other device out');
  assert.equal((await login(`new-${email}`, 'brandnew99')).status, 200);
  await call('DELETE', `/v1/admin/staff/${made.body.userId}`);
});

test('action ticks: menu edit without price, cafe edit without open/pause, phones hidden, old section names converted', async () => {
  const email = `menu${n}@tb.test`;
  const made = await call('POST', '/v1/admin/admins', { name: 'Menu', email, password: 'password123',
    permissions: ['menu.edit', 'cafes.edit', 'orders.view', 'users.view', 'reports.view'] });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const m = H((await login(email, 'password123')).body.token);
  // own cafe + item, so other test files running at the same time can't change them under us
  const [loc] = await q<{ id: string }>(`select id from locations limit 1`);
  const cafeRes = await call('POST', '/v1/admin/cafes', { locationId: loc.id, name: 'Perm Test', slug: `perm-${n}`, isOpen: true });
  assert.equal(cafeRes.status, 201, JSON.stringify(cafeRes.body));
  const itemRes = await call('POST', '/v1/admin/menu-items', { cafeId: cafeRes.body.id, name: 'Tea', price: 20 });
  assert.equal(itemRes.status, 201, JSON.stringify(itemRes.body));
  const item = itemRes.body as { id: string; price: number; name: string };
  // forms send every field: unchanged price is fine, a changed one is not
  assert.equal((await call('PATCH', `/v1/admin/menu-items/${item.id}`, { name: item.name + ' ', price: item.price }, m)).status, 200);
  assert.equal((await call('PATCH', `/v1/admin/menu-items/${item.id}`, { price: item.price + 5 }, m)).status, 403);
  await call('PATCH', `/v1/admin/menu-items/${item.id}`, { name: item.name });
  assert.equal((await call('DELETE', `/v1/admin/menu-items/${item.id}`, undefined, m)).status, 403);
  assert.equal((await call('POST', '/v1/admin/categories', { cafeId: crypto.randomUUID(), name: 'x' }, m)).status, 403, 'no add');
  const cafe = { id: cafeRes.body.id as string, is_open: true, place: cafeRes.body.place as string };
  assert.equal((await call('PATCH', `/v1/admin/cafes/${cafe.id}`, { isOpen: !cafe.is_open }, m)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/cafes/${cafe.id}`, { isActive: false }, m)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/cafes/${cafe.id}`, { place: cafe.place, isOpen: cafe.is_open }, m)).status, 200);
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, { ...m, 'x-cafe-id': cafe.id })).status, 403, 'no live board');
  assert.equal((await call('GET', '/v1/admin/staff', undefined, m)).status, 403, 'no cafe logins');
  const orders = (await call('GET', '/v1/admin/orders?limit=5', undefined, m)).body;
  assert.ok(orders.every((o: any) => o.customerPhone === null), 'phones hidden');
  assert.equal((await call('GET', '/v1/admin/orders.csv', undefined, m)).status, 403);
  const users = (await call('GET', '/v1/admin/users', undefined, m)).body.rows;
  assert.ok(users.length > 0 && users.every((u: any) => u.phone === null));
  const st = (await call('GET', '/v1/admin/stats', undefined, m)).body;
  assert.equal(st.salesToday, null, 'money hidden');
  const csvRes = await app.inject({ method: 'GET', url: '/v1/admin/orders.csv', headers: admin });
  assert.equal(csvRes.statusCode, 200);
  assert.match(csvRes.headers['content-type'] as string, /text\/csv/);

  // an old whole-section permission becomes all of its actions
  await q(`update admins set permissions = '{menu,orders.view}' where id = $1`, [made.body.id]);
  const { readFileSync } = await import('node:fs');
  await q(readFileSync(new URL('../db/019_admin_actions.sql', import.meta.url), 'utf8'));
  const [row] = await q<{ permissions: string[] }>(`select permissions from admins where id = $1`, [made.body.id]);
  assert.ok(row.permissions.includes('menu.price') && row.permissions.includes('orders.view') && !row.permissions.includes('menu'));
  await q(`delete from admins where id = $1`, [made.body.id]);
  await q(`delete from menu_items where cafe_id = $1`, [cafe.id]);
  await q(`delete from cafes where id = $1`, [cafe.id]);
});
