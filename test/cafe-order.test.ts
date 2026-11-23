/** Admin sets the order of a building's cafes; the app list follows it (open cafes still first). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const admin = { authorization: 'Bearer dev:admin@towerbites.dev' };
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test('admin reorders cafes; public list follows; checks', async () => {
  const [loc] = await q<{ id: string; slug: string }>(`select l.id, l.slug from locations l join cafes c on c.location_id = l.id group by l.id order by count(*) desc limit 1`);
  const cafes = await q<{ id: string; name: string; open: boolean }>(
    `select id, name, (is_open and accepting_orders) as open from cafes where location_id = $1 order by sort, name`, [loc.id]);
  assert.ok(cafes.length >= 2, 'needs 2+ cafes in a building');
  const reversed = [...cafes].reverse().map((c) => c.id);

  assert.equal((await call('PUT', `/v1/admin/locations/${loc.id}/cafe-order`, { cafeIds: reversed }, {})).status, 401);
  assert.equal((await call('PUT', `/v1/admin/locations/${loc.id}/cafe-order`, { cafeIds: [reversed[0], reversed[0]] })).status, 400);
  assert.equal((await call('PUT', `/v1/admin/locations/${loc.id}/cafe-order`, { cafeIds: [crypto.randomUUID()] })).status, 400);
  const ok = await call('PUT', `/v1/admin/locations/${loc.id}/cafe-order`, { cafeIds: reversed });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const list = (await call('GET', `/v1/locations/${loc.slug}/cafes`, undefined, {})).body as { id: string; isOpen: boolean }[];
  const openIds = reversed.filter((id) => list.find((x) => x.id === id)?.isOpen);
  assert.deepEqual(list.filter((x) => x.isOpen).map((x) => x.id), openIds, 'open cafes in the set order');

  // put the original order back
  await call('PUT', `/v1/admin/locations/${loc.id}/cafe-order`, { cafeIds: cafes.map((c) => c.id) });
});

test('inactive cafe: hidden from customers, no orders, cannot be deleted, comes back when active', async () => {
  const [c] = await q<{ id: string; slug: string; loc: string }>(
    `select c.id, l.slug as loc, c.slug from cafes c join locations l on l.id = c.location_id where c.is_open and c.accepting_orders and c.is_active limit 1`);
  const [item] = await q<{ id: string }>(`select id from menu_items where cafe_id = $1 and is_available limit 1`, [c.id]);

  assert.equal((await call('DELETE', `/v1/admin/cafes/${c.id}`)).status, 400, 'delete is refused');
  assert.equal((await call('PATCH', `/v1/admin/cafes/${c.id}`, { isActive: false })).status, 200);
  try {
    const list = (await call('GET', `/v1/locations/${c.loc}/cafes`, undefined, {})).body as { id: string }[];
    assert.ok(!list.some((x) => x.id === c.id), 'not in the app list');
    assert.equal((await call('GET', `/v1/cafes/${c.id}`, undefined, {})).status, 404);
    assert.equal((await call('GET', `/v1/locations/${c.loc}/cafes/${c.slug}`, undefined, {})).status, 404);
    const order = await call('POST', '/v1/orders', {
      cafeId: c.id, items: [{ menuItemId: item.id, qty: 1 }], address: { tower: 'A', floor: '1', company: 'X', desk: '1' },
    }, { authorization: 'Bearer dev:+919800000111' });
    assert.equal(order.status, 409, JSON.stringify(order.body));
    const adminList = (await call('GET', '/v1/admin/cafes')).body as { id: string; isActive: boolean }[];
    assert.equal(adminList.find((x) => x.id === c.id)?.isActive, false, 'still in CRM, marked inactive');
  } finally {
    await call('PATCH', `/v1/admin/cafes/${c.id}`, { isActive: true });
  }
  assert.ok(((await call('GET', `/v1/locations/${c.loc}/cafes`, undefined, {})).body as { id: string }[]).some((x) => x.id === c.id));
});
