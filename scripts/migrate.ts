/**
 * npm run db:migrate          → creates tables + storage bucket
 * npm run db:seed             → same, plus Spaze Tech Park sample data
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../src/db.js';
import { env, supabaseConfigured } from '../src/env.js';
import { supabase } from '../src/supabase.js';
import { devUserId } from '../src/lib/devId.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db');
const seed = process.argv.includes('--seed');

// Runs db/001_*.sql, 002_*.sql ... in order (all are safe to re-run).
for (const file of readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort()) {
  await pool.query(readFileSync(join(dir, file), 'utf8'));
  console.log(`✓ ${file}`);
}

if (seed) {
  await pool.query(readFileSync(join(dir, 'seed.sql'), 'utf8'));
  console.log('✓ Sample data (Spaze Tech Park + 6 cafes)');
  if (env.devAuth) {
    const cafe = await pool.query(`select id from cafes where slug = 'krunchy-kafe' limit 1`);
    await pool.query(
      `insert into staff (user_id, role, cafe_id, name, email) values
         ($1, 'super_admin', null, 'Admin', 'admin@towerbites.dev'),
         ($2, 'cafe_staff', $3, 'Krunchy Kafe counter', 'cafe@towerbites.dev')
       on conflict (user_id) do nothing`,
      [devUserId('admin@towerbites.dev'), devUserId('cafe@towerbites.dev'), cafe.rows[0]?.id],
    );
    console.log('✓ Dev logins: admin@towerbites.dev (admin), cafe@towerbites.dev (Krunchy Kafe)');
  }
}

if (supabaseConfigured()) {
  const { data } = await supabase().storage.getBucket(env.bucket);
  if (!data) {
    const { error } = await supabase().storage.createBucket(env.bucket, {
      public: true,
      fileSizeLimit: 5 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    });
    console.log(error ? `✗ Bucket: ${error.message}` : `✓ Storage bucket "${env.bucket}" created`);
  } else console.log(`✓ Storage bucket "${env.bucket}" exists`);
}

await pool.end();
