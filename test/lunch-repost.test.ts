/** Posting a past lunch again: the list of past lunches, and the same dish is never posted twice on a day. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const app = await buildApp();
await app.ready();
after(async () => { await app.close(); await pool.end(); });

const cafe = { authorization: 'Bearer dev:cafe@towerbites.dev' };
const call = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers: cafe });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);

test('past lunches, post again on several days, duplicates skipped', async () => {
  const name = `Repost Thali ${Date.now()}`;
  const body = { day: day(30), name, items: 'Dal, Rice', price: 120, isVeg: true, plates: 40, imageUrl: 'https://example.com/t.jpg', slots: ['12:30-13:00'] };
  const first = await call('POST', '/v1/cafe/lunch', body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  try {
    const past = await call('GET', '/v1/cafe/lunch/past');
    assert.equal(past.status, 200);
    const mine = (past.body as any[]).filter((l) => l.name === name);
    assert.equal(mine.length, 1, 'one row per dish');
    assert.equal(mine[0].timesPosted, 1);
    assert.equal(mine[0].imageUrl, 'https://example.com/t.jpg');

    // again on day 30 (already there) + 31 + 32: only the two new days are created
    const again = await call('POST', '/v1/cafe/lunch', { ...body, alsoOn: [day(31), day(32)] });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.deepEqual((again.body as any[]).map((l) => l.day), [day(31), day(32)]);
    assert.equal((await call('POST', '/v1/cafe/lunch', { ...body, day: day(31) })).status, 409, 'same dish, same day');

    const past2 = (await call('GET', '/v1/cafe/lunch/past')).body as any[];
    const row = past2.find((l) => l.name === name);
    assert.equal(row.timesPosted, 3);
    assert.equal(row.day, day(32), 'the latest one');
  } finally {
    await q(`delete from lunch_menus where name = $1`, [name]);
  }
});
