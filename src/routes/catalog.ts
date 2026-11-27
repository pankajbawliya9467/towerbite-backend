import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q, tx } from '../db.js';
import { requireAdmin, type Staff } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { like, paging } from '../lib/paging.js';
import { cafesChanged } from '../realtime.js';
import {
  catalogOn, groupKey, isLeaf, keywordRules, norm, pickByKeywords, setCatalogOn, slugify, type CatalogRow,
} from '../lib/catalog.js';

/**
 * Admin → Categories: one list of categories for every cafe (main category + sub-categories), and the
 * one-time move of each cafe's own categories into it:
 *   1. Suggest   — each old category name is matched to a global one by its aliases (not approved yet)
 *   2. Mapping   — an admin checks every old name, picks the target and approves it
 *   3. Apply     — products get their global category (mixed old categories can split by product keywords)
 *   4. Switch on — menus in the app, website and cafe panel are built from the global categories
 * Export / Import moves the whole result (list, mapping, product assignments) from a local copy to production.
 */

const uuid = z.string().uuid();
const words = (max: number, len: number) =>
  z.array(z.string().max(len)).max(max).transform((list) => [...new Set(list.map(norm).filter(Boolean))]);
const POPULAR_NAMES = ['popular', 'bestseller', 'bestsellers', 'best seller', 'best sellers', 'recommended', 'top picks'];

const CategoryInput = z.object({
  name: z.string().trim().min(1).max(40),
  parentId: uuid.nullable().optional(),
  emoji: z.string().trim().max(8).optional(),
  aliases: words(40, 80).optional(),
  keywords: words(40, 40).optional(),
  sort: z.number().int().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
});

const COLS = `k.id, k.parent_id as "parentId", k.name, k.slug, k.emoji, k.aliases, k.keywords, k.sort, k.is_active as "isActive"`;

async function list() {
  const [categories, [counts], on] = await Promise.all([
    q(
      `select ${COLS}, count(i.id)::int as products, count(distinct i.cafe_id)::int as cafes
       from catalog_categories k left join menu_items i on i.catalog_category_id = k.id
       group by k.id order by k.sort, k.name`,
    ),
    q<{ unassigned: number; total: number }>(
      `select count(*) filter (where catalog_category_id is null)::int as unassigned, count(*)::int as total
       from menu_items i join cafes c on c.id = i.cafe_id where i.is_active and c.is_active`,
    ),
    catalogOn(),
  ]);
  return { enabled: on, categories, unassigned: counts.unassigned, totalProducts: counts.total };
}

/** When menus already use the global list, every open app/website/cafe panel reloads after a change. */
async function pingMenus() {
  if (!(await catalogOn())) return;
  const locs = await q<{ id: string }>(`select id from locations`);
  await cafesChanged(locs.map((l) => l.id));
}

async function catalogRows() {
  return q<CatalogRow>(`select id, parent_id, name, slug, aliases, keywords, is_active from catalog_categories`);
}

async function uniqueSlug(base: string, exceptId: string | null = null) {
  for (let n = 1; n < 100; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const taken = await one(`select 1 from catalog_categories where slug = $1 and ($2::uuid is null or id <> $2)`, [slug, exceptId]);
    if (!taken) return slug;
  }
  throw conflict('Could not make a unique name for this category');
}

async function requireMain(parentId: string, selfId: string | null = null) {
  if (parentId === selfId) throw badRequest('A category cannot be inside itself');
  const p = await one<{ parent_id: string | null; is_active: boolean; slug: string }>(
    `select parent_id, is_active, slug from catalog_categories where id = $1`, [parentId]);
  if (!p) throw badRequest('Main category not found');
  if (p.parent_id) throw badRequest('Pick a main category (sub-categories cannot have their own sub-categories)');
  if (!p.is_active) throw badRequest('That main category is turned off');
  return p;
}

async function requireLeaf(id: string) {
  const leaf = await isLeaf(id);
  if (leaf === null) throw badRequest('Category not found');
  if (!leaf) throw badRequest('Pick a sub-category (this category has sub-categories), or a category that is turned on');
}

