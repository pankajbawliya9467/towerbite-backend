import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './env.js';
import { HttpError } from './lib/errors.js';
import { publicRoutes } from './routes/public.js';
import { meRoutes } from './routes/me.js';
import { orderRoutes } from './routes/orders.js';
import { cafeRoutes } from './routes/cafe.js';
import { adminRoutes } from './routes/admin.js';
import { reportRoutes } from './routes/reports.js';
import { lunchRoutes } from './routes/lunch.js';
import { teamRoutes } from './routes/team.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    // Trust only the known proxy hops (TRUST_PROXY), so X-Forwarded-For can't be faked to dodge rate limits.
    trustProxy: env.trustProxy ? (_addr: string, hop: number) => hop < env.trustProxy : false,
    bodyLimit: 100 * 1024,
  });

  // Security headers (API only returns JSON, so the strictest policy is fine).
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  // Per-IP limit for everything; stricter per-user limits on placing orders (see orders.ts).
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  if (env.production && !env.corsOrigins.length) throw new Error('Set CORS_ORIGINS to your website and CRM URLs in production');
  await app.register(cors, {
    // Only our own apps may call the API from a browser. Mobile apps are not affected by CORS.
    origin: env.corsOrigins.length ? env.corsOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-cafe-id'],
  });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) {
      const i = err.issues[0];
      return reply.code(400).send({ error: `${i.path.join('.') || 'input'}: ${i.message}`, issues: err.issues });
    }
    // Postgres errors
    if (err.code === '22P02') return reply.code(404).send({ error: 'Not found' });
    if (err.code === '23505') return reply.code(409).send({ error: 'That already exists (check the slug or name)' });
    if (err.code === '23514') return reply.code(400).send({ error: 'Please check the values (for example, min time must not be more than max time)' });
    if (err.code === '23503') return reply.code(400).send({ error: 'This is linked to other data and cannot be changed that way' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  await app.register(publicRoutes);
  await app.register(meRoutes);
  await app.register(orderRoutes);
  await app.register(cafeRoutes);
  await app.register(adminRoutes);
  await app.register(reportRoutes);
  await app.register(lunchRoutes);
  await app.register(teamRoutes);
  return app;
}
