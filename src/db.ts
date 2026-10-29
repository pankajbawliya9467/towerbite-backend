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
});

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
