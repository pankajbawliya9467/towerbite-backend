import pg from 'pg';
import { env } from './env.js';

// Supabase requires SSL; local Postgres usually does not.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(env.databaseUrl) || env.databaseUrl.includes('host=/');

// With DATABASE_CA_CERT set (Supabase → Database → SSL Configuration → Download certificate) the server's
// certificate is fully verified. Without it the connection is still encrypted but not verified.
if (!isLocal && !env.databaseCa && env.production) {
  console.warn('DATABASE_CA_CERT is not set: the database connection is encrypted but its certificate is not verified.');
}

export const pool = new pg.Pool({
  // sslmode in the URL would override the settings below, so it is removed.
  connectionString: env.databaseUrl.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
  ssl: isLocal ? undefined : env.databaseCa ? { ca: env.databaseCa, rejectUnauthorized: true } : { rejectUnauthorized: false },
  max: 10,
  // Keep connections open. A new connection to Supabase (TCP + TLS + auth) costs ~1 s, and with the
  // default 10 s idle timeout almost every click on a quiet app was paying it.
  idleTimeoutMillis: 0,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});
// A dropped connection (pooler restart, network blip) must not crash the server; the pool replaces it.
pool.on('error', (e) => console.warn('database connection dropped', e.message));

/**
 * Opens `n` connections now and pings them every minute, so the first order after a quiet spell
 * doesn't wait for new connections (an order uses two: one for reads, one for its transaction).
 */
export function keepWarm(n = 3, everyMs = 60_000) {
  const ping = () => Promise.all(Array.from({ length: n }, () => pool.query('select 1').catch(() => undefined)));
  void ping();
  const t = setInterval(ping, everyMs);
  t.unref();
  return () => clearInterval(t);
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await q<T>(text, params))[0];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}
