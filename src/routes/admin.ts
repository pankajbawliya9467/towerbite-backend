import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { hashPassword } from '../lib/passwords.js';
import { endUserSessions } from '../lib/sessions.js';
import { one, q } from '../db.js';
import { env } from '../env.js';
import { can, noAccess, requireAdmin, type Permission, type Staff } from '../auth.js';
import { devUserId } from '../lib/devId.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertEmailFree } from '../lib/logins.js';
import { selectOrders } from '../lib/sql.js';
import { day, like, paging, uuidOrNull, Where } from '../lib/paging.js';
import { orderWhere, type OrdersQuery } from '../lib/orderFilters.js';
import { cafesChanged } from '../realtime.js';
import { saveImage } from '../lib/upload.js';
import { catalogOn, isLeaf } from '../lib/catalog.js';
import { csv, sendCsv } from './reports.js';

const slug = z.string().trim().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes');
const uuid = z.string().uuid();
const url = z.string().trim().url().max(500).nullable();

type Resource = {
  table: string;
  /** api field → column */
  cols: Record<string, string>;
  shape: ZodRawShape;
  required: string[];
  /** query params allowed as filters (api field names) */
  filters?: string[];
  order: string;
  /** extra checks before insert/update (body is the parsed, partial body; id is set on update) */
  check?: (body: Record<string, unknown>, id?: string) => Promise<void>;
};

