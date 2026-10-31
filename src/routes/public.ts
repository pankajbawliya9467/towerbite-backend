import type { FastifyInstance } from 'fastify';
import { q, one } from '../db.js';
import { CAFE_COLS, ITEM_COLS } from '../lib/sql.js';
import { notFound } from '../lib/errors.js';

export async function cafeWithMenu(cafeId: string, includeUnavailable = true) {
  // Three independent reads in parallel (one round trip to the database instead of three).
  const [cafe, categories, items] = await Promise.all([
    one(`select ${CAFE_COLS} from cafes c where c.id = $1`, [cafeId]),
    q(`select id, name, sort from categories where cafe_id = $1 order by sort, name`, [cafeId]),
    q(
      `select ${ITEM_COLS} from menu_items i where i.cafe_id = $1 ${includeUnavailable ? '' : 'and i.is_available'}
       order by i.sort, i.name`,
      [cafeId],
    ),
  ]);
  if (!cafe) throw notFound('Cafe not found');
  return { ...cafe, categories, items };
}

export async function publicRoutes(app: FastifyInstance) {
  app.get('/v1/health', async () => ({ ok: true }));

  app.get('/v1/locations', async () =>
    q(`select l.id, l.slug, l.name, l.area, l.city,
         (select count(*)::int from cafes c where c.location_id = l.id) as "cafeCount"
       from locations l where l.is_active order by l.city, "cafeCount" desc, l.name`),
  );

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
          or exists (select 1 from menu_items i where i.cafe_id = c.id and i.name ilike ${p}))`;
      }
      return q(
        `select ${CAFE_COLS} from cafes c join locations l on l.id = c.location_id
         where l.slug = $1 ${extra} order by c.is_open desc, c.sort, c.name`,
        params,
      );
    },
  );

  app.get<{ Params: { slug: string } }>('/v1/locations/:slug/popular', async (req) =>
    q(
      `select ${ITEM_COLS}, json_build_object('id', c.id, 'slug', c.slug, 'name', c.name) as cafe
       from menu_items i join cafes c on c.id = i.cafe_id join locations l on l.id = c.location_id
       where l.slug = $1 and i.is_popular and i.is_available and c.is_open
       order by c.sort, i.sort limit 8`,
      [req.params.slug],
    ),
  );

  app.get<{ Params: { slug: string; cafeSlug: string } }>('/v1/locations/:slug/cafes/:cafeSlug', async (req) => {
    const row = await one<{ id: string }>(
      `select c.id from cafes c join locations l on l.id = c.location_id where l.slug = $1 and c.slug = $2`,
      [req.params.slug, req.params.cafeSlug],
    );
    if (!row) throw notFound('Cafe not found');
    return cafeWithMenu(row.id);
  });

  app.get<{ Params: { id: string } }>('/v1/cafes/:id', async (req) => cafeWithMenu(req.params.id));

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
           where l.slug = $1 and (i.name ilike $2 or i.description ilike $2) ${extra}
           order by (c.is_open and c.accepting_orders) desc, i.is_available desc, i.is_popular desc, i.name limit 30`,
          params,
        ),
        q(
          `select ${CAFE_COLS} from cafes c join locations l on l.id = c.location_id
           where l.slug = $1 and (c.name ilike $2 or c.cuisines ilike $2) order by c.is_open desc, c.sort, c.name limit 10`,
          [req.params.slug, like],
        ),
      ]);
      return { dishes, cafes };
    },
  );
}
