/** AI notification ideas: settings, generate (OpenAI + weather faked), checks, send caps, taps and results. */
process.env.QUIET_HOURS = 'off';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

let aiReply: unknown = null;
let aiRequests: any[] = [];
let pushes: any[] = [];
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('api.openai.com/v1/models')) {
    const ok = String(init?.headers?.Authorization ?? '').endsWith('GOODKEY1234');
    return new Response('{}', { status: ok ? 200 : 401 });
  }
  if (u.includes('api.openai.com/v1/chat/completions')) {
    aiRequests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiReply) } }] }), { status: 200 });
  }
  if (u.includes('open-meteo.com')) {
    return new Response(JSON.stringify({ current: { temperature_2m: 24.2, apparent_temperature: 26, precipitation: 0.4, weather_code: 61 } }), { status: 200 });
  }
  if (u.includes('exp.host')) {
    const msgs = JSON.parse(init.body);
    pushes.push(...msgs);
    return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok' })) }), { status: 200 });
  }
  return new Response('{}', { status: 202 });
}) as typeof fetch;

const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const app = await buildApp();
await app.ready();

const n = Date.now();
const SUPER = { authorization: 'Bearer dev:admin@towerbites.dev' };
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = SUPER) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const cleanup: string[] = [];
after(async () => {
  await q(`delete from admins where id = any($1::uuid[])`, [cleanup]);
  await q(`delete from app_settings where key in ('openai_key','ai_model','ai_style','ai_daily_limit')`);
  await q(`delete from ai_generations where created_at > now() - interval '10 minutes'`); // test runs only
  await app.close();
  await pool.end();
});

const [loc] = await q<{ id: string }>(
  `select l.id from locations l join cafes c on c.location_id = l.id where c.is_active and c.is_open and c.accepting_orders
   group by l.id order by count(*) desc limit 1`);
const [item] = await q<{ id: string; name: string; price: number; cafe_id: string }>(
  `select i.id, i.name, i.price, i.cafe_id from menu_items i join cafes c on c.id = i.cafe_id
   where c.location_id = $1 and c.is_active and c.is_open and c.accepting_orders and i.is_available and i.is_active
   order by i.price desc limit 1`, [loc.id]);
const audience = { type: 'location', locationId: loc.id };

// Two customers in that building with the app.
const phones = [`+9199${String(n).slice(-8)}`, `+9198${String(n).slice(-8)}`];
for (const [i, p] of phones.entries()) {
  const h = H(`dev:${p}`);
  await call('GET', '/v1/me', undefined, h);
  await call('PUT', '/v1/me', { name: `Tester ${i}`, locationId: loc.id }, h);
  await call('POST', '/v1/me/push-token', { token: `ExponentPushToken[ai${n}x${i}]` }, h);
}

test('AI settings: only super admins set the key; it is checked, stored encrypted and never shown', async () => {
  const email = `notif${n}@ai.test`;
  const made = await call('POST', '/v1/admin/admins', { name: 'N', email, password: 'password123', permissions: ['notifications.send'] });
  cleanup.push(made.body.id);
  const t = H((await call('POST', '/v1/auth/staff/login', { email, password: 'password123' }, {})).body.token);
  assert.equal((await call('GET', '/v1/admin/settings/ai', undefined, t)).status, 200, 'senders can see the status');
  assert.equal((await call('PUT', '/v1/admin/settings/ai', { apiKey: 'sk-test-GOODKEY1234' }, t)).status, 403, 'only super admins change it');
  assert.equal((await call('PUT', '/v1/admin/settings/ai', { apiKey: 'sk-test-BADKEY000000000' })).status, 400, 'a wrong key is refused');
  const ok = await call('PUT', '/v1/admin/settings/ai', { apiKey: 'sk-test-abcdefghijGOODKEY1234', style: 'fun_hinglish' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.configured, true);
  assert.equal(ok.body.keyEnding, '1234');
  assert.ok(!JSON.stringify(ok.body).includes('GOODKEY'), 'the key never comes back');
  const [row] = await q<{ value: string }>(`select value from app_settings where key = 'openai_key'`);
  assert.match(row.value, /^v1:/);
  assert.ok(!row.value.includes('GOODKEY'), 'stored encrypted');
});

test('Generate: sends the situation (no customer data), checks every idea against the real menu', async () => {
  aiReply = {
    ideas: [
      { angle: 'weather', title: 'Baarish + garma garam ☔', body: `${item.name} sirf ₹${item.price}. 15 min mein desk par!`, target: { type: 'item', id: item.id } },
      { angle: 'time', title: '4 baje ki neend? 😴', body: `${item.name} ab sirf ₹${item.price + 7}!`, target: { type: 'item', id: item.id } },
      { angle: 'activity', title: 'Mega sale 🎉', body: 'Aaj sab kuch 50% off!', target: { type: 'none', id: '' } },
    ],
  };
  aiRequests = [];
  const g = await call('POST', '/v1/admin/notifications/generate', { audience, note: 'Monsoon' });
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.ideas.length, 3);
  const [good, ...bad] = g.body.ideas;
  assert.equal(good.ok, true, JSON.stringify(good.checks));
  assert.match(good.opens, new RegExp(item.name));
  assert.ok(bad.every((i: any) => !i.ok), 'fake price and fake offer are flagged');
  assert.ok(bad.some((i: any) => i.checks.some((c: any) => /not a real price/.test(c.label))));
  assert.ok(bad.some((i: any) => i.checks.some((c: any) => /offer/.test(c.label))));
  assert.match(g.body.seen.weather, /rain/);
  const sentToAi = JSON.stringify(aiRequests[0]);
  assert.ok(!phones.some((p) => sentToAi.includes(p.slice(3))), 'no phone numbers go to OpenAI');
  assert.ok(!sentToAi.includes('Tester'), 'no customer names go to OpenAI');
  const data = JSON.parse(aiRequests[0].messages[1].content.split('DATA:\n')[1].split('\n\nADMIN NOTE')[0]);
  assert.ok(data.items.length > 0 && data.items.length <= 40 && data.items.every((i: any) => i.id && i.price >= 0), 'the real menu (top 40) is in the data');
  assert.match(data.weather, /rain/);
});

