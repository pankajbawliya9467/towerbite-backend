/** Paged + filtered lists, and Admin → Reports (summary, six downloads, permissions, logging). */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

globalThis.fetch = (async () => new Response('{}', { status: 202 })) as typeof fetch;
const { buildApp } = await import('../src/app.js');
const { pool, q } = await import('../src/db.js');
const app = await buildApp();
await app.ready();
const made: string[] = [];
after(async () => {
  await q(`delete from admins where id = any($1::uuid[])`, [made]);
  await app.close();
  await pool.end();
});

const n = Date.now();
const H = (t: string) => ({ authorization: `Bearer ${t}` });
const admin = H('dev:admin@towerbites.dev');
const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = admin) => {
  const res = await app.inject({ method: method as any, url, payload: payload as any, headers });
  let body: any = res.body;
  try { body = JSON.parse(res.body); } catch { /* csv */ }
  return { status: res.statusCode, body, headers: res.headers };
};
async function limited(permissions: string[]) {
  const email = `rep${n}${made.length}@tb.test`;
  const r = await call('POST', '/v1/admin/admins', { name: 'Rep', email, password: 'password123', permissions });
  made.push(r.body.id);
  return H((await call('POST', '/v1/auth/staff/login', { email, password: 'password123' }, {})).body.token);
}

test('orders: pages, total and filters; old list form still works', async () => {
  const p1 = await call('GET', '/v1/admin/orders?page=1&pageSize=25');
  assert.equal(p1.status, 200);
  assert.ok(p1.body.total >= p1.body.rows.length && p1.body.rows.length <= 25);
  if (p1.body.total > 25) {
    const p2 = await call('GET', '/v1/admin/orders?page=2&pageSize=25');
    assert.notEqual(p2.body.rows[0].id, p1.body.rows[0].id, 'page 2 is different');
  }
  const o = p1.body.rows[0];
  if (o) {
    const byNo = await call('GET', `/v1/admin/orders?page=1&search=${o.orderNo}`);
    assert.ok(byNo.body.rows.some((x: any) => x.id === o.id), 'search by order number');
    const st = await call('GET', `/v1/admin/orders?page=1&status=${o.status}`);
    assert.ok(st.body.rows.every((x: any) => x.status === o.status));
  }
  assert.ok(Array.isArray((await call('GET', '/v1/admin/orders?limit=3')).body), 'dashboard list unchanged');
  assert.equal((await call('GET', '/v1/admin/orders?page=1&status=hacked')).status, 400);
  assert.equal((await call('GET', '/v1/admin/orders?page=1&from=2026-13-45')).status, 400);
  // injection-looking input is just text
  const inj = await call('GET', `/v1/admin/orders?page=1&search=${encodeURIComponent("x' or 1=1 --")}&company=${encodeURIComponent('%')}`);
  assert.equal(inj.status, 200);
  assert.equal(inj.body.total, 0);
});

test('users and notifications: paged and filtered; phone search needs the phone tick', async () => {
  const u = await call('GET', '/v1/admin/users?page=1&pageSize=50');
  assert.equal(u.status, 200);
  assert.ok(u.body.rows.length <= 50 && typeof u.body.total === 'number');
  const withOrders = await call('GET', '/v1/admin/users?page=1&orders=yes');
  assert.ok(withOrders.body.rows.every((x: any) => x.orderCount > 0));
  const none = await call('GET', '/v1/admin/users?page=1&orders=no');
  assert.ok(none.body.rows.every((x: any) => x.orderCount === 0));
  const someone = u.body.rows.find((x: any) => x.phone);
  if (someone) {
    const viewer = await limited(['users.view']);
    const r = await call('GET', `/v1/admin/users?page=1&search=${encodeURIComponent(someone.phone.slice(-6))}`, undefined, viewer);
    assert.ok(r.body.rows.every((x: any) => x.phone === null), 'no phones shown');
    assert.ok(!r.body.rows.some((x: any) => x.id === someone.id && !x.name.includes(someone.phone.slice(-6))), 'cannot find people by phone');
  }
  const nl = await call('GET', '/v1/admin/notifications?page=1&source=ai&pageSize=25');
  assert.equal(nl.status, 200);
  assert.ok(nl.body.rows.every((x: any) => x.source === 'ai'));
  assert.ok(Array.isArray(nl.body.senders));
  const nc = await call('GET', '/v1/admin/notifications.csv?source=ai');
  assert.equal(nc.status, 200);
  assert.match(String(nc.body), /Tapped %/);
  const got = await call('GET', '/v1/admin/notifications?page=1&orders=yes');
  assert.ok(got.body.rows.every((x: any) => x.orders > 0));
});

