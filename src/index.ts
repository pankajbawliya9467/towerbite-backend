import { buildApp } from './app.js';
import { env } from './env.js';
import { runMigrations } from './migrate.js';

const app = await buildApp();
await runMigrations(app.log).catch((e) => app.log.error(e, 'migrations skipped'));
if (env.devAuth) app.log.warn('DEV_AUTH is ON: "dev:<phone/email>" tokens are accepted. Never use this in production.');
await app.listen({ port: env.port, host: '0.0.0.0' });
