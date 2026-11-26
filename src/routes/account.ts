import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { requireAdmin, userFromBearer } from '../auth.js';
import { notFound, tooMany } from '../lib/errors.js';

const Request = z.object({
  /** Indian mobile number, with or without +91 */
  phone: z.string().trim().transform((s) => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^(\+?91)?[6-9]\d{9}$/, 'Enter your 10-digit mobile number')),
  name: z.string().trim().max(80).default(''),
  kind: z.enum(['delete_account', 'delete_data']).default('delete_account'),
  reason: z.string().trim().max(500).default(''),
});

/**
 * Account / data deletion requests (public form on the website, linked from the app and Play Store).
 * The answer is the same whether or not the number has an account, so the form can't be used to find
 * out who uses TowerBites. Nothing is deleted here: an admin handles each request from the CRM.
 */
export async function accountRoutes(app: FastifyInstance) {
  app.post('/v1/account/requests', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const body = Request.parse(req.body);
    const phone = `+91${body.phone.slice(-10)}`;
    // Proven only when the request comes from someone logged in with this number (anyone can type a number).
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const user = token ? await userFromBearer(token).catch(() => null) : null;
    const verified = !!user?.phone && user.phone === phone;
    const open = await one<{ n: number }>(
      `select count(*)::int as n from account_requests where phone = $1 and status = 'pending'`,
      [phone],
    );
    if ((open?.n ?? 0) >= 3) throw tooMany('We already have your request. We will get back to you soon.');
    await q(`insert into account_requests (phone, name, kind, reason, verified) values ($1, $2, $3, $4, $5)`, [phone, body.name, body.kind, body.reason, verified]);
    return { ok: true, message: 'Request received. We will process it within 30 days and confirm on your phone number.' };
  });

  app.get<{ Querystring: { status?: string } }>('/v1/admin/account-requests', async (req) => {
    await requireAdmin(req, 'requests.view');
    const status = ['pending', 'done', 'rejected'].includes(req.query.status ?? '') ? req.query.status : null;
    return q(
      `select r.id, r.phone, r.name, r.kind, r.reason, r.status, r.note, r.verified, r.created_at as "createdAt", r.handled_at as "handledAt",
         exists (select 1 from profiles p where p.phone = r.phone) as "hasAccount"
       from account_requests r where ($1::text is null or r.status = $1) order by r.created_at desc limit 200`,
      [status],
    );
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/account-requests/:id', async (req) => {
    await requireAdmin(req, 'requests.edit');
    z.string().uuid().parse(req.params.id);
    const body = z.object({ status: z.enum(['pending', 'done', 'rejected']), note: z.string().trim().max(300).default('') }).parse(req.body);
    const row = await one(
      `update account_requests set status = $2, note = $3, handled_at = case when $2 = 'pending' then null else now() end
       where id = $1 returning id`,
      [req.params.id, body.status, body.note],
    );
    if (!row) throw notFound('Request not found');
    return { ok: true };
  });
}
