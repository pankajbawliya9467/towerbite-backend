/** Orders only from inside the building when a cafe's location check is on. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const { distanceM } = await import('../src/lib/geo.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const admin = { authorization: 'Bearer dev:admin@towerbites.dev' };
const n = String(Date.now()).slice(-6);
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const PIN = { lat: 28.4241, lng: 77.0415 };
const address = { tower: 'B', floor: '7', company: 'X', desk: '7B' };

test('distance helper', () => {
  assert.ok(Math.abs(distanceM(28.4241, 77.0415, 28.4241, 77.0415)) < 1);
  const d = distanceM(28.4241, 77.0415, 28.4331, 77.0415); // ~1 km north
  assert.ok(d > 990 && d < 1010, String(d));
});

test('location check: off by default, then only inside the radius', async () => {
  const [c] = await q<{ id: string }>(`select id from cafes where is_open and accepting_orders and is_active limit 1`);
  const [item] = await q<{ id: string }>(`select id from menu_items where cafe_id = $1 and is_available limit 1`, [c.id]);
  let k = 0;
  const order = (geo?: unknown) => call('POST', '/v1/orders', { cafeId: c.id, items: [{ menuItemId: item.id, qty: 1 }], address, geo },
    { authorization: `Bearer dev:+9199${n}${String(k++).padStart(2, '0')}` });

  assert.equal((await order()).status, 201, 'check off: old apps without location still order');

  const on = await call('PATCH', `/v1/admin/cafes/${c.id}`, { ...PIN, geoRadiusM: 300, geoCheck: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.geoCheck, true);
  try {
    const none = await order();
    assert.equal(none.status, 409);
    assert.match(none.body.error, /update the TowerBites app and allow location/);
    const far = await order({ lat: 28.4541, lng: 77.0415, accuracy: 20 }); // ~3.3 km
    assert.equal(far.status, 409);
    assert.match(far.body.error, /3\.3 km/);
    assert.equal((await order({ lat: 28.4541, lng: 77.0415, accuracy: 50_000 })).status, 409, 'huge accuracy does not help');
    assert.equal((await order({ ...PIN, accuracy: 10, mocked: true })).status, 409, 'fake GPS refused');
    assert.equal((await order({ lat: 28.4259, lng: 77.0415, accuracy: 30 })).status, 201, '~200 m away: inside');
    assert.equal((await order({ lat: 28.4271, lng: 77.0415, accuracy: 80 })).status, 201, '~330 m with 80 m accuracy: allowed');
    const menu = await call('GET', `/v1/cafes/${c.id}`, undefined, {});
    assert.equal(menu.body.geoCheck, true);
    const locs = (await call('GET', '/v1/locations', undefined, {})).body as { lat: number | null }[];
    assert.ok(locs.some((l) => l.lat != null));
  } finally {
    await call('PATCH', `/v1/admin/cafes/${c.id}`, { geoCheck: false, lat: null, lng: null });
  }
});
