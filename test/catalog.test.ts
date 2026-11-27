/**
 * Global categories (Admin → Categories): list rules, product rules, the menu switch, merge and mapping.
 * Runs against the database in DATABASE_URL (needs DEV_AUTH=true and seeded data). Cleans up after itself.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { OTHER_CATEGORY } from '../src/lib/catalog.js';

const app = await buildApp();
const admin = { authorization: 'Bearer dev:admin@towerbites.dev' };
const cafeStaff = { authorization: 'Bearer dev:cafe@towerbites.dev' };
const call = async (method: string, url: string, headers = {}, payload?: unknown) => {
  const res = await app.inject({ method: method as any, url, headers, payload: payload as any });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

const made: string[] = [];
let chaiId = '';
after(async () => {
  await call('PUT', '/v1/admin/catalog/switch', admin, { on: false });
  if (chaiId) await pool.query(`update menu_items set catalog_category_id = null where id = $1`, [chaiId]);
  await pool.query(`update menu_items set catalog_category_id = null where catalog_category_id = any($1::uuid[])`, [made]);
  for (const id of [...made].reverse()) await pool.query(`delete from catalog_categories where id = $1`, [id]).catch(() => undefined);
  await app.close();
  await pool.end();
});

test('global categories: list, product rules, switch, merge', async () => {
  const n = Date.now() % 100000;
  assert.equal((await call('POST', '/v1/admin/catalog', cafeStaff, { name: 'Nope' })).status, 403);

  const main = await call('POST', '/v1/admin/catalog', admin, { name: `Test drinks ${n}`, emoji: '☕' });
  assert.equal(main.status, 201, JSON.stringify(main.body));
  made.push(main.body.id);
  const sub = await call('POST', '/v1/admin/catalog', admin, { name: 'Test tea', parentId: main.body.id, keywords: ['Chai'] });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  made.push(sub.body.id);
  assert.deepEqual(sub.body.keywords, ['chai']);
  assert.ok(sub.body.slug.startsWith(main.body.slug));

  // only one level, and the same name only once in a parent
  const deep = await call('POST', '/v1/admin/catalog', admin, { name: 'Too deep', parentId: sub.body.id });
  assert.equal(deep.status, 400);
  assert.equal((await call('POST', '/v1/admin/catalog', admin, { name: 'TEST TEA', parentId: main.body.id })).status, 409);
  // a main category with a sub-category that is on can't be turned off
  assert.equal((await call('PATCH', `/v1/admin/catalog/${main.body.id}`, admin, { isActive: false })).status, 409);

  // a product sits in a leaf: the sub-category, not its main category
  const cafe = (await call('GET', '/v1/locations/spaze-tech-park/cafes/krunchy-kafe')).body;
  const chai = cafe.items.find((i: any) => i.name === 'Masala Chai');
  chaiId = chai.id;
  assert.equal((await call('PATCH', `/v1/admin/menu-items/${chai.id}`, admin, { catalogCategoryId: main.body.id })).status, 400);
  const saved = await call('PATCH', `/v1/admin/menu-items/${chai.id}`, admin, { catalogCategoryId: sub.body.id });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.catalogCategoryId, sub.body.id);

  // a category with products can't be deleted or turned off
  assert.equal((await call('DELETE', `/v1/admin/catalog/${sub.body.id}`, admin)).status, 409);
  assert.equal((await call('PATCH', `/v1/admin/catalog/${sub.body.id}`, admin, { isActive: false })).status, 409);

  // switch on: the menu shows global categories; products without one go under "More"
  assert.equal((await call('PUT', '/v1/admin/catalog/switch', cafeStaff, { on: true })).status, 403);
  assert.equal((await call('PUT', '/v1/admin/catalog/switch', admin, { on: true })).body.enabled, true);
  const menu = (await call('GET', `/v1/cafes/${cafe.id}`)).body;
  assert.equal(menu.items.find((i: any) => i.id === chai.id).categoryId, sub.body.id);
  assert.ok(menu.categories.some((c: any) => c.id === sub.body.id && c.parentId === main.body.id));
  assert.ok(menu.categories.some((c: any) => c.id === main.body.id));
  if (menu.items.some((i: any) => i.id !== chai.id && !i.catalogCategoryId)) {
    assert.ok(menu.categories.some((c: any) => c.id === OTHER_CATEGORY.id));
  }
  // every product a customer sees is in a category the menu lists
  const ids = new Set(menu.categories.map((c: any) => c.id));
  assert.ok(menu.items.every((i: any) => ids.has(i.categoryId)));
  // once the switch is on, a new product needs a category
  const noCat = await call('POST', '/v1/admin/menu-items', admin, { cafeId: cafe.id, name: 'No category test', price: 10 });
  assert.equal(noCat.status, 400);

  // switch off: back to the cafe's own categories
  await call('PUT', '/v1/admin/catalog/switch', admin, { on: false });
  const old = (await call('GET', `/v1/cafes/${cafe.id}`)).body;
  assert.notEqual(old.items.find((i: any) => i.id === chai.id).categoryId, sub.body.id);

  // merge: products move, the old one is turned off and its name becomes an alias
  const sub2 = await call('POST', '/v1/admin/catalog', admin, { name: 'Test chai', parentId: main.body.id });
  made.push(sub2.body.id);
  const merged = await call('POST', '/v1/admin/catalog/merge', admin, { fromId: sub.body.id, toId: sub2.body.id });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.moved, 1);
  const after2 = merged.body.categories;
  assert.equal(after2.find((c: any) => c.id === sub.body.id).isActive, false);
  assert.ok(after2.find((c: any) => c.id === sub2.body.id).aliases.includes('test tea'));
});

test('mapping: suggest, preview, approve, apply, export', async () => {
  const sug = await call('POST', '/v1/admin/catalog/mapping/suggest', admin, {});
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  const groups = sug.body.groups as any[];
  assert.ok(groups.length > 0);
  const popular = groups.find((g) => g.key === 'popular');
  if (popular && !popular.approved) assert.equal(popular.action, 'popular');

  const g = groups.find((x) => x.products > 0);
  const preview = await call('GET', `/v1/admin/catalog/mapping/preview?key=${encodeURIComponent(g.key)}`, admin);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.length, g.products);

  // map needs a target that is a leaf
  assert.equal((await call('PUT', '/v1/admin/catalog/mapping', admin, { key: g.key, action: 'map', catalogCategoryId: null })).status, 400);

  const exp = await call('GET', '/v1/admin/catalog/export', admin);
  assert.equal(exp.status, 200);
  assert.equal(exp.body.format, 'towerbites-catalog');
  assert.ok(Array.isArray(exp.body.categories) && Array.isArray(exp.body.mapping));
});