// ---------- old per-cafe categories, grouped by name ----------
type OldRow = {
  id: string; name: string; parent: string | null; cafe_id: string; products: number;
  target: string | null; action: string | null; use_keywords: boolean | null; approved: boolean | null;
};
type Group = {
  key: string; name: string; parent: string | null; ids: string[]; cafes: number; products: number; sample: string[];
  target: string | null; action: string; useKeywords: boolean; approved: boolean; mixed: boolean; mapped: boolean;
};

async function groups(): Promise<Group[]> {
  const [rows, samples] = await Promise.all([
    q<OldRow>(
      `select c.id, c.name, p.name as parent, c.cafe_id,
         (select count(*)::int from menu_items i where i.category_id = c.id) as products,
         m.catalog_category_id as target, m.action, m.use_keywords, m.approved
       from categories c left join categories p on p.id = c.parent_id
       left join category_map m on m.old_category_id = c.id`,
    ),
    q<{ category_id: string; names: string[] }>(
      `select category_id, (array_agg(name order by name))[1:5] as names from menu_items where category_id is not null group by 1`,
    ),
  ]);
  const sampleOf = new Map(samples.map((x) => [x.category_id, x.names]));
  const byKey = new Map<string, OldRow[]>();
  for (const r of rows) {
    const k = groupKey(r.name, r.parent);
    const list = byKey.get(k);
    if (list) list.push(r);
    else byKey.set(k, [r]);
  }
  return [...byKey.entries()].map(([key, rs]) => {
    const first = rs[0];
    const sig = (r: OldRow) => `${r.target}|${r.action}|${r.use_keywords}`;
    return {
      key,
      name: norm(first.name),
      parent: first.parent ? norm(first.parent) : null,
      ids: rs.map((r) => r.id),
      cafes: new Set(rs.map((r) => r.cafe_id)).size,
      products: rs.reduce((s, r) => s + r.products, 0),
      sample: [...new Set(rs.flatMap((r) => sampleOf.get(r.id) ?? []))].slice(0, 5),
      target: first.target,
      action: first.action ?? 'map',
      useKeywords: !!first.use_keywords,
      approved: rs.every((r) => r.approved),
      mixed: rs.some((r) => sig(r) !== sig(first)),
      mapped: rs.every((r) => r.action !== null),
    };
  }).sort((a, b) => Number(a.approved) - Number(b.approved) || b.products - a.products || a.key.localeCompare(b.key));
}

type OldProduct = { id: string; name: string; category_id: string; catalog_category_id: string | null };

/** Products of old categories, for keyword splitting and the preview. */
async function productsOf(oldIds: string[]) {
  return q<OldProduct>(
    `select id, name, category_id, catalog_category_id from menu_items where category_id = any($1::uuid[])`,
    [oldIds],
  );
}

/** Every product that has an old category, by that category (one query instead of one per name). */
async function productsByOldCategory() {
  const rows = await q<OldProduct>(`select id, name, category_id, catalog_category_id from menu_items where category_id is not null`);
  const by = new Map<string, OldProduct[]>();
  for (const r of rows) {
    const list = by.get(r.category_id);
    if (list) list.push(r);
    else by.set(r.category_id, [r]);
  }
  return (ids: string[]) => ids.flatMap((id) => by.get(id) ?? []);
}

/** The global category an old category name points to by name or alias (leaf categories only). */
function suggestTarget(g: Group, cats: CatalogRow[]) {
  const parents = new Set(cats.filter((c) => c.parent_id && c.is_active).map((c) => c.parent_id));
  const leaves = cats.filter((c) => c.is_active && !parents.has(c.id));
  const names = (c: CatalogRow) => [norm(c.name), ...c.aliases.map(norm)];
  return (leaves.find((c) => names(c).includes(g.key)) ?? leaves.find((c) => names(c).includes(g.name)))?.id ?? null;
}

