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
