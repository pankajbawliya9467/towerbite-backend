/** Our own login codes, delivered by 2Factor.in (fetch is faked: no real SMS). */
process.env.TWOFACTOR_API_KEY = 'test-key';
process.env.TWOFACTOR_TEMPLATE = 'TowerBites OTP';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const calls: string[] = [];
let reply = { Status: 'Success', Details: 'sess-1' };
globalThis.fetch = (async (url: string) => {
  calls.push(String(url));
  return new Response(JSON.stringify(reply), { status: 200 });
}) as typeof fetch;

const { buildApp } = await import('../src/app.js');
const { pool, one } = await import('../src/db.js');
const { env } = await import('../src/env.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const call = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: 'POST', url, payload: payload as any });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const phone = `+9198${String(Date.now()).slice(-8)}`;

test('2factor is picked when its key is set', () => {
  assert.equal(env.otpProvider, '2factor');
});

test('code is made here, sent through 2Factor with the template, works once', async () => {
  assert.equal((await call('/v1/auth/otp/send', { phone })).status, 200);
  const url = calls.at(-1)!;
  const m = url.match(/^https:\/\/2factor\.in\/API\/V1\/test-key\/SMS\/(\d+)\/(\d{6})\/TowerBites%20OTP$/);
  assert.ok(m, url);
  assert.equal(`+${m![1]}`, phone);
  const code = m![2];
  const row = await one<{ code_hash: string }>(`select code_hash from otp_codes where phone = $1`, [phone]);
  assert.ok(row && !row.code_hash.includes(code), 'only a hash is stored');

  assert.equal((await call('/v1/auth/otp/verify', { phone, code: code === '000000' ? '111111' : '000000' })).status, 401);
  const ok = await call('/v1/auth/otp/verify', { phone, code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.token, /^tbs_/);
  assert.equal((await call('/v1/auth/otp/verify', { phone, code })).status, 401, 'a code works only once');
});

test('2Factor error: the user gets a clear message, the key never leaks', async () => {
  reply = { Status: 'Error', Details: 'Invalid API Key' };
  const p2 = `+9197${String(Date.now()).slice(-8)}`;
  const r = await call('/v1/auth/otp/send', { phone: p2 });
  assert.ok(r.status >= 400, String(r.status));
  assert.ok(!JSON.stringify(r.body).includes('test-key'));
  console.log('error shown to user:', r.status, r.body.error);
  reply = { Status: 'Success', Details: 'sess-2' };
});
