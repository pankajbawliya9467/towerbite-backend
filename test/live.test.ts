/**
 * Full admin → employee → cafe flow, checking the live pings and push notifications that go out,
 * plus the security fixes. Needs DEV_AUTH=true and a seeded database (npm run db:seed). Run: npm test
 */
process.env.SUPABASE_URL = 'http://realtime.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

import { test, after, beforeEach } from 'node:test';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

// A signing key standing in for the Supabase project's ES256 key (served as its JWKS below).
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'ES256', use: 'sig' };
let jwksFetches = 0;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
function makeToken(claims: Record<string, unknown>, key = privateKey, kid = 'test-kid') {
  const head = b64u(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
  const body = b64u(JSON.stringify({ aud: 'authenticated', role: 'authenticated', iss: 'http://realtime.test/auth/v1', exp: Math.floor(Date.now() / 1000) + 3600, ...claims }));
  const sig = cryptoSign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64u(sig)}`;
}
import assert from 'node:assert/strict';

// Capture outgoing Supabase broadcasts and Expo pushes instead of sending them.
type Sent = { url: string; body: any };
let sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  if (String(url).includes('/.well-known/jwks.json')) {
    jwksFetches++;
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  }
  if (String(url).includes('/auth/v1/user')) return new Response('{"msg":"should not be called"}', { status: 500 });
  if (String(url).includes('/auth/v1/admin/users')) {
    const { devUserId } = await import('../src/lib/devId.js');
    const email = JSON.parse(init.body).email;
    return new Response(JSON.stringify({ id: devUserId(email), email }), { status: 200 });
  }
  if (String(url).includes('exp.host'))
    return new Response(JSON.stringify({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }), { status: 200 });
  return new Response('{}', { status: 202 });
}) as typeof fetch;

const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const app = await buildApp();
after(async () => { globalThis.fetch = realFetch; await app.close(); await pool.end(); });
beforeEach(() => { sent = []; });

const H = (t: string) => ({ authorization: `Bearer dev:${t}` });
const admin = H('admin@towerbites.dev');
const call = async (method: string, url: string, headers: Record<string, string> = {}, payload?: unknown) => {
  const res = await app.inject({ method: method as any, url, headers, payload: payload as any });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};
const topics = () => sent.filter((s) => s.url.includes('/realtime/')).flatMap((s) => s.body.messages.map((m: any) => `${m.topic}#${m.event}#${m.private}`));
const pushes = () => sent.filter((s) => s.url.includes('exp.host')).flatMap((s) => s.body);
const settle = () => new Promise((r) => setTimeout(r, 50));

test('admin builds a location → cafe → product, employee orders, cafe moves it, everyone is told live', async () => {
  const n = Date.now();
  // Admin: location, tower, cafe, category, product, cafe login
  const loc = await call('POST', '/v1/admin/locations', admin, { slug: `loc-${n}`, name: `Test Park ${n}`, city: 'Gurugram' });
  assert.equal(loc.status, 201, JSON.stringify(loc.body));
  assert.ok(topics().includes(`location:${loc.body.id}#cafes#true`));
  assert.equal((await call('POST', '/v1/admin/towers', admin, { locationId: loc.body.id, name: 'Tower A' })).status, 201);
  const cafe = await call('POST', '/v1/admin/cafes', admin, { locationId: loc.body.id, slug: 'brew', name: 'Brew Bar', etaMin: 10, etaMax: 20 });
  assert.equal(cafe.status, 201, JSON.stringify(cafe.body));
  const cat = await call('POST', '/v1/admin/categories', admin, { cafeId: cafe.body.id, name: 'Coffee' });
  const item = await call('POST', '/v1/admin/menu-items', admin, { cafeId: cafe.body.id, categoryId: cat.body.id, name: 'Latte', price: 120 });
  assert.equal(item.status, 201);
  const staffEmail = `brew-${n}@towerbites.dev`;
  assert.equal((await call('POST', '/v1/admin/staff', admin, { name: 'Brew counter', email: staffEmail, password: 'password123', cafeId: cafe.body.id })).status, 201);
  const cafeStaff = H(staffEmail);

  // Visible on the public pages
  const list = await call('GET', `/v1/locations/loc-${n}/cafes`);
  assert.equal(list.body[0].name, 'Brew Bar');

  // Cafe closes → location told → order refused; opens again
  sent = [];
  assert.equal((await call('PATCH', '/v1/cafe', cafeStaff, { isOpen: false })).body.isOpen, false);
  assert.ok(topics().includes(`location:${loc.body.id}#cafes#true`));
  const emp = H(`+9197${String(n).slice(-8)}`);
  const order = (body = {}) => call('POST', '/v1/orders', emp, {
    cafeId: cafe.body.id, items: [{ menuItemId: item.body.id, qty: 2 }],
    address: { tower: 'Tower A', floor: '3', company: 'SolutionBowl', desk: '3A-1' }, ...body,
  });
  assert.equal((await order()).status, 409);
  await call('PATCH', '/v1/cafe', cafeStaff, { isOpen: true });

  // Employee registers a phone for push, then orders. Price comes from the server.
  await call('GET', '/v1/me', emp);
  assert.equal((await call('POST', '/v1/me/push-token', emp, { token: `ExponentPushToken[test-${n}]`, platform: 'android' })).status, 200);
  sent = [];
  const placed = await order({ items: [{ menuItemId: item.body.id, qty: 2, price: 1 }] });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  assert.equal(placed.body.total, 240);
  const id = placed.body.id;
  const me = (await call('GET', '/v1/me', emp)).body.id;
  assert.deepEqual(topics().sort(), [`cafe:${cafe.body.id}#order#true`, `order:${id}#status#true`, `user:${me}#order#true`].sort());

  // Cafe board sees it; moves it through every step; employee gets a push each time
  assert.ok((await call('GET', '/v1/cafe/orders', cafeStaff)).body.some((o: any) => o.id === id));
  for (const [action, status, title] of [
    ['accept', 'preparing', 'Brew Bar accepted your order'],
    ['dispatch', 'out_for_delivery', 'Your order is on the way'],
    ['deliver', 'delivered', 'Delivered'],
  ]) {
    sent = [];
    const r = await call('POST', `/v1/cafe/orders/${id}/${action}`, cafeStaff, { riderName: 'Raju' });
    assert.equal(r.body.status, status);
    await settle();
    assert.ok(topics().includes(`order:${id}#status#true`), action);
    assert.ok(topics().includes(`user:${me}#order#true`), action);
    const p = pushes();
    if (action === 'accept') {
      assert.equal(p.length, 1);
      assert.equal(p[0].title, title);
      assert.equal(p[0].channelId, 'orders');
      assert.equal(p[0].data.orderId, id);
    }
  }
  // Expo said the token was dead (DeviceNotRegistered), so it was removed after the first push
  const left = await pool.query(`select 1 from push_tokens where token = $1`, [`ExponentPushToken[test-${n}]`]);
  assert.equal(left.rowCount, 0);

  // Another cafe can't touch this cafe's order; employee sees it as delivered
  assert.equal((await call('POST', `/v1/cafe/orders/${id}/accept`, H('cafe@towerbites.dev'))).status, 409);
  assert.equal((await call('GET', `/v1/orders/${id}`, emp)).body.status, 'delivered');

  // Clean up the test location
  await pool.query(`delete from orders where cafe_id = $1`, [cafe.body.id]);
  await pool.query(`delete from staff where cafe_id = $1`, [cafe.body.id]);
  assert.equal((await call('DELETE', `/v1/admin/locations/${loc.body.id}`, admin)).status, 200);
});

test('security fixes', async () => {
  const cafe = (await call('GET', '/v1/locations/spaze-tech-park/cafes/tapri-chai')).body;
  const body = {
    cafeId: cafe.id, items: [{ menuItemId: cafe.items[0].id, qty: 1 }],
    address: { tower: 'Tower C', floor: '2', company: '', desk: '2C-1' },
  };

  // Email-only accounts (e.g. cafe staff or self sign-ups) and foreign numbers can't order
  assert.equal((await call('POST', '/v1/orders', H('someone@gmail.com'), body)).status, 403);
  assert.equal((await call('POST', '/v1/orders', H('+15551234567'), body)).status, 403);

  // Parallel requests can't skip the 3-active-orders cap
  const user = H(`+9196${Date.now().toString().slice(-8)}`);
  const results = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/v1/orders', user, body)));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 409).length, 3);

  // Spaces around the token don't give a fresh limit (limit is counted per user in the database)
  const ids = (await call('GET', '/v1/orders?status=active', user)).body.map((o: any) => o.id);
  for (const id of ids) await call('POST', `/v1/orders/${id}/cancel`, user);
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const h = { authorization: `Bearer dev:${user.authorization.slice(11)}${' '.repeat(i)}` };
    const r = await call('POST', '/v1/orders', h, body);
    last = r.status;
    if (r.status === 201) await call('POST', `/v1/orders/${r.body.id}/cancel`, user);
  }
  assert.equal(last, 429);

  // Push token removed on sign out, only by its owner
  const tok = `ExponentPushToken[logout-${Date.now()}]`;
  await call('POST', '/v1/me/push-token', user, { token: tok });
  await call('DELETE', '/v1/me/push-token', H('+919000000001'), { token: tok });
  assert.equal((await pool.query(`select 1 from push_tokens where token = $1`, [tok])).rowCount, 1);
  await call('DELETE', '/v1/me/push-token', user, { token: tok });
  assert.equal((await pool.query(`select 1 from push_tokens where token = $1`, [tok])).rowCount, 0);

  // Admin-only and cafe-only routes
  assert.equal((await call('GET', '/v1/admin/users', user)).status, 403);
  assert.equal((await call('GET', '/v1/admin/users', H('cafe@towerbites.dev'))).status, 403);
  assert.equal((await call('GET', '/v1/cafe/orders', user)).status, 403);
  assert.equal((await call('GET', '/v1/cafe/orders', { ...admin, 'x-cafe-id': 'nope' })).status, 403);
  assert.equal((await call('GET', '/v1/me')).status, 401);

  // ETA min can't be above max
  const bad = await call('PATCH', `/v1/admin/cafes/${cafe.id}`, admin, { etaMin: 50, etaMax: 10 });
  assert.equal(bad.status, 400);

  // A faked X-Forwarded-For is not trusted beyond the one proxy hop
  const ip = await app.inject({ method: 'GET', url: '/v1/health', headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } });
  assert.equal(ip.headers['x-ratelimit-limit'], '300');
});

