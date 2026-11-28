import type { FastifyInstance } from 'fastify';
import { q, one } from '../db.js';
import { CAFE_COLS, ITEM_COLS } from '../lib/sql.js';
import { notFound } from '../lib/errors.js';
import { cafeCombos } from '../lib/combos.js';
import { catalogOn, OTHER_CATEGORY } from '../lib/catalog.js';
import { areaCenter, type Area } from '../lib/geo.js';

/**
 * The categories a menu shows. Switch off: the cafe's own categories. Switch on (global categories): only the
 * global categories this cafe has products in, plus their main categories.
 */
function menuCategories(cafeId: string, global: boolean, forCustomers: boolean) {
  if (!global) {
    return q(`select id, name, sort, parent_id as "parentId" from categories where cafe_id = $1 order by sort, name`, [cafeId]);
  }
  return q(
    `with used as (
       select distinct catalog_category_id as id from menu_items
       where cafe_id = $1 and catalog_category_id is not null ${forCustomers ? 'and is_active' : ''}
     )
     select k.id, k.name, k.sort, k.parent_id as "parentId" from catalog_categories k
     where k.id in (select id from used)
        or k.id in (select x.parent_id from catalog_categories x where x.id in (select id from used))
     order by k.sort, k.name`,
    [cafeId],
  );
}