const RESOURCES: Record<string, Resource> = {
  locations: {
    table: 'locations',
    cols: { slug: 'slug', name: 'name', area: 'area', city: 'city', isActive: 'is_active' },
    shape: { slug, name: z.string().trim().min(2).max(80), area: z.string().trim().max(80), city: z.string().trim().max(60), isActive: z.boolean() },
    required: ['slug', 'name'],
    order: 'city, name',
  },
  towers: {
    table: 'towers',
    cols: { locationId: 'location_id', name: 'name', sort: 'sort' },
    shape: { locationId: uuid, name: z.string().trim().min(1).max(40), sort: z.number().int() },
    required: ['locationId', 'name'],
    filters: ['locationId'],
    order: 'sort, name',
  },
  cafes: {
    table: 'cafes',
    cols: {
      locationId: 'location_id', slug: 'slug', name: 'name', cuisines: 'cuisines', place: 'place', emoji: 'emoji',
      coverColor: 'cover_color', imageUrl: 'image_url', logoUrl: 'logo_url', phone: 'phone', rating: 'rating', ratingCount: 'rating_count',
      etaMin: 'eta_min', etaMax: 'eta_max', isOpen: 'is_open', acceptingOrders: 'accepting_orders', tags: 'tags', sort: 'sort',
      isActive: 'is_active', lat: 'lat', lng: 'lng', geoRadiusM: 'geo_radius_m', geoCheck: 'geo_check',
    },
    shape: {
      locationId: uuid, slug, name: z.string().trim().min(2).max(80), cuisines: z.string().trim().max(120),
      place: z.string().trim().max(80), emoji: z.string().trim().max(8), coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      // rating / ratingCount are read-only here: they come only from customers' ratings.
      imageUrl: url, logoUrl: url, phone: z.string().trim().max(20).nullable(), etaMin: z.number().int().min(1).max(120), etaMax: z.number().int().min(1).max(180),
      isOpen: z.boolean(), acceptingOrders: z.boolean(), tags: z.array(z.string().trim().toLowerCase().max(20)).max(10),
      sort: z.number().int(), isActive: z.boolean(),
      lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable(),
      geoRadiusM: z.number().int().min(50).max(2000), geoCheck: z.boolean(),
    },
    required: ['locationId', 'slug', 'name'],
    filters: ['locationId'],
    order: 'sort, name',
  },
  categories: {
    table: 'categories',
    cols: { cafeId: 'cafe_id', parentId: 'parent_id', name: 'name', sort: 'sort' },
    shape: { cafeId: uuid, parentId: uuid.nullable(), name: z.string().trim().min(1).max(40), sort: z.number().int() },
    required: ['cafeId', 'name'],
    filters: ['cafeId'],
    order: 'sort, name',
    check: checkCategory,
  },
  'menu-items': {
    table: 'menu_items',
    cols: {
      cafeId: 'cafe_id', categoryId: 'category_id', name: 'name', description: 'description', price: 'price', isVeg: 'is_veg',
      emoji: 'emoji', imageUrl: 'image_url', isAvailable: 'is_available', isPopular: 'is_popular', sort: 'sort',
      isActive: 'is_active', catalogCategoryId: 'catalog_category_id',
    },
    shape: {
      cafeId: uuid, categoryId: uuid.nullable(), catalogCategoryId: uuid.nullable(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(160),
      price: z.number().int().min(0).max(100000), isVeg: z.boolean(), emoji: z.string().trim().max(8), imageUrl: url,
      isAvailable: z.boolean(), isPopular: z.boolean(), sort: z.number().int(), isActive: z.boolean(),
    },
    required: ['cafeId', 'name', 'price'],
    filters: ['cafeId', 'categoryId'],
    order: 'sort, name',
    check: checkItemCategory,
  },
};

/** A sub-category must sit under a top-level category of the same cafe (one level only). */
async function checkCategory(body: Record<string, unknown>, id?: string) {
  if (body.cafeId !== undefined && id) throw badRequest('A category cannot move to another cafe');
  const parentId = body.parentId as string | null | undefined;
  if (!parentId) return;
  if (parentId === id) throw badRequest('A category cannot be inside itself');
  const cafeId = (body.cafeId as string | undefined) ?? (await one<{ cafe_id: string }>(`select cafe_id from categories where id = $1`, [id]))?.cafe_id;
  const parent = await one<{ cafe_id: string; parent_id: string | null }>(`select cafe_id, parent_id from categories where id = $1`, [parentId]);
  if (!parent || parent.cafe_id !== cafeId) throw badRequest('Parent category not found in this cafe');
  if (parent.parent_id) throw badRequest('Pick a main category as the parent (sub-categories cannot have their own sub-categories)');
  if (id && (await one(`select 1 from categories where parent_id = $1 limit 1`, [id]))) {
    throw badRequest('This category has sub-categories, so it cannot become a sub-category');
  }
}

/**
 * An item's own (old) category must belong to the item's cafe. Its global category must be one a product may
 * sit in (a sub-category, or a main category without sub-categories); once menus use the global categories,
 * every product needs one.
 */
async function checkItemCategory(body: Record<string, unknown>, id?: string) {
  const categoryId = body.categoryId as string | null | undefined;
  if (body.cafeId !== undefined && id) throw badRequest('An item cannot move to another cafe');
  const catalogId = body.catalogCategoryId as string | null | undefined;
  if (catalogId) {
    const leaf = await isLeaf(catalogId);
    if (leaf === null) throw badRequest('Category not found');
    if (!leaf) throw badRequest('Pick a sub-category for this product');
  } else if (await catalogOn()) {
    if (!id && !catalogId) throw badRequest('Pick a category for this product');
    if (id && catalogId === null) throw badRequest('A product needs a category');
  }
  if (!categoryId) return;
  const cafeId = (body.cafeId as string | undefined) ?? (await one<{ cafe_id: string }>(`select cafe_id from menu_items where id = $1`, [id]))?.cafe_id;
  const cat = await one(`select 1 from categories where id = $1 and cafe_id = $2`, [categoryId, cafeId]);
  if (!cat) throw badRequest('Category not found in this cafe');
}

/** The location a row belongs to, so open apps/websites there can be told to re-load. */
async function locationOf(name: string, id: string): Promise<string | null> {
  const sql: Record<string, string> = {
    locations: `select id as loc from locations where id = $1`,
    towers: `select location_id as loc from towers where id = $1`,
    cafes: `select location_id as loc from cafes where id = $1`,
    categories: `select c.location_id as loc from categories x join cafes c on c.id = x.cafe_id where x.id = $1`,
    'menu-items': `select c.location_id as loc from menu_items x join cafes c on c.id = x.cafe_id where x.id = $1`,
  };
  return (await one<{ loc: string }>(sql[name], [id]).catch(() => undefined))?.loc ?? null;
}

function selectList(r: Resource) {
  const fields = Object.entries(r.cols).map(([k, c]) => (c === 'rating' ? `${c}::float as "${k}"` : `${c} as "${k}"`));
  return `id, ${fields.join(', ')}`;
}

/** Which admin section manages each resource. */
const SECTION: Record<string, 'locations' | 'cafes' | 'menu'> = {
  locations: 'locations', towers: 'locations', cafes: 'cafes', categories: 'menu', 'menu-items': 'menu',
};
/** Fields that need their own tick to be changed (all other fields need `<section>.edit`). */
const FIELD_PERM: Record<string, Record<string, Permission>> = {
  cafes: {
    isActive: 'cafes.delete', isOpen: 'cafes.openclose', acceptingOrders: 'cafes.openclose',
    lat: 'locations.geo', lng: 'locations.geo', geoRadiusM: 'locations.geo', geoCheck: 'locations.geo',
  },
  'menu-items': { price: 'menu.price', isAvailable: 'menu.soldout', isActive: 'menu.delete' },
  locations: { isActive: 'locations.delete' },
};
/** Same value? (forms send every field; only real changes are checked). Numbers from numeric columns come as text. */
const norm = (v: unknown) =>
  v == null ? null : typeof v === 'object' ? JSON.stringify(v) : /^-?\d+(\.\d+)?$/.test(String(v)) ? Number(v) : String(v);

export async function adminRoutes(app: FastifyInstance) {
  for (const [name, r] of Object.entries(RESOURCES)) {
    const sec = SECTION[name];
    const full = z.object(r.shape);
    const partial = full.partial();

    // Lists are readable by any admin (other sections need them for filters and pickers); changes need the section.
    app.get<{ Querystring: Record<string, string> }>(`/v1/admin/${name}`, async (req) => {
      await requireAdmin(req);
      const params: unknown[] = [];
      const where: string[] = [];
      for (const f of r.filters ?? []) {
        const v = req.query[f];
        if (v) {
          params.push(uuid.parse(v));
          where.push(`${r.cols[f]} = $${params.length}`);
        }
      }
      return q(
        `select ${selectList(r)} from ${r.table} ${where.length ? `where ${where.join(' and ')}` : ''} order by ${r.order}`,
        params,
      );
    });

    app.get<{ Params: { id: string } }>(`/v1/admin/${name}/:id`, async (req) => {
      await requireAdmin(req);
      const row = await one(`select ${selectList(r)} from ${r.table} where id = $1`, [req.params.id]);
      if (!row) throw notFound();
      return row;
    });

    app.post(`/v1/admin/${name}`, async (req, reply) => {
      const me = await requireAdmin(req, `${sec}.add` as Permission);
      const body = partial.parse(req.body) as Record<string, unknown>;
      if (name === 'cafes' && (body.geoCheck === true || body.lat != null) && !can(me, 'locations.geo')) throw noAccess('locations.geo');
      for (const k of r.required) if (body[k] === undefined) throw badRequest(`${k} is required`);
      await r.check?.(body);
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      const row = await one(
        `insert into ${r.table} (${keys.map((k) => r.cols[k]).join(', ')})
         values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
        keys.map((k) => body[k]),
      );
      await cafesChanged([await locationOf(name, row.id)]);
      reply.code(201);
      return one(`select ${selectList(r)} from ${r.table} where id = $1`, [row.id]);
    });

    app.patch<{ Params: { id: string } }>(`/v1/admin/${name}/:id`, async (req) => {
      const me = await requireAdmin(req);
      const body = partial.parse(req.body) as Record<string, unknown>;
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (!me.isSuper && keys.length) {
        const cur = await one<Record<string, unknown>>(`select ${selectList(r)} from ${r.table} where id = $1`, [req.params.id]);
        if (!cur) throw notFound();
        for (const k of keys) {
          if (norm(cur[k]) === norm(body[k])) continue;
          const need = FIELD_PERM[name]?.[k] ?? (`${sec}.edit` as Permission);
          if (!can(me, need)) throw noAccess(need);
        }
      }
      if (keys.length) {
        await r.check?.(body, req.params.id);
        const before = await locationOf(name, req.params.id);
        const row = await one(
          `update ${r.table} set ${keys.map((k, i) => `${r.cols[k]} = $${i + 2}`).join(', ')} where id = $1 returning id`,
          [req.params.id, ...keys.map((k) => body[k])],
        );
        if (!row) throw notFound();
        await cafesChanged([before, await locationOf(name, req.params.id)]);
      }
      return one(`select ${selectList(r)} from ${r.table} where id = $1`, [req.params.id]);
    });

    app.delete<{ Params: { id: string } }>(`/v1/admin/${name}/:id`, async (req) => {
      await requireAdmin(req, `${sec}.delete` as Permission);
      // A cafe is never deleted (its orders, ratings and reports point to it): it is made inactive instead.
      if (name === 'cafes') throw badRequest('Cafes cannot be deleted. Make the cafe inactive instead.');
      const before = await locationOf(name, req.params.id);
      const row = await one(`delete from ${r.table} where id = $1 returning id`, [req.params.id]);
      if (!row) throw notFound();
      await cafesChanged([before]);
      return { ok: true };
    });
  }

  /**
   * Order of the cafes in one building (app + website list): the ids from top to bottom. Open cafes still
   * show before closed ones; within each group this order is used.
   */
  app.put<{ Params: { id: string } }>('/v1/admin/locations/:id/cafe-order', async (req) => {
    await requireAdmin(req, 'cafes.order');
    const loc = uuid.parse(req.params.id);
    const { cafeIds } = z.object({ cafeIds: z.array(uuid).min(1).max(500) }).parse(req.body);
    if (new Set(cafeIds).size !== cafeIds.length) throw badRequest('A cafe is listed twice');
    const rows = await q<{ id: string }>(
      `update cafes c set sort = x.pos
       from unnest($2::uuid[]) with ordinality as x(id, pos)
       where c.id = x.id and c.location_id = $1
       returning c.id`,
      [loc, cafeIds],
    );
    if (rows.length !== cafeIds.length) throw badRequest('Some of these cafes are not in this building');
    await cafesChanged([loc]);
    return { ok: true };
  });

  // ---- Cafe logins (staff). Admins live in their own table: routes/admins.ts ----
  app.get('/v1/admin/staff', async (req) => {
    await requireAdmin(req, 'cafes.logins');
    return q(
      `select s.user_id as "userId", s.role, s.cafe_id as "cafeId", s.name, s.email, s.created_at as "createdAt",
         s.password_set_at as "passwordSetAt", c.name as "cafeName",
         (select count(*)::int from sessions x where x.user_id = s.user_id and x.expires_at > now()) as "activeLogins"
       from staff s left join cafes c on c.id = s.cafe_id where s.role = 'cafe_staff' order by c.name, s.name`,
    );
  });

  app.post('/v1/admin/staff', async (req, reply) => {
    await requireAdmin(req, 'cafes.logins');
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        email: z.string().trim().toLowerCase().email().max(200),
        password: z.string().min(8).max(72),
        cafeId: uuid,
      })
      .parse(req.body);
    await assertEmailFree(body.email);
    if (!(await one(`select 1 from cafes where id = $1`, [body.cafeId]))) throw badRequest('Cafe not found');
    const userId = env.devAuth ? devUserId(body.email) : randomUUID();
    await q(
      `insert into staff (user_id, role, cafe_id, name, email, password_hash, password_set_at) values ($1, 'cafe_staff', $2, $3, $4, $5, now())`,
      [userId, body.cafeId, body.name, body.email, await hashPassword(body.password)],
    );
    reply.code(201);
    return { userId, role: 'cafe_staff', cafeId: body.cafeId, name: body.name, email: body.email };
  });

  /** Change a cafe login's name / email. Changing the email logs them out everywhere. */
  app.patch<{ Params: { userId: string } }>('/v1/admin/staff/:userId', async (req) => {
    await requireAdmin(req, 'cafes.logins');
    const id = uuid.parse(req.params.userId);
    const body = z
      .object({ name: z.string().trim().min(1).max(80).optional(), email: z.string().trim().toLowerCase().email().max(200).optional() })
      .parse(req.body);
    const cur = await one<{ email: string | null }>(`select email from staff where user_id = $1 and role = 'cafe_staff'`, [id]);
    if (!cur) throw notFound();
    const emailChanged = !!body.email && body.email !== (cur.email ?? '').toLowerCase();
    if (emailChanged) await assertEmailFree(body.email!, id);
    await q(`update staff set name = coalesce($2, name), email = coalesce($3, email) where user_id = $1`, [id, body.name ?? null, body.email ?? null]);
    if (emailChanged) await endUserSessions(id);
    return { ok: true, loggedOut: emailChanged };
  });

  app.delete<{ Params: { userId: string } }>('/v1/admin/staff/:userId', async (req) => {
    await requireAdmin(req, 'cafes.logins');
    const row = await one(`delete from staff where user_id = $1 and role = 'cafe_staff' returning user_id`, [uuid.parse(req.params.userId)]);
    if (!row) throw notFound();
    await endUserSessions(req.params.userId);
    return { ok: true };
  });

  /** New password for a cafe login (forgotten password). Logs them out everywhere. */
  app.post<{ Params: { userId: string } }>('/v1/admin/staff/:userId/password', async (req) => {
    await requireAdmin(req, 'cafes.logins');
    const { password } = z.object({ password: z.string().min(8).max(72) }).parse(req.body);
    const row = await one(
      `update staff set password_hash = $2, password_set_at = now() where user_id = $1 and role = 'cafe_staff' returning user_id`,
      [uuid.parse(req.params.userId), await hashPassword(password)],
    );
    if (!row) throw notFound();
    await endUserSessions(req.params.userId);
    return { ok: true };
  });

  // ---- Orders, users, stats ----
  async function adminOrders(qs: OrdersQuery, me: Staff, max: number) {
    const w = orderWhere(qs, can(me, 'orders.phone'));
    const limit = Math.min(Number(qs.limit) || 100, max);
    return selectOrders(w.sql, w.params, `order by o.created_at desc limit ${limit}`);
  }
  /** Without the "customer phone" tick the customer's and rider's numbers are hidden. */
  const maskOrder = (me: Staff) => (o: Record<string, unknown>) =>
    can(me, 'orders.phone') ? o : { ...o, customerPhone: null, riderPhone: null };

  /** Without `page` (the dashboard): the latest orders as a list. With `page`: one page plus the total. */
  app.get<{ Querystring: OrdersQuery }>('/v1/admin/orders', async (req) => {
    const me = await requireAdmin(req, 'orders.view');
    if (req.query.page === undefined) return (await adminOrders(req.query, me, 500)).map(maskOrder(me));
    const pg = paging(req.query);
    const w = orderWhere(req.query, can(me, 'orders.phone'));
    const [count] = await q<{ n: number }>(`select count(*)::int as n from orders o where ${w.sql}`, w.params);
    const rows = await selectOrders(w.sql, w.params, `order by o.created_at desc limit ${pg.limit} offset ${pg.offset}`);
    return { rows: rows.map(maskOrder(me)), total: count.n, page: pg.page, pageSize: pg.pageSize };
  });

  app.get<{ Querystring: OrdersQuery }>('/v1/admin/orders.csv', async (req, reply) => {
    const me = await requireAdmin(req, 'orders.csv');
    const rows = (await adminOrders({ ...req.query, limit: '10000' }, me, 10000)).map(maskOrder(me)) as any[];
    const head = ['Order', 'Date', 'Cafe', 'Customer', 'Phone', 'Address', 'Items', 'Total (₹)', 'Status', 'Payment'];
    return sendCsv(reply, `towerbites_orders_${new Date().toISOString().slice(0, 10)}.csv`, csv([
      head,
      ...rows.map((o) => [
        o.orderNo, new Date(o.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), o.cafe?.name, o.customerName,
        o.customerPhone ?? '', [o.address?.tower, o.address?.floor, o.address?.desk].filter(Boolean).join(', '),
        (o.items ?? []).map((i: any) => `${i.qty}× ${i.name}`).join('; '), o.total, o.status, o.paymentMethod ?? '',
      ]),
    ]));
  });

  type UsersQuery = { locationId?: string; company?: string; from?: string; to?: string; orders?: string; search?: string; page?: string; pageSize?: string };
  /** Customers, newest first: building, company, joined between, with / without orders, search. Paged. */
  app.get<{ Querystring: UsersQuery }>('/v1/admin/users', async (req) => {
    const me = await requireAdmin(req, 'users.view');
    const qs = req.query;
    const phone = can(me, 'users.phone');
    const w = new Where();
    const loc = uuidOrNull(qs.locationId);
    if (loc) w.add('p.location_id = ?', loc);
    if (qs.company?.trim()) w.add('p.company ilike ?', like(qs.company));
    const from = day(qs.from, 'start date');
    const to = day(qs.to, 'end date');
    if (from) w.add(`(p.created_at at time zone 'Asia/Kolkata')::date >= ?::date`, from);
    if (to) w.add(`(p.created_at at time zone 'Asia/Kolkata')::date <= ?::date`, to);
    if (qs.orders === 'yes') w.add('exists (select 1 from orders o where o.user_id = p.id)');
    if (qs.orders === 'no') w.add('not exists (select 1 from orders o where o.user_id = p.id)');
    if (qs.search?.trim()) {
      if (phone) w.add('(p.name ilike ? or p.phone ilike ? or p.email ilike ?)', like(qs.search), like(qs.search), like(qs.search));
      else w.add('p.name ilike ?', like(qs.search));
    }
    const pg = paging(qs);
    const [count] = await q<{ n: number }>(`select count(*)::int as n from profiles p where ${w.sql}`, w.params);
    const rows = await q(
      `select p.id, p.name, p.phone, p.email, p.company, p.tower, p.floor, p.desk, p.created_at as "createdAt",
         l.name as "locationName",
         (select count(*)::int from orders o where o.user_id = p.id) as "orderCount",
         (select coalesce(sum(total), 0)::int from orders o where o.user_id = p.id and o.status = 'delivered') as "spent"
       from profiles p left join locations l on l.id = p.location_id
       where ${w.sql}
       order by p.created_at desc limit ${w.p(pg.limit)} offset ${w.p(pg.offset)}`,
      w.params,
    );
    return {
      rows: phone ? rows : rows.map((u) => ({ ...u, phone: null, email: null })),
      total: count.n, page: pg.page, pageSize: pg.pageSize,
    };
  });

  app.get('/v1/admin/stats', async (req) => {
    const me = await requireAdmin(req, 'reports.view');
    const money = can(me, 'reports.money');
    const today = `(o.created_at at time zone 'Asia/Kolkata')::date = (now() at time zone 'Asia/Kolkata')::date`;
    const totals = await one(
      `select
         (select count(*)::int from orders o where ${today} and o.status not in ('cancelled','rejected')) as "ordersToday",
         (select coalesce(sum(total),0)::int from orders o where ${today} and o.status = 'delivered') as "salesToday",
         (select count(*)::int from orders o where o.status in ('placed','preparing','out_for_delivery')) as "activeOrders",
         (select count(*)::int from profiles) as "users",
         (select count(*)::int from cafes) as "cafes",
         (select count(*)::int from locations) as "locations"`,
    );
    const byCafe = await q(
      `select c.id, c.name, c.emoji, l.name as "locationName",
         count(o.id) filter (where o.status not in ('cancelled','rejected'))::int as orders,
         coalesce(sum(o.total) filter (where o.status = 'delivered'), 0)::int as sales
       from cafes c join locations l on l.id = c.location_id
       left join orders o on o.cafe_id = c.id and ${today}
       group by c.id, l.name order by orders desc, c.name limit 20`,
    );
    // Without "sales & money" the rupee numbers are left out.
    if (!money) return { ...totals, salesToday: null, byCafe: byCafe.map((c) => ({ ...c, sales: null })) };
    return { ...totals, byCafe };
  });

  // ---- Image upload (cafe logos, menu photos) ----
  app.post('/v1/admin/upload', async (req) => {
    await requireAdmin(req, 'cafes.add', 'cafes.edit', 'menu.add', 'menu.edit');
    return saveImage(req, (fields) =>
      z.string().regex(/^[a-z0-9-]{1,60}$/).catch('misc').parse((fields.folder as { value?: unknown } | undefined)?.value));
  });
}