test('Supabase tokens are verified inside the API (no network call per request)', async () => {
  const uid = '0b9f1c7e-1111-4222-8333-944455556666';
  const good = makeToken({ sub: uid, phone: '919811112222' });
  for (let i = 0; i < 3; i++) {
    const r = await call('GET', '/v1/me', { authorization: `Bearer ${good}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.phone, '+919811112222');
  }
  assert.equal(jwksFetches, 1, 'keys fetched once and cached');
  assert.equal(sent.filter((s) => s.url.includes('/auth/v1/user')).length, 0, 'no per-request call to Supabase');

  // Forged, expired, wrong-audience tokens are refused
  const { privateKey: otherKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.equal((await call('GET', '/v1/me', { authorization: `Bearer ${makeToken({ sub: uid }, otherKey)}` })).status, 401);
  assert.equal((await call('GET', '/v1/me', { authorization: `Bearer ${makeToken({ sub: uid, exp: 1000 })}` })).status, 401);
  assert.equal((await call('GET', '/v1/me', { authorization: `Bearer ${makeToken({ sub: uid, aud: 'anon' })}` })).status, 401);
  assert.equal((await call('GET', '/v1/me', { authorization: `Bearer ${good.slice(0, -4)}AAAA` })).status, 401);
  await pool.query(`delete from profiles where id = $1`, [uid]);
});

test('search finds dishes with their cafe, and cafes', async () => {
  const r = await call('GET', '/v1/locations/spaze-tech-park/search?q=chai');
  assert.equal(r.status, 200);
  assert.ok(r.body.dishes.length > 0);
  assert.ok(r.body.dishes.every((d: any) => /chai/i.test(d.name + d.description) && d.cafe?.name));
  assert.ok(r.body.cafes.some((c: any) => /chai/i.test(c.name + c.cuisines)));
  const veg = await call('GET', '/v1/locations/spaze-tech-park/search?q=a&veg=true&maxPrice=50');
  assert.deepEqual(veg.body, { dishes: [], cafes: [] }); // under 2 characters
  const cheap = await call('GET', '/v1/locations/spaze-tech-park/search?q=chai&maxPrice=30&veg=true');
  assert.ok(cheap.body.dishes.every((d: any) => d.price <= 30 && d.isVeg));
  assert.equal((await call('GET', `/v1/locations/spaze-tech-park/search?q=${encodeURIComponent("%_'")}`)).status, 200);
});

test('cafe reports: numbers, comparison and CSV downloads', async () => {
  const cafeStaff = H('cafe@towerbites.dev');
  const cafe = (await call('GET', '/v1/cafe', cafeStaff)).body;
  const emp = H(`+9193${String(Date.now()).slice(-8)}`);
  await call('PUT', '/v1/me', emp, { name: 'Report Tester' });
  const placed = await call('POST', '/v1/orders', emp, {
    cafeId: cafe.id, items: [{ menuItemId: cafe.items[0].id, qty: 3 }],
    address: { tower: 'Tower A', floor: '2', company: '=Evil Corp', desk: 'A-1' },
  });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  for (const a of ['accept', 'dispatch', 'deliver']) await call('POST', `/v1/cafe/orders/${placed.body.id}/${a}`, cafeStaff, {});

  const r = await call('GET', '/v1/cafe/reports', cafeStaff);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.byDay.length, 7);
  assert.equal(r.body.byHour.length, 24);
  assert.ok(r.body.totals.sales >= placed.body.total);
  assert.ok(r.body.topItems.some((i: any) => i.name === cafe.items[0].name && i.qty >= 3));
  assert.ok(r.body.companies.some((c: any) => c.name === '=Evil Corp'));
  assert.equal(r.body.totals.avgOrder, Math.round(r.body.totals.sales / r.body.totals.delivered));

  const one = await call('GET', '/v1/cafe/reports?from=2026-01-05&to=2026-01-05', cafeStaff);
  assert.equal(one.body.byDay.length, 1);
  assert.equal(one.body.range.prevFrom, '2026-01-04');
  assert.equal((await call('GET', '/v1/cafe/reports?from=2026-02-01&to=2026-01-01', cafeStaff)).status, 400);
  assert.equal((await call('GET', '/v1/cafe/reports', emp)).status, 403);

  const res = await app.inject({ method: 'GET', url: '/v1/cafe/reports/orders.csv', headers: cafeStaff });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-type']), /text\/csv/);
  assert.match(res.body, /Order no,Placed \(IST\)/);
  assert.ok(res.body.includes(`'=Evil Corp`), 'formula in a cell is neutralised');
  const items = await app.inject({ method: 'GET', url: '/v1/cafe/reports/items.csv', headers: cafeStaff });
  assert.match(items.body, /Item,Quantity sold/);
});
