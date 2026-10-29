import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, q } from '../db.js';
import { getStaff, requireUser } from '../auth.js';
import { PROFILE_COLS } from '../lib/sql.js';

const ProfileInput = z.object({
  name: z.string().trim().max(80).optional(),
  locationId: z.string().uuid().nullable().optional(),
  company: z.string().trim().max(80).optional(),
  tower: z.string().trim().max(40).optional(),
  floor: z.string().trim().max(20).optional(),
  desk: z.string().trim().max(40).optional(),
});

async function loadMe(userId: string) {
  const profile = await one(
    `select ${PROFILE_COLS},
       (select json_build_object('id', l.id, 'slug', l.slug, 'name', l.name, 'area', l.area)
          from locations l where l.id = p.location_id) as location
     from profiles p where p.id = $1`,
    [userId],
  );
  const staff = await getStaff(userId);
  return { ...profile, staff: staff ?? null };
}

export async function meRoutes(app: FastifyInstance) {
  /** Returns the profile, creating it on first login. */
  app.get('/v1/me', async (req) => {
    const user = await requireUser(req);
    await q(
      `insert into profiles (id, phone, email) values ($1, $2, $3)
       on conflict (id) do update set phone = coalesce(excluded.phone, profiles.phone),
         email = coalesce(excluded.email, profiles.email)`,
      [user.id, user.phone, user.email],
    );
    return loadMe(user.id);
  });

  app.put('/v1/me', async (req) => {
    const user = await requireUser(req);
    const body = ProfileInput.parse(req.body);
    await q(`insert into profiles (id, phone, email) values ($1, $2, $3) on conflict (id) do nothing`, [
      user.id,
      user.phone,
      user.email,
    ]);
    const map: Record<string, string> = {
      name: 'name', locationId: 'location_id', company: 'company', tower: 'tower', floor: 'floor', desk: 'desk',
    };
    const sets: string[] = [];
    const params: unknown[] = [user.id];
    for (const [k, col] of Object.entries(map)) {
      const v = (body as Record<string, unknown>)[k];
      if (v !== undefined) {
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (sets.length) await q(`update profiles set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    return loadMe(user.id);
  });

  app.post('/v1/me/push-token', async (req) => {
    const user = await requireUser(req);
    const { token, platform } = z
      .object({ token: z.string().min(10).max(300), platform: z.string().max(20).default('expo') })
      .parse(req.body);
    await q(
      `insert into push_tokens (token, user_id, platform) values ($1, $2, $3)
       on conflict (token) do update set user_id = excluded.user_id`,
      [token, user.id, platform],
    );
    return { ok: true };
  });

  /** Called on sign-out, so this phone stops getting the old user's order notifications. */
  app.delete('/v1/me/push-token', async (req) => {
    const user = await requireUser(req);
    const { token } = z.object({ token: z.string().min(10).max(300) }).parse(req.body);
    await q(`delete from push_tokens where token = $1 and user_id = $2`, [token, user.id]);
    return { ok: true };
  });
}
