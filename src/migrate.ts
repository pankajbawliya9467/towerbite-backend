import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';

/**
 * Runs db/001_*.sql, 002_*.sql ... in order when the server starts, so a deploy that adds tables
 * (like 004_lunch_team.sql) works without anyone pasting SQL into Supabase. Every file is safe to re-run.
 * A failure is logged and the server still starts. Set AUTO_MIGRATE=false to turn this off.
 */
export async function runMigrations(log: { info: (m: string) => void; error: (o: unknown, m: string) => void }) {
  if (process.env.AUTO_MIGRATE === 'false') return;
  // src/migrate.ts and dist/migrate.js both sit one folder below backend/, next to db/.
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
  const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const client = await pool.connect();
  try {
    // One transaction, so it also works through Supabase's transaction pooler. The lock makes a second
    // server instance wait instead of running the same files at the same time. A failing file is rolled
    // back on its own (savepoint) and the others still apply.
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('towerbites-migrate'))`);
    for (const file of files) {
      await client.query('savepoint m');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('release savepoint m');
        log.info(`migration ${file} ok`);
      } catch (e) {
        await client.query('rollback to savepoint m');
        log.error(e, `migration ${file} failed (run it in the Supabase SQL editor)`);
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
