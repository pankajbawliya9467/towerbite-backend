import type { FastifyRequest } from 'fastify';
import { env } from './env.js';
import { one } from './db.js';
import { supabase } from './supabase.js';
import { devUserId } from './lib/devId.js';
import { forbidden, unauthorized } from './lib/errors.js';

export type AuthUser = { id: string; phone: string | null; email: string | null };
export type Staff = { userId: string; role: 'cafe_staff' | 'super_admin'; cafeId: string | null; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

/** Verifies the Supabase access token from `Authorization: Bearer <token>`. */
export async function requireUser(req: FastifyRequest): Promise<AuthUser> {
  if (req.authUser) return req.authUser;
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();

  if (env.devAuth && token.startsWith('dev:')) {
    const ident = token.slice(4).trim();
    if (!ident) throw unauthorized();
    const isEmail = ident.includes('@');
    req.authUser = { id: devUserId(ident), phone: isEmail ? null : ident, email: isEmail ? ident.toLowerCase() : null };
    return req.authUser;
  }

  const { data, error } = await supabase().auth.getUser(token);
  if (error || !data.user) throw unauthorized('Session expired, please log in again');
  req.authUser = {
    id: data.user.id,
    phone: data.user.phone ? `+${data.user.phone.replace(/^\+/, '')}` : null,
    email: data.user.email ?? null,
  };
  return req.authUser;
}

export async function getStaff(userId: string): Promise<Staff | undefined> {
  return one<Staff>(
    `select user_id as "userId", role, cafe_id as "cafeId", name from staff where user_id = $1`,
    [userId],
  );
}

export async function requireAdmin(req: FastifyRequest): Promise<Staff> {
  const user = await requireUser(req);
  const staff = await getStaff(user.id);
  if (staff?.role !== 'super_admin') throw forbidden('Admin access only');
  return staff;
}

/**
 * Cafe staff act on their own cafe. A super admin can act on any cafe by passing
 * `x-cafe-id` header (used by the admin panel's "open cafe screen").
 */
export async function requireCafe(req: FastifyRequest): Promise<{ staff: Staff; cafeId: string }> {
  const user = await requireUser(req);
  const staff = await getStaff(user.id);
  if (!staff) throw forbidden('Cafe staff only');
  if (staff.role === 'super_admin') {
    const cafeId = req.headers['x-cafe-id'];
    if (typeof cafeId !== 'string' || !/^[0-9a-f-]{36}$/i.test(cafeId)) throw forbidden('Pick a cafe first');
    return { staff, cafeId };
  }
  return { staff, cafeId: staff.cafeId! };
}