test('cafe history: date range, status and search, paged', async () => {
  const cafe = H('dev:cafe@towerbites.dev');
  const r = await call('GET', '/v1/cafe/orders?status=history&page=1&from=2026-01-01&to=2026-12-31&state=delivered', undefined, cafe);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.rows.every((x: any) => x.status === 'delivered'));
  assert.ok(Array.isArray((await call('GET', '/v1/cafe/orders?status=history', undefined, cafe)).body), 'old form unchanged');
});

test('reports: summary + six downloads with the same filters; money and phone ticks; logged', async () => {
  const qs = 'from=2026-01-01&to=2026-12-31';
  const s = await call('GET', `/v1/admin/reports?${qs}`);
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(typeof s.body.sales, 'number');
  assert.equal(s.body.rows.days, 365);
  for (const kind of ['orders', 'items', 'cafes', 'days', 'lunch', 'customers']) {
    const r = await call('GET', `/v1/admin/reports/${kind}.csv?${qs}`);
    assert.equal(r.status, 200, `${kind}: ${r.body}`);
    assert.match(String(r.headers['content-disposition']), new RegExp(`towerbites_${kind}_2026-01-01_to_2026-12-31.csv`));
  }
  const days = await call('GET', `/v1/admin/reports/days.csv?${qs}`);
  assert.equal(days.body.trim().split('\r\n').length, 366, 'every day of the range + header');
  const orders = await call('GET', `/v1/admin/reports/orders.csv?${qs}`);
  assert.equal(orders.body.trim().split('\r\n').length - 1, s.body.rows.orders, 'download = what the filters show');

  // a viewer without money / phone ticks
  const viewer = await limited(['reports.view']);
  const vs = await call('GET', `/v1/admin/reports?${qs}`, undefined, viewer);
  assert.equal(vs.body.sales, null);
  const vo = await call('GET', `/v1/admin/reports/orders.csv?${qs}`, undefined, viewer);
  const phoneCol = vo.body.trim().split('\r\n').slice(1).map((l: string) => l.split(',')[5]);
  assert.ok(phoneCol.every((p: string) => !/\d{6}/.test(p)), 'no phone numbers');
  const vc = await call('GET', `/v1/admin/reports/cafes.csv?${qs}`, undefined, viewer);
  assert.ok(vc.body.trim().split('\r\n').slice(1).every((l: string) => l.split(',')[4] === ''), 'no rupees');

  const nobody = await limited(['orders.view']);
  assert.equal((await call('GET', `/v1/admin/reports?${qs}`, undefined, nobody)).status, 403);
  assert.equal((await call('GET', `/v1/admin/reports/orders.csv?${qs}`, undefined, nobody)).status, 403);
  assert.equal((await call('GET', `/v1/admin/reports/secrets.csv?${qs}`)).status, 400);
  assert.equal((await call('GET', '/v1/admin/reports?from=2024-01-01&to=2026-01-01')).status, 400, 'max one year');

  const [log] = await q<{ n: number }>(`select count(*)::int as n from report_downloads where created_at > now() - interval '1 minute'`);
  assert.ok(log.n >= 8, 'downloads are logged');
});
