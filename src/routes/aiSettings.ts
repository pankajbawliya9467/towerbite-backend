import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db.js';
import { requireAdmin } from '../auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { AI_MODELS, AI_STYLES, aiConfig } from '../lib/aiNotify.js';
import { encrypt, setSetting } from '../lib/settings.js';

/**
 * AI settings (super admins only). The OpenAI key is stored encrypted and never sent back: only its last 4
 * characters are shown. Any admin with the Notifications "Send" tick can then press Generate.
 */
async function view() {
  const cfg = await aiConfig();
  const used = (await one<{ n: number }>(
    `select count(*)::int as n from ai_generations where created_at >= ((now() at time zone 'Asia/Kolkata')::date at time zone 'Asia/Kolkata')`,
  ))!.n;
  return {
    configured: !!cfg.apiKey,
    keyEnding: cfg.apiKey ? cfg.apiKey.slice(-4) : null,
    fromServerEnv: cfg.fromEnv,
    model: cfg.model,
    style: cfg.style,
    dailyLimit: cfg.dailyLimit,
    usedToday: used,
    models: AI_MODELS,
  };
}

async function keyWorks(key: string) {
  try {
    const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function aiSettingsRoutes(app: FastifyInstance) {
  const superOnly = async (req: Parameters<typeof requireAdmin>[0]) => {
    const me = await requireAdmin(req);
    if (!me.isSuper) throw forbidden('Only a super admin can change AI settings');
    return me;
  };

  app.get('/v1/admin/settings/ai', async (req) => {
    await requireAdmin(req, 'notifications.send', 'admins.edit');
    return view();
  });

  app.put('/v1/admin/settings/ai', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const me = await superOnly(req);
    const body = z.object({
      apiKey: z.string().trim().min(20).max(300).regex(/^sk-[A-Za-z0-9_\-]+$/, 'That does not look like an OpenAI key (it starts with sk-)').optional(),
      model: z.enum(AI_MODELS).optional(),
      style: z.enum(AI_STYLES).optional(),
      dailyLimit: z.number().int().min(1).max(500).optional(),
    }).parse(req.body);
    if (body.apiKey) {
      if (!(await keyWorks(body.apiKey))) throw badRequest('OpenAI did not accept this key. Check it and your OpenAI billing.');
      await setSetting('openai_key', encrypt(body.apiKey), me.userId);
    }
    if (body.model) await setSetting('ai_model', body.model, me.userId);
    if (body.style) await setSetting('ai_style', body.style, me.userId);
    if (body.dailyLimit) await setSetting('ai_daily_limit', String(body.dailyLimit), me.userId);
    return view();
  });

  app.delete('/v1/admin/settings/ai/key', async (req) => {
    const me = await superOnly(req);
    await setSetting('openai_key', null, me.userId);
    return view();
  });
}
