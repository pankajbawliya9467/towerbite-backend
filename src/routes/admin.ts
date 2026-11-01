import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z, type ZodRawShape } from 'zod';
import { one, q } from '../db.js';
import { env, supabaseConfigured } from '../env.js';
import { requireAdmin } from '../auth.js';
import { supabase } from '../supabase.js';
import { devUserId } from '../lib/devId.js';
import { badRequest, notFound } from '../lib/errors.js';
import { selectOrders } from '../lib/sql.js';
import { cafesChanged } from '../realtime.js';

/** Checks the file's first bytes, so a renamed script or HTML file can't be uploaded as an "image". */
function isImage(b: Buffer) {
  const hex = b.subarray(0, 12).toString('hex');
  return hex.startsWith('89504e47') // png
    || hex.startsWith('ffd8ff') // jpg
    || hex.startsWith('47494638') // gif
    || (hex.startsWith('52494646') && b.subarray(8, 12).toString() === 'WEBP');
}

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
    },
    shape: {
      locationId: uuid, slug, name: z.string().trim().min(2).max(80), cuisines: z.string().trim().max(120),
      place: z.string().trim().max(80), emoji: z.string().trim().max(8), coverColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      imageUrl: url, logoUrl: url, phone: z.string().trim().max(20).nullable(), rating: z.number().min(0).max(5),
      ratingCount: z.number().int().min(0), etaMin: z.number().int().min(1).max(120), etaMax: z.number().int().min(1).max(180),
      isOpen: z.boolean(), acceptingOrders: z.boolean(), tags: z.array(z.string().trim().toLowerCase().max(20)).max(10),
      sort: z.number().int(),
    },
    required: ['locationId', 'slug', 'name'],
    filters: ['locationId'],
    order: 'sort, name',
  },
  categories: {
    table: 'categories',
    cols: { cafeId: 'cafe_id', name: 'name', sort: 'sort' },
    shape: { cafeId: uuid, name: z.string().trim().min(1).max(40), sort: z.number().int() },
    required: ['cafeId', 'name'],
    filters: ['cafeId'],
    order: 'sort, name',
  },
  'menu-items': {
    table: 'menu_items',
    cols: {
      cafeId: 'cafe_id', categoryId: 'category_id', name: 'name', description: 'description', price: 'price', isVeg: 'is_veg',
      emoji: 'emoji', imageUrl: 'image_url', isAvailable: 'is_available', isPopular: 'is_popular', sort: 'sort',
    },
    shape: {
      cafeId: uuid, categoryId: uuid.nullable(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(160),
      price: z.number().int().min(0).max(100000), isVeg: z.boolean(), emoji: z.string().trim().max(8), imageUrl: url,
      isAvailable: z.boolean(), isPopular: z.boolean(), sort: z.number().int(),
    },
    required: ['cafeId', 'name', 'price'],
    filters: ['cafeId', 'categoryId'],
    order: 'sort, name',
  },
};

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