export async function catalogRoutes(app: FastifyInstance) {
  const superOnly = async (req: Parameters<typeof requireAdmin>[0]): Promise<Staff> => {
    const me = await requireAdmin(req);
    if (!me.isSuper) throw forbidden('Only a super admin can switch menus to the global categories');
    return me;
  };

  // ---------- the list ----------
  /** Readable by any admin (product forms and filters need it). */
  app.get('/v1/admin/catalog', async (req) => {
    await requireAdmin(req);
    return list();
  });

  app.post('/v1/admin/catalog', async (req, reply) => {
    await requireAdmin(req, 'catalog.add');
    const body = CategoryInput.parse(req.body);
    let prefix = '';
    if (body.parentId) prefix = `${(await requireMain(body.parentId)).slug}-`;
    const slug = await uniqueSlug(`${prefix}${slugify(body.name)}`);
    const sort = body.sort ?? (await one<{ n: number }>(
      `select coalesce(max(sort), 0)::int + 1 as n from catalog_categories where parent_id is not distinct from $1`, [body.parentId ?? null]))!.n;
    const row = await one<{ id: string }>(
      `insert into catalog_categories (parent_id, name, slug, emoji, aliases, keywords, sort, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [body.parentId ?? null, body.name, slug, body.emoji ?? '', body.aliases ?? [], body.keywords ?? [], sort, body.isActive ?? true],
    );
    reply.code(201);
    return one(`select ${COLS} from catalog_categories k where k.id = $1`, [row!.id]);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/catalog/:id', async (req) => {
    const id = uuid.parse(req.params.id);
    const body = CategoryInput.partial().parse(req.body);
    const turning = body.isActive !== undefined;
    const editing = Object.keys(body).some((k) => k !== 'isActive' && (body as Record<string, unknown>)[k] !== undefined);
    if (turning) await requireAdmin(req, 'catalog.delete');
    if (editing || !turning) await requireAdmin(req, 'catalog.edit');

    const cur = await one<{ parent_id: string | null; is_active: boolean }>(`select parent_id, is_active from catalog_categories where id = $1`, [id]);
    if (!cur) throw notFound('Category not found');
    if (body.parentId !== undefined && body.parentId !== cur.parent_id) {
      if (body.parentId) {
        await requireMain(body.parentId, id);
        if (await one(`select 1 from catalog_categories where parent_id = $1`, [id])) {
          throw badRequest('This category has sub-categories, so it stays a main category');
        }
      }
    }
    if (body.isActive === false && cur.is_active) {
      const used = await one<{ n: number }>(`select count(*)::int as n from menu_items where catalog_category_id = $1`, [id]);
      if (used!.n) throw conflict(`${used!.n} products are in this category. Merge it into another category first.`);
      if (await one(`select 1 from catalog_categories where parent_id = $1 and is_active`, [id])) {
        throw conflict('Turn off its sub-categories first');
      }
    }
    if (body.isActive === true && !cur.is_active && cur.parent_id) {
      const p = await one<{ is_active: boolean }>(`select is_active from catalog_categories where id = $1`, [cur.parent_id]);
      if (!p?.is_active) throw conflict('Turn its main category on first');
    }
    await q(
      `update catalog_categories set name = coalesce($2, name), parent_id = case when $3 then $4::uuid else parent_id end,
         emoji = coalesce($5, emoji), aliases = coalesce($6, aliases), keywords = coalesce($7, keywords),
         sort = coalesce($8, sort), is_active = coalesce($9, is_active), updated_at = now()
       where id = $1`,
      [id, body.name ?? null, body.parentId !== undefined, body.parentId ?? null, body.emoji ?? null,
        body.aliases ?? null, body.keywords ?? null, body.sort ?? null, body.isActive ?? null],
    );
    await pingMenus();
    return one(`select ${COLS} from catalog_categories k where k.id = $1`, [id]);
  });

  /** Only an empty category (no products, no sub-categories) can be deleted. Otherwise: merge, or turn it off. */
  app.delete<{ Params: { id: string } }>('/v1/admin/catalog/:id', async (req) => {
    await requireAdmin(req, 'catalog.delete');
    const id = uuid.parse(req.params.id);
    if (await one(`select 1 from catalog_categories where parent_id = $1`, [id])) throw conflict('Delete or move its sub-categories first');
    if (await one(`select 1 from menu_items where catalog_category_id = $1`, [id])) throw conflict('This category has products. Merge it into another category instead.');
    const row = await one(`delete from catalog_categories where id = $1 returning id`, [id]);
    if (!row) throw notFound('Category not found');
    return { ok: true };
  });

  /** Order of the main categories (parentId null) or of the sub-categories of one main category. */
  app.put('/v1/admin/catalog/order', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    const { parentId, ids } = z.object({ parentId: uuid.nullable(), ids: z.array(uuid).min(1).max(500) }).parse(req.body);
    if (new Set(ids).size !== ids.length) throw badRequest('A category is listed twice');
    const rows = await q(
      `update catalog_categories k set sort = x.pos, updated_at = now()
       from unnest($2::uuid[]) with ordinality as x(id, pos)
       where k.id = x.id and k.parent_id is not distinct from $1 returning k.id`,
      [parentId, ids],
    );
    if (rows.length !== ids.length) throw badRequest('Some of these categories are not in that place');
    await pingMenus();
    return list();
  });

  /** Moves every product (and mapping) of one category into another, keeps its names as aliases, turns it off. */
  app.post('/v1/admin/catalog/merge', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    const { fromId, toId } = z.object({ fromId: uuid, toId: uuid }).parse(req.body);
    if (fromId === toId) throw badRequest('Pick two different categories');
    if (await one(`select 1 from catalog_categories where parent_id = $1`, [fromId])) {
      throw badRequest('This category has sub-categories. Merge those one by one instead.');
    }
    await requireLeaf(toId);
    const moved = await tx(async (c) => {
      const { rows: [from] } = await c.query(`select name, aliases from catalog_categories where id = $1 for update`, [fromId]);
      if (!from) throw notFound('Category not found');
      const { rowCount } = await c.query(`update menu_items set catalog_category_id = $2 where catalog_category_id = $1`, [fromId, toId]);
      await c.query(`update category_map set catalog_category_id = $2, updated_at = now() where catalog_category_id = $1`, [fromId, toId]);
      await c.query(
        `update catalog_categories set aliases = (select coalesce(array_agg(distinct a), '{}') from unnest(aliases || $2::text[]) a),
           updated_at = now() where id = $1`,
        [toId, [norm(from.name), ...from.aliases]],
      );
      await c.query(`update catalog_categories set is_active = false, updated_at = now() where id = $1`, [fromId]);
      return rowCount ?? 0;
    });
    await pingMenus();
    return { moved, ...(await list()) };
  });

  /** The big switch: menus everywhere use the global categories (on) or each cafe's own (off). */
  app.put('/v1/admin/catalog/switch', async (req) => {
    const me = await superOnly(req);
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    await setCatalogOn(on, me.userId);
    const locs = await q<{ id: string }>(`select id from locations`);
    await cafesChanged(locs.map((l) => l.id));
    return list();
  });

  // ---------- moving the old per-cafe categories ----------
  app.get('/v1/admin/catalog/mapping', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    return groups();
  });

  /** Fills a suggestion for every old category name that is not approved yet. Approved ones are never touched. */
  app.post('/v1/admin/catalog/mapping/suggest', async (req) => {
    const me = await requireAdmin(req, 'catalog.edit');
    const [all, cats, productsIn] = await Promise.all([groups(), catalogRows(), productsByOldCategory()]);
    const rules = keywordRules(cats);
    let suggested = 0;
    for (const g of all.filter((x) => !x.approved)) {
      let action = 'map';
      let target: string | null = null;
      let useKeywords = false;
      if (!g.products) action = 'skip';
      else if (POPULAR_NAMES.includes(g.name)) action = 'popular';
      else {
        target = suggestTarget(g, cats);
        const products = productsIn(g.ids);
        useKeywords = products.some((p) => {
          const pick = pickByKeywords(p.name, target, rules);
          return !!pick && pick !== target;
        });
      }
      await q(
        `insert into category_map (old_category_id, catalog_category_id, action, use_keywords, approved, updated_by)
         select unnest($1::uuid[]), $2, $3, $4, false, $5
         on conflict (old_category_id) do update set catalog_category_id = excluded.catalog_category_id, action = excluded.action,
           use_keywords = excluded.use_keywords, updated_by = excluded.updated_by, updated_at = now()
         where not category_map.approved`,
        [g.ids, target, action, useKeywords, me.userId],
      );
      suggested++;
    }
    return { suggested, groups: await groups() };
  });

  /** Sets (and approves, unless told not to) where one old category name goes, for every cafe that has it. */
  app.put('/v1/admin/catalog/mapping', async (req) => {
    const me = await requireAdmin(req, 'catalog.edit');
    const body = z.object({
      key: z.string().min(1).max(200),
      catalogCategoryId: uuid.nullable(),
      action: z.enum(['map', 'popular', 'skip']),
      useKeywords: z.boolean().default(false),
      approved: z.boolean().default(true),
    }).parse(req.body);
    if (body.action === 'map') {
      if (!body.catalogCategoryId) throw badRequest('Pick the category these products go to');
      await requireLeaf(body.catalogCategoryId);
    }
    const g = (await groups()).find((x) => x.key === body.key);
    if (!g) throw notFound('This old category was not found');
    await q(
      `insert into category_map (old_category_id, catalog_category_id, action, use_keywords, approved, updated_by)
       select unnest($1::uuid[]), $2, $3, $4, $5, $6
       on conflict (old_category_id) do update set catalog_category_id = excluded.catalog_category_id, action = excluded.action,
         use_keywords = excluded.use_keywords, approved = excluded.approved, updated_by = excluded.updated_by, updated_at = now()`,
      [g.ids, body.action === 'map' ? body.catalogCategoryId : null, body.action, body.action === 'map' && body.useKeywords, body.approved, me.userId],
    );
    return (await groups()).find((x) => x.key === body.key);
  });

  /** Where each product of one old category name would go if applied now (nothing is saved). */
  app.get<{ Querystring: { key?: string } }>('/v1/admin/catalog/mapping/preview', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    const g = (await groups()).find((x) => x.key === req.query.key);
    if (!g) throw notFound('This old category was not found');
    const [products, cats] = await Promise.all([productsOf(g.ids), catalogRows()]);
    const rules = keywordRules(cats);
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      now: p.catalog_category_id,
      goesTo: g.action !== 'map' ? null : g.useKeywords ? pickByKeywords(p.name, g.target, rules) : g.target,
    })).sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * Gives products their global category from the approved mapping. By default only products that have none yet
   * (so products moved by hand keep their place); `overwrite` redoes all of them. Products with no old category
   * at all get one when their name matches a keyword.
   */
  app.post('/v1/admin/catalog/mapping/apply', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    const { overwrite } = z.object({ overwrite: z.boolean().default(false) }).parse(req.body ?? {});
    const [all, cats, productsIn] = await Promise.all([groups(), catalogRows(), productsByOldCategory()]);
    const rules = keywordRules(cats);
    const ids: string[] = [];
    const targets: string[] = [];
    const popular: string[] = [];
    for (const g of all.filter((x) => x.approved)) {
      if (g.action === 'popular') popular.push(...g.ids);
      if (g.action !== 'map' || !g.target) continue;
      for (const p of productsIn(g.ids)) {
        if (p.catalog_category_id && !overwrite) continue;
        const t = g.useKeywords ? pickByKeywords(p.name, g.target, rules) : g.target;
        if (t) {
          ids.push(p.id);
          targets.push(t);
        }
      }
    }
    const loose = await q<{ id: string; name: string }>(
      `select id, name from menu_items where category_id is null and catalog_category_id is null`,
    );
    for (const p of loose) {
      const t = pickByKeywords(p.name, null, rules);
      if (t) {
        ids.push(p.id);
        targets.push(t);
      }
    }
    const result = await tx(async (c) => {
      const { rowCount: assigned } = await c.query(
        `update menu_items i set catalog_category_id = x.cat from unnest($1::uuid[], $2::uuid[]) as x(id, cat) where i.id = x.id`,
        [ids, targets],
      );
      const { rowCount: starred } = popular.length
        ? await c.query(`update menu_items set is_popular = true where category_id = any($1::uuid[]) and not is_popular`, [popular])
        : { rowCount: 0 };
      return { assigned: assigned ?? 0, starred: starred ?? 0 };
    });
    await pingMenus();
    return { ...result, notApproved: all.filter((g) => !g.approved && g.products).length, ...(await list()) };
  });

  // ---------- products (fix list and moving by hand) ----------
  type ProductsQuery = { category?: string; cafeId?: string; search?: string; page?: string; pageSize?: string };
  app.get<{ Querystring: ProductsQuery }>('/v1/admin/catalog/products', async (req) => {
    await requireAdmin(req, 'catalog.view');
    const qs = req.query;
    const params: unknown[] = [];
    const where: string[] = ['true'];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (qs.category === 'none') where.push('i.catalog_category_id is null');
    else if (qs.category) add('i.catalog_category_id = ?', uuid.parse(qs.category));
    if (qs.cafeId) add('i.cafe_id = ?', uuid.parse(qs.cafeId));
    if (qs.search?.trim()) add('i.name ilike ?', like(qs.search));
    const pg = paging(qs);
    const sql = where.join(' and ');
    const [count] = await q<{ n: number }>(`select count(*)::int as n from menu_items i where ${sql}`, params);
    const rows = await q(
      `select i.id, i.name, i.emoji, i.price, i.is_veg as "isVeg", i.is_active as "isActive",
         i.catalog_category_id as "catalogCategoryId", c.id as "cafeId", c.name as "cafeName",
         oc.name as "oldCategory", op.name as "oldParent"
       from menu_items i join cafes c on c.id = i.cafe_id
       left join categories oc on oc.id = i.category_id left join categories op on op.id = oc.parent_id
       where ${sql} order by c.name, i.name limit ${pg.limit} offset ${pg.offset}`,
      params,
    );
    return { rows, total: count.n, page: pg.page, pageSize: pg.pageSize };
  });

  app.post('/v1/admin/catalog/assign', async (req) => {
    await requireAdmin(req, 'catalog.edit');
    const { itemIds, catalogCategoryId } = z.object({ itemIds: z.array(uuid).min(1).max(500), catalogCategoryId: uuid }).parse(req.body);
    await requireLeaf(catalogCategoryId);
    const rows = await q(`update menu_items set catalog_category_id = $2 where id = any($1::uuid[]) returning id`, [itemIds, catalogCategoryId]);
    await pingMenus();
    return { moved: rows.length };
  });

  // ---------- export / import (local copy → production) ----------
  app.get('/v1/admin/catalog/export', async (req) => {
    await requireAdmin(req, 'catalog.view');
    const [cats, all, assignments] = await Promise.all([
      q<CatalogRow & { sort: number; emoji: string }>(
        `select id, parent_id, name, slug, aliases, keywords, is_active, sort, emoji from catalog_categories`,
      ),
      groups(),
      q<{ itemId: string; target: string }>(
        `select i.id as "itemId", k.slug as target from menu_items i join catalog_categories k on k.id = i.catalog_category_id`,
      ),
    ]);
    const slugOf = new Map(cats.map((c) => [c.id, c.slug]));
    return {
      format: 'towerbites-catalog',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories: [...cats]
        .sort((a, b) => Number(!!a.parent_id) - Number(!!b.parent_id) || a.sort - b.sort)
        .map((c) => ({
          slug: c.slug, name: c.name, parent: c.parent_id ? slugOf.get(c.parent_id) ?? null : null, emoji: c.emoji,
          aliases: c.aliases, keywords: c.keywords, sort: c.sort, isActive: c.is_active,
        })),
      mapping: all.filter((g) => g.mapped).map((g) => ({
        key: g.key, target: g.target ? slugOf.get(g.target) ?? null : null, action: g.action, useKeywords: g.useKeywords, approved: g.approved,
      })),
      assignments,
    };
  });

  const ImportFile = z.object({
    format: z.literal('towerbites-catalog'),
    version: z.literal(1),
    categories: z.array(z.object({
      slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
      name: z.string().trim().min(1).max(40),
      parent: z.string().nullable().default(null),
      emoji: z.string().max(8).default(''),
      aliases: words(40, 80).default([]),
      keywords: words(40, 40).default([]),
      sort: z.number().int().default(0),
      isActive: z.boolean().default(true),
    })).max(2000),
    mapping: z.array(z.object({
      key: z.string().min(1).max(200),
      target: z.string().nullable(),
      action: z.enum(['map', 'popular', 'skip']),
      useKeywords: z.boolean().default(false),
      approved: z.boolean().default(true),
    })).max(20000).default([]),
    assignments: z.array(z.object({ itemId: uuid, target: z.string() })).max(500000).default([]),
    overwrite: z.boolean().default(false),
  });

  /**
   * Adds or updates categories (matched by slug), the mapping (matched by old category name) and product
   * assignments (matched by product id: the same in a local copy restored from a production backup). Existing
   * product categories are kept unless `overwrite` is set. One transaction: all or nothing.
   */
  app.post('/v1/admin/catalog/import', { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const me = await requireAdmin(req, 'catalog.edit');
    const file = ImportFile.parse(req.body);
    const mains = file.categories.filter((c) => !c.parent);
    const subs = file.categories.filter((c) => c.parent);
    const badParent = subs.find((c) => !mains.some((m) => m.slug === c.parent));
    if (badParent) throw badRequest(`"${badParent.name}" points to a main category that is not in the file`);
    const groupList = await groups();

    const result = await tx(async (c) => {
      const save = async (cat: (typeof file.categories)[number], parentId: string | null) => {
        const { rows: [row] } = await c.query(
          `insert into catalog_categories (parent_id, name, slug, emoji, aliases, keywords, sort, is_active)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (slug) do update set parent_id = excluded.parent_id, name = excluded.name, emoji = excluded.emoji,
             aliases = excluded.aliases, keywords = excluded.keywords, sort = excluded.sort, is_active = excluded.is_active, updated_at = now()
           returning id`,
          [parentId, cat.name, cat.slug, cat.emoji, cat.aliases, cat.keywords, cat.sort, cat.isActive],
        );
        return row.id as string;
      };
      const idOf = new Map<string, string>();
      for (const m of mains) idOf.set(m.slug, await save(m, null));
      for (const s of subs) idOf.set(s.slug, await save(s, idOf.get(s.parent!)!));
      // Slugs already in the database (not in the file) can be targets too.
      const { rows: existing } = await c.query(`select id, slug from catalog_categories`);
      for (const r of existing) if (!idOf.has(r.slug)) idOf.set(r.slug, r.id);

      let mapped = 0;
      for (const m of file.mapping) {
        const g = groupList.find((x) => x.key === norm(m.key));
        if (!g) continue; // that old category doesn't exist here
        const target = m.target ? idOf.get(m.target) ?? null : null;
        if (m.action === 'map' && !target) continue;
        await c.query(
          `insert into category_map (old_category_id, catalog_category_id, action, use_keywords, approved, updated_by)
           select unnest($1::uuid[]), $2, $3, $4, $5, $6
           on conflict (old_category_id) do update set catalog_category_id = excluded.catalog_category_id, action = excluded.action,
             use_keywords = excluded.use_keywords, approved = excluded.approved, updated_by = excluded.updated_by, updated_at = now()`,
          [g.ids, target, m.action, m.useKeywords, m.approved, me.userId],
        );
        mapped++;
      }

      const ids: string[] = [];
      const targets: string[] = [];
      for (const a of file.assignments) {
        const t = idOf.get(a.target);
        if (t) {
          ids.push(a.itemId);
          targets.push(t);
        }
      }
      const { rowCount: assigned } = await c.query(
        `update menu_items i set catalog_category_id = x.cat from unnest($1::uuid[], $2::uuid[]) as x(id, cat)
         where i.id = x.id and ($3 or i.catalog_category_id is null)`,
        [ids, targets, file.overwrite],
      );
      return { categories: file.categories.length, mapped, assigned: assigned ?? 0 };
    });
    await pingMenus();
    return { ...result, ...(await list()) };
  });
}
