/** Regression tests for the fixes from the 2026-11-26 security review (see SECURITY.md). */
process.env.LIVE_RECHECK_MS = '300';
process.env.SUPABASE_JWT_SECRET = 'test-legacy-secret';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const { setOtpProvider } = await import('../src/lib/otp.js');
const app = await buildApp();
await app.ready();
const cleanup: string[] = [];
after(async () => {
  await q(`delete from admins where id = any($1::uuid[])`, [cleanup]);
  await app.close();
  await pool.end();
});

const n = Date.now();
const SUPER = { authorization: 'Bearer dev:admin@towerbites.dev' };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}, ip = '127.0.0.1') => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers, remoteAddress: ip } as any);
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const login = (email: string, password: string, ip = '127.0.0.1') => call('POST', '/v1/auth/staff/login', { email, password }, {}, ip);
const newAdmin = async (tag: string, permissions: string[]) => {
  const email = `${tag}${n}@sec.test`;
  const r = await call('POST', '/v1/admin/admins', { name: tag, email, password: 'password123', permissions }, SUPER);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.id as string, email };
};

test('H1: an admin cannot reset the password, email or access of an admin who has more access', async () => {
  const low = await newAdmin('low', ['admins.view', 'admins.edit', 'admins.delete', 'orders.view']);
  const high = await newAdmin('high', ['users.view', 'users.phone', 'orders.view']);
  const same = await newAdmin('same', ['orders.view']);
  cleanup.push(low.id, high.id, same.id);
  const t = H((await login(low.email, 'password123')).body.token);
  assert.equal((await call('POST', `/v1/admin/admins/${high.id}/password`, { password: 'takeover999' }, t)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/admins/${high.id}`, { email: `x${n}@sec.test` }, t)).status, 403);
  assert.equal((await call('PATCH', `/v1/admin/admins/${high.id}`, { isActive: false }, t)).status, 403);
  assert.equal((await login(high.email, 'takeover999')).status, 401, 'password unchanged');
  // an admin with less (or the same) access can still be managed
  assert.equal((await call('POST', `/v1/admin/admins/${same.id}/password`, { password: 'newpass1234' }, t)).status, 200);
});

test('M1: wrong passwords from one IP do not lock the real person out from another IP', async () => {
  const v = await newAdmin('victim', ['orders.view']);
  cleanup.push(v.id);
  for (let i = 0; i < 5; i++) assert.equal((await login(v.email, 'wrong-pass', '10.1.1.1')).status, 401);
  assert.equal((await login(v.email, 'wrong-pass', '10.1.1.1')).status, 429, 'attacker IP is locked');
  assert.equal((await login(v.email, 'password123', '10.2.2.2')).status, 200, 'real person still logs in');
});

test('M3: admin logins are short; an admin login older than 7 days ends even if used', async () => {
  const a = await newAdmin('sess', ['orders.view']);
  cleanup.push(a.id);
  const s = await login(a.email, 'password123');
  const hours = (Date.parse(s.body.expiresAt) - Date.now()) / 3600_000;
  assert.ok(hours > 11 && hours < 13, `admin session ~12h, got ${hours}`);
  assert.equal((await call('GET', '/v1/admin/orders?limit=1', undefined, H(s.body.token))).status, 200);
  const [row] = await q<{ kind: string }>(`select kind from sessions where user_id = $1`, [a.id]);
  assert.equal(row.kind, 'admin');
  // pretend it was made 8 days ago and kept alive: the next check ends it (after the 1-minute cache)
  const s2 = await login(a.email, 'password123');
  await q(`update sessions set created_at = now() - interval '8 days' where user_id = $1`, [a.id]);
  const r = await call('GET', '/v1/admin/orders?limit=1', undefined, H(s2.body.token));
  assert.equal(r.status, 401);
});

test('M2: old Supabase tokens: bad ones get 401 (not 500), email-only ones are refused, phone ones still work', async () => {
  const jwt = (claims: Record<string, unknown>) => {
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b({ alg: 'HS256', typ: 'JWT' });
    const body = b({ aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600, ...claims });
    return `${head}.${body}.${createHmac('sha256', 'test-legacy-secret').update(`${head}.${body}`).digest('base64url')}`;
  };
  assert.equal((await call('GET', '/v1/me', undefined, H('eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.x'))).status, 401);
  assert.equal((await call('GET', '/v1/me', undefined, H(jwt({ sub: crypto.randomUUID(), email: `self${n}@x.test` })))).status, 401);
  assert.equal((await call('GET', '/v1/me', undefined, H(jwt({ sub: crypto.randomUUID(), phone: '919812300001' })))).status, 200);
  process.env.LEGACY_SUPABASE_TOKENS = 'false';
  assert.equal((await call('GET', '/v1/me', undefined, H(jwt({ sub: crypto.randomUUID(), phone: '919812300001' })))).status, 401, 'switch turns it off');
  delete process.env.LEGACY_SUPABASE_TOKENS;
});

test('M4 + L7: SMS daily caps; wrong codes from one IP do not lock the number for others', async () => {
  let sent = 0;
  setOtpProvider({ async send() { sent++; }, async verify() { throw new Error('wrong'); } });
  const phone = `+9198${String(n).slice(-8)}`;
  await q(`insert into sms_sends (phone) select $1 from generate_series(1, 10)`, [phone]);
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone }, {}, '10.3.3.3')).status, 429, '10 a day per number');
  process.env.OTP_DAILY_LIMIT = '1';
  const other = `+9197${String(n).slice(-8)}`;
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone: other }, {}, '10.3.3.4')).status, 429, 'global daily cap');
  delete process.env.OTP_DAILY_LIMIT;
  assert.equal(sent, 0);
  const third = `+9196${String(n).slice(-8)}`;
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone: third }, {}, '10.3.3.5')).status, 200);
  assert.equal(sent, 1);
  const [{ c }] = await q<{ c: number }>(`select count(*)::int as c from sms_sends where phone = $1`, [third]);
  assert.equal(c, 1, 'each SMS is recorded');
  for (let i = 0; i < 5; i++) await call('POST', '/v1/auth/otp/verify', { phone: third, code: '000000' }, {}, '10.4.4.4');
  assert.equal((await call('POST', '/v1/auth/otp/verify', { phone: third, code: '000000' }, {}, '10.4.4.4')).status, 429);
  assert.equal((await call('POST', '/v1/auth/otp/verify', { phone: third, code: '000000' }, {}, '10.5.5.5')).status, 401, 'other IP not locked');
  await q(`delete from sms_sends where phone = any($1)`, [[phone, other, third]]);
});

test('M5: the Live board tick alone cannot change stock or combos from the cafe panel', async () => {
  const b = await newAdmin('board', ['cafes.view', 'cafes.board']);
  cleanup.push(b.id);
  const t = H((await login(b.email, 'password123')).body.token);
  const [it] = await q<{ id: string; cafe_id: string; is_available: boolean }>(`select id, cafe_id, is_available from menu_items limit 1`);
  const hdr = { ...t, 'x-cafe-id': it.cafe_id };
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, hdr)).status, 200, 'board works');
  assert.equal((await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isAvailable: it.is_available }, hdr)).status, 403);
  assert.equal((await call('POST', '/v1/cafe/combos', {}, hdr)).status, 403);
  // a real cafe login still can
  const cafeUser = { authorization: 'Bearer dev:cafe@towerbites.dev' };
  const [own] = await q<{ id: string; is_available: boolean }>(
    `select i.id, i.is_available from menu_items i join staff s on s.cafe_id = i.cafe_id where s.email = 'cafe@towerbites.dev' limit 1`);
  if (own) assert.equal((await call('PATCH', `/v1/cafe/menu-items/${own.id}`, { isAvailable: own.is_available }, cafeUser)).status, 200);
});

test('M6: a deletion request is "verified" only when sent by someone logged in with that number', async () => {
  const num = `98${String(n).slice(-8)}`;
  await call('POST', '/v1/account/requests', { phone: num }, {}, '10.6.6.6');
  await call('POST', '/v1/account/requests', { phone: num }, { authorization: `Bearer dev:+91${num}` }, '10.6.6.7');
  const rows = await q<{ verified: boolean }>(`select verified from account_requests where phone = $1 order by created_at`, [`+91${num}`]);
  assert.deepEqual(rows.map((r) => r.verified), [false, true]);
  await q(`delete from account_requests where phone = $1`, [`+91${num}`]);
});

test('L1: only real Expo push tokens, at most 10 per person', async () => {
  const u = { authorization: `Bearer dev:+9198700${String(n).slice(-5)}` };
  await call('GET', '/v1/me', undefined, u);
  assert.equal((await call('POST', '/v1/me/push-token', { token: 'garbage-token-123456' }, u)).status, 400);
  for (let i = 0; i < 12; i++) {
    assert.equal((await call('POST', '/v1/me/push-token', { token: `ExponentPushToken[sec${n}x${i}]` }, u)).status, 200);
  }
  const [{ c }] = await q<{ c: number }>(`select count(*)::int as c from push_tokens where token like $1`, [`ExponentPushToken[sec${n}x%`]);
  assert.equal(c, 10);
  await q(`delete from push_tokens where token like $1`, [`ExponentPushToken[sec${n}x%`]);
});

test('L5: admins cannot set a cafe rating by hand', async () => {
  const [c] = await q<{ id: string; rating: number }>(`select id, rating::float as rating from cafes limit 1`);
  assert.equal((await call('PATCH', `/v1/admin/cafes/${c.id}`, { rating: 5, ratingCount: 9999 }, SUPER)).status, 200);
  const [after1] = await q<{ rating: number; rating_count: number }>(`select rating::float as rating, rating_count from cafes where id = $1`, [c.id]);
  assert.equal(after1.rating, c.rating);
  assert.notEqual(after1.rating_count, 9999);
});

test('L2: a live socket is closed after its login ends', async () => {
  const a = await newAdmin('live', ['cafes.view', 'cafes.board']);
  cleanup.push(a.id);
  const s = await login(a.email, 'password123');
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(`${addr.replace('http', 'ws')}/v1/live`);
  const closed = new Promise<number>((r) => (ws.onclose = (e) => r(e.code)));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ type: 'auth', token: s.body.token }));
  await new Promise((r) => setTimeout(r, 100));
  await call('DELETE', '/v1/auth/session', undefined, H(s.body.token));
  assert.equal(await Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 2000))]), 4001);
});

test('H2: in production a guessable test code or an open test period is switched off', () => {
  const run = (extra: Record<string, string>) => JSON.parse(execFileSync('npx', ['tsx', '-e',
    `import('./src/env.ts').then(({ env }) => console.log(JSON.stringify(env.testLogin)))`], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: 'production', DEV_AUTH: '', TEST_LOGIN_ALL_UNTIL: '', ...extra },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim().split('\n').pop()!);
  const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  assert.deepEqual(run({ TEST_LOGIN_NUMBERS: '9876500099', TEST_LOGIN_OTP: '123456' }).numbers, []);
  assert.deepEqual(run({ TEST_LOGIN_NUMBERS: '9876500099', TEST_LOGIN_OTP: '583920' }).numbers, ['+919876500099']);
  assert.equal(run({ TEST_LOGIN_ALL_UNTIL: soon, TEST_LOGIN_OTP: '583920' }).allUntil, null);
});

test('cafe hides a product: gone for customers (menu, search, popular, orders), still in the cafe panel; star and stock work', async () => {
  const cafeUser = { authorization: 'Bearer dev:cafe@towerbites.dev' };
  const [it] = await q<{ id: string; name: string; cafe_id: string; slug: string; loc: string; is_popular: boolean }>(
    `select i.id, i.name, i.cafe_id, c.slug, l.slug as loc, i.is_popular from menu_items i join cafes c on c.id = i.cafe_id
     join locations l on l.id = c.location_id join staff s on s.cafe_id = c.id where s.email = 'cafe@towerbites.dev' and i.is_available limit 1`);
  assert.ok(it, 'needs the seeded Krunchy Kafe');
  const hide = await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isActive: false, isPopular: true }, cafeUser);
  assert.equal(hide.status, 200, JSON.stringify(hide.body));
  assert.deepEqual([hide.body.isActive, hide.body.isPopular], [false, true]);
  try {
    const menu = (await call('GET', `/v1/locations/${it.loc}/cafes/${it.slug}`)).body;
    assert.ok(!menu.items.some((x: any) => x.id === it.id), 'not on the customer menu');
    const search = (await call('GET', `/v1/locations/${it.loc}/search?q=${encodeURIComponent(it.name.slice(0, 5))}`)).body;
    assert.ok(!search.dishes.some((x: any) => x.id === it.id), 'not in search');
    const popular = (await call('GET', `/v1/locations/${it.loc}/popular`)).body;
    assert.ok(!popular.some((x: any) => x.id === it.id), 'not in popular');
    const panel = (await call('GET', '/v1/cafe/menu', undefined, cafeUser)).body;
    assert.equal(panel.items.find((x: any) => x.id === it.id)?.isActive, false, 'cafe still sees it, marked hidden');
    const order = await call('POST', '/v1/orders', {
      cafeId: it.cafe_id, items: [{ menuItemId: it.id, qty: 1 }], address: { tower: 'A', floor: '1', desk: '1' },
    }, { authorization: `Bearer dev:+9198111${String(n).slice(-5)}` });
    assert.equal(order.status, 400, 'cannot be ordered');
  } finally {
    await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isActive: true, isPopular: it.is_popular }, cafeUser);
  }
  const menuBack = (await call('GET', `/v1/locations/${it.loc}/cafes/${it.slug}`)).body;
  assert.ok(menuBack.items.some((x: any) => x.id === it.id), 'shown again');
  assert.equal((await call('PATCH', `/v1/cafe/menu-items/${it.id}`, {}, cafeUser)).status, 400, 'nothing to change');
  // an admin in the cafe panel with only the board + sold-out ticks can't hide or star
  const a = await newAdmin('hider', ['cafes.view', 'cafes.board', 'menu.soldout']);
  cleanup.push(a.id);
  const hdr = { ...H((await login(a.email, 'password123')).body.token), 'x-cafe-id': it.cafe_id };
  assert.equal((await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isActive: false }, hdr)).status, 403);
  assert.equal((await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isPopular: true }, hdr)).status, 403);
  assert.equal((await call('PATCH', `/v1/cafe/menu-items/${it.id}`, { isAvailable: true }, hdr)).status, 200);
});