export async function adminRoutes(app: FastifyInstance) {
  for (const [name, r] of Object.entries(RESOURCES)) {
    const full = z.object(r.shape);
    const partial = full.partial();

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
      await requireAdmin(req);
      const body = partial.parse(req.body) as Record<string, unknown>;
      for (const k of r.required) if (body[k] === undefined) throw badRequest(`${k} is required`);
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
      await requireAdmin(req);
      const body = partial.parse(req.body) as Record<string, unknown>;
      const keys = Object.keys(body).filter((k) => body[k] !== undefined);
      if (keys.length) {
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
      await requireAdmin(req);
      const before = await locationOf(name, req.params.id);
      const row = await one(`delete from ${r.table} where id = $1 returning id`, [req.params.id]);
      if (!row) throw notFound();
      await cafesChanged([before]);
      return { ok: true };
    });
  }

  // ---- Staff (cafe logins and admins) ----
  app.get('/v1/admin/staff', async (req) => {
    await requireAdmin(req);
    return q(
      `select s.user_id as "userId", s.role, s.cafe_id as "cafeId", s.name, s.email, s.created_at as "createdAt",
         c.name as "cafeName"
       from staff s left join cafes c on c.id = s.cafe_id order by s.role desc, c.name, s.name`,
    );
  });

  app.post('/v1/admin/staff', async (req, reply) => {
    await requireAdmin(req);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        email: z.string().trim().toLowerCase().email(),
        password: z.string().min(8).max(72),
        role: z.enum(['cafe_staff', 'super_admin']).default('cafe_staff'),
        cafeId: uuid.nullable().optional(),
      })
      .parse(req.body);
    if (body.role === 'cafe_staff' && !body.cafeId) throw badRequest('Pick the cafe for this login');

    let userId: string;
    if (supabaseConfigured()) {
      const { data, error } = await supabase().auth.admin.createUser({
        email: body.email,
        password: body.password,
        email_confirm: true,
        user_metadata: { name: body.name },
      });
      if (error || !data.user?.id) throw badRequest(error?.message ?? 'Could not create login');
      userId = data.user.id;
    } else if (env.devAuth) {
      userId = devUserId(body.email);
    } else {
      throw badRequest('Supabase is not configured');
    }

    await q(
      `insert into staff (user_id, role, cafe_id, name, email) values ($1, $2, $3, $4, $5)
       on conflict (user_id) do update set role = excluded.role, cafe_id = excluded.cafe_id, name = excluded.name`,
      [userId, body.role, body.role === 'cafe_staff' ? body.cafeId : null, body.name, body.email],
    );
    reply.code(201);
    return { userId, ...body, password: undefined };
  });

  app.delete<{ Params: { userId: string } }>('/v1/admin/staff/:userId', async (req) => {
    const me = await requireAdmin(req);
    if (me.userId === req.params.userId) throw badRequest('You cannot remove your own admin access');
    const row = await one(`delete from staff where user_id = $1 returning user_id`, [req.params.userId]);
    if (!row) throw notFound();
    if (supabaseConfigured()) await supabase().auth.admin.deleteUser(req.params.userId).catch(() => undefined);
    return { ok: true };
  });

  // ---- Orders, users, stats ----
  app.get<{ Querystring: { locationId?: string; cafeId?: string; status?: string; limit?: string } }>(
    '/v1/admin/orders',
    async (req) => {
      await requireAdmin(req);
      const params: unknown[] = [];
      const where = ['true'];
      if (req.query.locationId) {
        params.push(uuid.parse(req.query.locationId));
        where.push(`o.location_id = $${params.length}`);
      }
      if (req.query.cafeId) {
        params.push(uuid.parse(req.query.cafeId));
        where.push(`o.cafe_id = $${params.length}`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        where.push(`o.status = $${params.length}`);
      }
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      return selectOrders(where.join(' and '), params, `order by o.created_at desc limit ${limit}`);
    },
  );

  app.get('/v1/admin/users', async (req) => {
    await requireAdmin(req);
    return q(
      `select p.id, p.name, p.phone, p.email, p.company, p.tower, p.floor, p.desk, p.created_at as "createdAt",
         l.name as "locationName",
         (select count(*)::int from orders o where o.user_id = p.id) as "orderCount",
         (select coalesce(sum(total), 0)::int from orders o where o.user_id = p.id and o.status = 'delivered') as "spent"
       from profiles p left join locations l on l.id = p.location_id
       order by p.created_at desc limit 500`,
    );
  });

  app.get('/v1/admin/stats', async (req) => {
    await requireAdmin(req);
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
    return { ...totals, byCafe };
  });

  // ---- Image upload to Supabase Storage ----
  app.post('/v1/admin/upload', async (req) => {
    await requireAdmin(req);
    if (!supabaseConfigured()) throw badRequest('Add your Supabase keys to upload images');
    const file = await req.file();
    if (!file) throw badRequest('No file');
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) throw badRequest('Upload a PNG, JPG or WebP image');
    const buf = await file.toBuffer();
    if (!isImage(buf)) throw badRequest('That file is not a real image');
    const ext = file.mimetype.split('/')[1].replace('jpeg', 'jpg');
    const folder = z.string().regex(/^[a-z0-9-]{1,60}$/).catch('misc').parse((file.fields as any)?.folder?.value);
    const path = `${folder}/${randomUUID()}.${ext}`;
    const { error } = await supabase().storage.from(env.bucket).upload(path, buf, { contentType: file.mimetype, upsert: false });
    if (error) throw badRequest(error.message);
    const { data } = supabase().storage.from(env.bucket).getPublicUrl(path);
    return { url: data.publicUrl, path };
  });
}