/** `forCustomers`: leave out products the cafe has hidden (the cafe panel and admin see everything). */
export async function cafeWithMenu(cafeId: string, forCustomers = false) {
  const global = await catalogOn();
  // Independent reads in parallel (one round trip to the database instead of several).
  const [cafe, categories, items, combos, likes] = await Promise.all([
    // With the cafe's location: the app and website check the customer is inside its area before ordering.
    one(
      `select ${CAFE_COLS}, l.name as "locationName", l.area_geo as "locationArea", l.outside_allowed as "outsideAllowed"
       from cafes c join locations l on l.id = c.location_id where c.id = $1`,
      [cafeId],
    ),
    menuCategories(cafeId, global, forCustomers),
    q<{ id: string; categoryId: string | null; catalogCategoryId: string | null }>(
      `select ${ITEM_COLS} from menu_items i where i.cafe_id = $1 ${forCustomers ? 'and i.is_active' : ''}
       order by i.sort, i.name`,
      [cafeId],
    ),
    cafeCombos(cafeId, true, forCustomers),
    // "92% liked" from thumbs up/down after delivery (last 90 days)
    q<{ id: string; liked: number; total: number }>(
      `select ri.menu_item_id as id, count(*) filter (where ri.liked)::int as liked, count(*)::int as total
       from rating_items ri join menu_items i on i.id = ri.menu_item_id
       where i.cafe_id = $1 and ri.created_at > now() - interval '90 days' group by 1`,
      [cafeId],
    ),
  ]);
  if (!cafe) throw notFound('Cafe not found');
  const withLikes = items.map((i) => {
    // Global categories: the apps keep reading `categoryId`, so it carries the global one. A product without
    // one yet goes under "More" instead of disappearing from the menu.
    const item = global ? { ...i, categoryId: i.catalogCategoryId ?? OTHER_CATEGORY.id } : i;
    const l = likes.find((x) => x.id === i.id);
    return l && l.total >= 3 ? { ...item, likePct: Math.round((l.liked / l.total) * 100), likeCount: l.total } : item;
  });
  const cats = global && withLikes.some((i) => i.categoryId === OTHER_CATEGORY.id) ? [...categories, OTHER_CATEGORY] : categories;
  return { ...cafe, categories: cats, items: withLikes, combos };
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/v1/health', async () => ({ ok: true }));

  /**
   * Live locations with their drawn area. The app and website find the one the customer is standing in
   * (and how far the others are); `lat`/`lng` is the middle of the area, for the map.
   */
  app.get('/v1/locations', async () => {
    const rows = await q<{ areaGeo: Area | null } & Record<string, unknown>>(
      `select l.id, l.slug, l.name, l.area, l.city, l.area_geo as "areaGeo", l.outside_allowed as "outsideAllowed",
         (select count(*)::int from cafes c where c.location_id = l.id and c.is_active) as "cafeCount"
       from locations l where l.is_active and l.area_geo is not null order by l.city, "cafeCount" desc, l.name`,
    );
    return rows.map((r) => ({ ...r, ...(r.areaGeo && r.areaGeo.length >= 3 ? areaCenter(r.areaGeo) : { lat: null, lng: null }) }));
  });

  app.get<{ Params: { slug: string } }>('/v1/locations/:slug', async (req) => {
    const loc = await one(
      `select l.id, l.slug, l.name, l.area, l.city from locations l where l.slug = $1 and l.is_active`,
      [req.params.slug],
    );
    if (!loc) throw notFound('Location not found');
    const towers = await q(`select id, name from towers where location_id = $1 order by sort, name`, [loc.id]);
    return { ...loc, towers };
  });

  app.get<{ Params: { slug: string }; Querystring: { tag?: string; search?: string } }>(
    '/v1/locations/:slug/cafes',
    async (req) => {
      const { tag, search } = req.query;
      const params: unknown[] = [req.params.slug];
      let extra = '';
      if (tag && tag !== 'all') {
        params.push(tag.toLowerCase());
        extra += ` and $${params.length} = any(c.tags)`;
      }
      if (search?.trim()) {
        params.push(`%${search.trim()}%`);
        const p = `$${params.length}`;
        extra += ` and (c.name ilike ${p} or c.cuisines ilike ${p}
          or exists (select 1 from menu_items i where i.cafe_id = c.id and i.is_active and i.name ilike ${p}))`;
      }
      return q(
        `select ${CAFE_COLS} from cafes c join locations l on l.id = c.location_id
         where l.slug = $1 and c.is_active ${extra} order by c.is_open desc, c.sort, c.name`,
        params,
      );
    },
  );

  app.get<{ Params: { slug: string } }>('/v1/locations/:slug/popular', async (req) =>
    q(
      `select ${ITEM_COLS}, json_build_object('id', c.id, 'slug', c.slug, 'name', c.name) as cafe
       from menu_items i join cafes c on c.id = i.cafe_id join locations l on l.id = c.location_id
       where l.slug = $1 and c.is_active and i.is_active and i.is_popular and i.is_available and c.is_open
       order by c.sort, i.sort limit 8`,
      [req.params.slug],
    ),
  );

  app.get<{ Params: { slug: string; cafeSlug: string } }>('/v1/locations/:slug/cafes/:cafeSlug', async (req) => {
    const row = await one<{ id: string }>(
      `select c.id from cafes c join locations l on l.id = c.location_id where l.slug = $1 and c.slug = $2 and c.is_active`,
      [req.params.slug, req.params.cafeSlug],
    );
    if (!row) throw notFound('Cafe not found');
    return cafeWithMenu(row.id, true);
  });

  app.get<{ Params: { id: string } }>('/v1/cafes/:id', async (req) => {
    const menu = await cafeWithMenu(req.params.id, true);
    if (!(menu as { isActive?: boolean }).isActive) throw notFound('Cafe not found'); // inactive: hidden from customers
    return menu;
  });

  /** Search box: matching dishes (with their cafe) and matching cafes in one location. */
  app.get<{ Params: { slug: string }; Querystring: { q?: string; veg?: string; maxPrice?: string } }>(
    '/v1/locations/:slug/search',
    async (req) => {
      const term = (req.query.q ?? '').trim().slice(0, 60);
      if (term.length < 2) return { dishes: [], cafes: [] };
      const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      const params: unknown[] = [req.params.slug, like];
      let extra = '';
      if (req.query.veg === 'true') extra += ' and i.is_veg';
      const maxPrice = Number(req.query.maxPrice);
      if (Number.isFinite(maxPrice) && maxPrice > 0) {
        params.push(Math.floor(maxPrice));
        extra += ` and i.price <= $${params.length}`;
      }
      const [dishes, cafes] = await Promise.all([
        q(
          `select ${ITEM_COLS}, json_build_object('id', c.id, 'slug', c.slug, 'name', c.name, 'etaMin', c.eta_min, 'etaMax', c.eta_max,
             'coverColor', c.cover_color, 'isOpen', c.is_open, 'acceptingOrders', c.accepting_orders) as cafe
           from menu_items i join cafes c on c.id = i.cafe_id join locations l on l.id = c.location_id
           where l.slug = $1 and c.is_active and i.is_active and (i.name ilike $2 or i.description ilike $2) ${extra}
           order by (c.is_open and c.accepting_orders) desc, i.is_available desc, i.is_popular desc, i.name limit 30`,
          params,
        ),
        q(
          `select ${CAFE_COLS} from cafes c join locations l on l.id = c.location_id
           where l.slug = $1 and c.is_active and (c.name ilike $2 or c.cuisines ilike $2) order by c.is_open desc, c.sort, c.name limit 10`,
          [req.params.slug, like],
        ),
      ]);
      return { dishes, cafes };
    },
  );
}
