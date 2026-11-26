/** App login through our API (no direct Supabase), test numbers, sessions, and the /v1/live socket. */
process.env.TEST_LOGIN_NUMBERS = '9876500001, +919876500002';
process.env.TEST_LOGIN_OTP = '123456';
process.env.SUPABASE_URL = 'http://realtime.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const { setOtpProvider } = await import('../src/lib/otp.js');
const { broadcastMany } = await import('../src/realtime.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

// A fake SMS provider: remembers what it "sent", accepts 654321.
const smsSent: string[] = [];
setOtpProvider({
  async send(phone) { smsSent.push(phone); },
  async verify(_phone, code) { if (code !== '654321') throw new Error('bad'); return {}; },
});

const n = String(Date.now()).slice(-5);
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

test('test numbers: no SMS, test code works, wrong code does not', async () => {
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone: '+919876500001' })).status, 200);
  assert.equal(smsSent.length, 0, 'no SMS for a test number');
  assert.equal((await call('POST', '/v1/auth/otp/verify', { phone: '+919876500001', code: '111111' })).status, 401);
  const ok = await call('POST', '/v1/auth/otp/verify', { phone: '98765 00001', code: '123456' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.token, /^tbs_/);
  const me = await call('GET', '/v1/me', undefined, ok.body.token);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.phone, '+919876500001');
  // same number again → same account
  const again = await call('POST', '/v1/auth/otp/verify', { phone: '+919876500001', code: '123456' });
  assert.equal(again.body.user.id, ok.body.user.id);
  // logout ends the session
  await call('DELETE', '/v1/auth/session', undefined, ok.body.token);
  assert.equal((await call('GET', '/v1/me', undefined, ok.body.token)).status, 401);
});

test('real numbers: SMS through the provider, its code logs in; the test code does not', async () => {
  const phone = `+91981${n}123`.slice(0, 13);
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone })).status, 200);
  assert.ok(smsSent.includes(phone));
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone })).status, 429, '30 s between codes');
  assert.equal((await call('POST', '/v1/auth/otp/verify', { phone, code: '123456' })).status, 401, 'test code is not for real numbers');
  const ok = await call('POST', '/v1/auth/otp/verify', { phone, code: '654321' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/v1/me', undefined, ok.body.token)).body.phone, phone);
  assert.equal((await call('POST', '/v1/auth/otp/send', { phone: '+15551234567' })).status, 400, 'India only');
});

test('open testing period: every Indian number, and those sessions end with the period', async () => {
  const phone = `+91982${n}456`.slice(0, 13);
  env.testLogin.allUntil = Date.now() + 86400_000;
  const ok = await call('POST', '/v1/auth/otp/verify', { phone, code: '123456' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/v1/me', undefined, ok.body.token)).status, 200);
  env.testLogin.allUntil = Date.now() - 1000;
  // the per-session cache is 60 s, so check a fresh token for the same number
  assert.equal((await call('POST', '/v1/auth/otp/verify', { phone, code: '123456' })).status, 401, 'period over');
});

test('live socket: only your own topics, pings arrive', async () => {
  const login = await call('POST', '/v1/auth/otp/verify', { phone: '+919876500002', code: '123456' });
  const userId = login.body.user.id;
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(`${addr.replace('http', 'ws')}/v1/live`);
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  ws.send(JSON.stringify({ type: 'auth', token: login.body.token }));
  await wait(100);
  assert.ok(got.some((m) => m.type === 'ready'));
  ws.send(JSON.stringify({ type: 'sub', topic: `user:${userId}` }));
  ws.send(JSON.stringify({ type: 'sub', topic: 'user:00000000-0000-4000-8000-000000000000' }));
  await wait(100);
  assert.ok(got.some((m) => m.type === 'denied'), 'someone else\'s topic is refused');
  await broadcastMany([{ topic: `user:${userId}`, event: 'order', payload: { orderId: 'x' } }]);
  await wait(50);
  assert.ok(got.some((m) => m.topic === `user:${userId}` && m.event === 'order'));
  ws.close();
});

test('live socket: a visitor without login can follow a building, nothing else', async () => {
  const addr = app.server.listening ? `http://127.0.0.1:${(app.server.address() as any).port}` : await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(`${addr.replace('http', 'ws')}/v1/live`);
  const got: any[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  ws.send(JSON.stringify({ type: 'auth' }));
  await wait(80);
  const loc = 'location:00000000-0000-4000-8000-0000000000aa';
  ws.send(JSON.stringify({ type: 'sub', topic: loc }));
  ws.send(JSON.stringify({ type: 'sub', topic: 'cafe:00000000-0000-4000-8000-0000000000aa' }));
  await wait(80);
  assert.ok(got.some((m) => m.type === 'denied' && m.topic.startsWith('cafe:')));
  await broadcastMany([{ topic: loc, event: 'cafes', payload: {} }]);
  await wait(50);
  assert.ok(got.some((m) => m.topic === loc && m.event === 'cafes'));
  ws.close();
});

test('CRM staff login through the API: old password copied once, wrong password refused, admin reset', async () => {
  const { setPasswordProvider } = await import('../src/lib/otp.js');
  const { q } = await import('../src/db.js');
  const id = crypto.randomUUID();
  const email = `staff${n}@cafe.test`;
  const cafeId = (await q<{ id: string }>(`select id from cafes limit 1`))[0].id;
  await q(`insert into staff (user_id, role, cafe_id, name, email) values ($1, 'cafe_staff', $3, 'T', $2)`, [id, email, cafeId]);
  const admin = 'dev:admin@towerbites.dev';
  let oldChecks = 0;
  setPasswordProvider({ async verify(e, p) { oldChecks++; return e === email && p === 'oldpass123' ? id : null; } });

  assert.equal((await call('POST', '/v1/auth/staff/login', { email, password: 'nope' })).status, 401);
  const ok = await call('POST', '/v1/auth/staff/login', { email: email.toUpperCase(), password: 'oldpass123' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.token, /^tbs_/);
  const row = await q<{ password_hash: string }>(`select password_hash from staff where user_id = $1`, [id]);
  assert.match(row[0].password_hash, /^scrypt\$/);
  const checks = oldChecks;
  assert.equal((await call('POST', '/v1/auth/staff/login', { email, password: 'oldpass123' })).status, 200);
  assert.equal(oldChecks, checks, 'second login uses our own copy');
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, ok.body.token)).status, 200, 'session works for cafe routes');
  assert.equal((await call('GET', '/v1/admin/staff', undefined, ok.body.token)).status, 403, 'a cafe login is not an admin');

  // admin sets a new password: old one stops working, old sessions end
  const r = await call('POST', `/v1/admin/staff/${id}/password`, { password: 'newpass456' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call('GET', '/v1/cafe/orders', undefined, ok.body.token)).status, 401);
  assert.equal((await call('POST', '/v1/auth/staff/login', { email, password: 'oldpass123' })).status, 401);
  assert.equal((await call('POST', '/v1/auth/staff/login', { email, password: 'newpass456' })).status, 200);
  assert.equal((await call('POST', '/v1/auth/staff/login', { email: 'nobody@x.test', password: 'whatever1' })).status, 401);
  await q(`delete from staff where user_id = $1`, [id]);
});