test('Generate respects the daily limit and needs the Send tick', async () => {
  const email = `viewer${n}@ai.test`;
  const made = await call('POST', '/v1/admin/admins', { name: 'V', email, password: 'password123', permissions: ['notifications.view'] });
  cleanup.push(made.body.id);
  const t = H((await call('POST', '/v1/auth/staff/login', { email, password: 'password123' }, {})).body.token);
  assert.equal((await call('POST', '/v1/admin/notifications/generate', { audience }, t)).status, 403);
  await call('PUT', '/v1/admin/settings/ai', { dailyLimit: 1 });
  assert.equal((await call('POST', '/v1/admin/notifications/generate', { audience })).status, 429);
  await call('PUT', '/v1/admin/settings/ai', { dailyLimit: 30 });
});

test('Send: opens the item, one promo a day per person, quiet hours, taps and orders counted', async () => {
  const before = await call('POST', '/v1/admin/notifications/preview', { audience });
  assert.equal(before.status, 200);
  pushes = [];
  const sent = await call('POST', '/v1/admin/notifications', {
    title: 'Baarish + garma garam ☔', body: `${item.name} sirf ₹${item.price}`, audience, source: 'ai', angle: 'weather',
    target: { type: 'item', id: item.id },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const mine = pushes.find((p) => p.to === `ExponentPushToken[ai${n}x0]`);
  assert.ok(mine, 'our tester got it');
  assert.equal(mine.data.notificationId, sent.body.id);
  assert.deepEqual([mine.data.target.type, mine.data.target.id, mine.data.target.cafeId], ['item', item.id, item.cafe_id]);

  // same day again: our testers are skipped
  const again = await call('POST', '/v1/admin/notifications/preview', { audience });
  assert.ok(again.body.skipped >= 2);
  assert.equal(again.body.lastSent.title, 'Baarish + garma garam ☔');
  pushes = [];
  const second = await call('POST', '/v1/admin/notifications', { title: 'Second', body: 'Second promo', audience });
  if (second.status === 201) assert.ok(!pushes.some((p) => p.to.startsWith(`ExponentPushToken[ai${n}`)), 'no second promo today');
  else assert.equal(second.status, 409);

  // a stale target is refused
  assert.equal((await call('POST', '/v1/admin/notifications', {
    title: 'x stale', body: 'stale target', audience: { type: 'user', phone: phones[1].slice(3) }, target: { type: 'item', id: crypto.randomUUID() },
  })).status, 400);

  // tap (only someone who got it), and an order within 2 hours
  const h0 = H(`dev:${phones[0]}`);
  assert.equal((await call('POST', '/v1/me/notification-tap', { notificationId: sent.body.id }, h0)).status, 200);
  await call('POST', '/v1/me/notification-tap', { notificationId: sent.body.id }, h0);
  await call('POST', '/v1/me/notification-tap', { notificationId: sent.body.id }, H('dev:+919000011111'));
  const order = await call('POST', '/v1/orders', {
    cafeId: item.cafe_id, items: [{ menuItemId: item.id, qty: 1 }], address: { tower: 'A', floor: '1', desk: '1' },
  }, h0);
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const list = await call('GET', '/v1/admin/notifications');
  const row = list.body.rows.find((x: any) => x.id === sent.body.id);
  assert.equal(row.taps, 1, 'counted once, only for people who got it');
  assert.ok(row.orders >= 1 && row.sales >= item.price);
  assert.equal(row.source, 'ai');

  process.env.QUIET_HOURS = '0-24';
  assert.equal((await call('POST', '/v1/admin/notifications', { title: 'Night', body: 'night promo', audience })).status, 409);
  process.env.QUIET_HOURS = 'off';
});
