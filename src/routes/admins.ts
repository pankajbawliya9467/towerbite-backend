import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { one, q } from '../db.js';
import { env } from '../env.js';
import { PERMISSIONS, can, noAccess, normalizePerms, requireAdmin, type Staff } from '../auth.js';
import { devUserId } from '../lib/devId.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { assertEmailFree } from '../lib/logins.js';
import { hashPassword } from '../lib/passwords.js';
import { endUserSessions } from '../lib/sessions.js';
import { resetTwoFactor } from '../lib/twoFactor.js';

/**
 * People who run the admin panel. A super admin can do everything; other admins only the sections in
 * `permissions`. Only a super admin can create or change another super admin, and an admin can't give
 * access they don't have themselves. Admins are switched off, never deleted (their history stays).
 */
const Perms = z
  .array(z.string().refine((p) => (PERMISSIONS as string[]).includes(p), 'Unknown permission'))
  .max(PERMISSIONS.length)
  .transform(normalizePerms);
const COLS = `id, name, email, is_super as "isSuper", permissions, is_active as "isActive",
  created_at as "createdAt", password_set_at as "passwordSetAt", totp_enabled_at is not null as "twoFactor",
  (select count(*)::int from sessions s where s.user_id = admins.id and s.expires_at > now()) as "activeLogins"`;

function checkGrant(me: Staff, perms: string[], isSuper: boolean) {
  if (me.isSuper) return;
  if (isSuper) throw forbidden('Only a super admin can make a super admin');
  const extra = perms.filter((p) => !me.permissions.includes(p as never));
  if (extra.length) throw forbidden(`You can't give access you don't have: ${extra.join(', ')}`);
}

async function target(me: Staff, id: string) {
  const row = await one<{ id: string; is_super: boolean; email: string; permissions: string[] }>(
    `select id, is_super, email, permissions from admins where id = $1`, [id]);
  if (!row) throw notFound();
  if (row.is_super && !me.isSuper) throw forbidden('Only a super admin can change a super admin');
  // Nobody may change (password, email, access, on/off) an admin who can do things they can't do themselves:
  // otherwise resetting that admin's password would hand over their extra access.
  if (!me.isSuper && row.id !== me.userId) {
    const extra = row.permissions.filter((p) => !me.permissions.includes(p as never));
    if (extra.length) throw forbidden(`This admin has access you don't have (${extra.slice(0, 3).join(', ')}). Ask a super admin.`);
  }
  return row;
}

const activeSupers = async () => (await one<{ n: number }>(`select count(*)::int as n from admins where is_super and is_active`))!.n;

export async function adminsRoutes(app: FastifyInstance) {
  app.get('/v1/admin/admins', async (req) => {
    await requireAdmin(req, 'admins.view');
    return q(`select ${COLS} from admins order by is_active desc, is_super desc, name`);
  });

  app.post('/v1/admin/admins', async (req, reply) => {
    const me = await requireAdmin(req, 'admins.add');
    const body = z
      .object({
        name: z.string().trim().min(1).max(80),
        email: z.string().trim().toLowerCase().email().max(200),
        password: z.string().min(8).max(72),
        isSuper: z.boolean().default(false),
        permissions: Perms.default([]),
      })
      .parse(req.body);
    checkGrant(me, body.permissions, body.isSuper);
    if (!body.isSuper && !body.permissions.length) throw badRequest('Tick at least one section this admin can manage');
    await assertEmailFree(body.email);
    const id = env.devAuth ? devUserId(body.email) : randomUUID();
    await q(
      `insert into admins (id, name, email, password_hash, password_set_at, is_super, permissions, created_by)
       values ($1, $2, $3, $4, now(), $5, $6, $7)`,
      [id, body.name, body.email, await hashPassword(body.password), body.isSuper, body.isSuper ? [] : body.permissions, me.userId],
    );
    reply.code(201);
    return one(`select ${COLS} from admins where id = $1`, [id]);
  });

  app.patch<{ Params: { id: string } }>('/v1/admin/admins/:id', async (req) => {
    const me = await requireAdmin(req, 'admins.edit', 'admins.delete');
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        email: z.string().trim().toLowerCase().email().max(200).optional(),
        isSuper: z.boolean().optional(),
        permissions: Perms.optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    const cur = await target(me, id);
    const self = id === me.userId;
    if (body.isActive !== undefined && !can(me, 'admins.delete')) throw noAccess('admins.delete');
    if ((body.name ?? body.email ?? body.permissions ?? body.isSuper) !== undefined && !can(me, 'admins.edit')) throw noAccess('admins.edit');
    if (self && (body.isActive === false || body.permissions !== undefined || body.isSuper !== undefined)) {
      throw badRequest("You can't change your own access. Ask another admin.");
    }
    if (body.permissions !== undefined || body.isSuper !== undefined) {
      checkGrant(me, body.permissions ?? [], body.isSuper ?? false);
    }
    if (cur.is_super && (body.isSuper === false || body.isActive === false) && (await activeSupers()) <= 1) {
      throw badRequest('Keep at least one active super admin');
    }
    const emailChanged = !!body.email && body.email !== cur.email.toLowerCase();
    if (emailChanged) await assertEmailFree(body.email!, id);
    const isSuper = body.isSuper ?? cur.is_super;
    // Sections the editor doesn't have themselves stay as they were.
    if (body.permissions && !me.isSuper) {
      body.permissions = [...new Set([...body.permissions, ...cur.permissions.filter((p) => !me.permissions.includes(p as never))])] as never;
    }
    if (!isSuper && body.permissions !== undefined && !body.permissions.length) throw badRequest('Tick at least one section');
    await q(
      `update admins set name = coalesce($2, name), email = coalesce($3, email), is_super = $4,
         permissions = case when $4 then '{}' else coalesce($5, permissions) end, is_active = coalesce($6, is_active)
       where id = $1`,
      [id, body.name ?? null, body.email ?? null, isSuper, body.permissions ?? null, body.isActive ?? null],
    );
    if (emailChanged || body.isActive === false) await endUserSessions(id);
    return one(`select ${COLS} from admins where id = $1`, [id]);
  });

  /** New password for an admin (forgotten password). Logs them out everywhere. */
  app.post<{ Params: { id: string } }>('/v1/admin/admins/:id/password', async (req) => {
    const me = await requireAdmin(req, 'admins.edit');
    const id = z.string().uuid().parse(req.params.id);
    const { password } = z.object({ password: z.string().min(8).max(72) }).parse(req.body);
    await target(me, id);
    await q(`update admins set password_hash = $2, password_set_at = now() where id = $1`, [id, await hashPassword(password)]);
    await endUserSessions(id);
    return { ok: true };
  });

  /**
   * Lost phone: turns off this admin's 2-step login and logs them out everywhere. At their next login they scan a
   * new QR code. Not for yourself (another admin must do it), and the usual "can't change someone with more access" rule applies.
   */
  app.post<{ Params: { id: string } }>('/v1/admin/admins/:id/2fa/reset', async (req) => {
    const me = await requireAdmin(req, 'admins.edit');
    const id = z.string().uuid().parse(req.params.id);
    if (id === me.userId) throw badRequest("You can't reset your own 2-step login. Ask another admin.");
    await target(me, id);
    await resetTwoFactor(id);
    await endUserSessions(id);
    return { ok: true };
  });
}
