import { buildApp } from './app.js';
import { env } from './env.js';

const app = await buildApp();
if (env.devAuth) app.log.warn('DEV_AUTH is ON: "dev:<phone/email>" tokens are accepted. Never use this in production.');
await app.listen({ port: env.port, host: '0.0.0.0' });
